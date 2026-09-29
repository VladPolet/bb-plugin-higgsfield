// Turns raw `higgsfield --json` payloads into typed dashboard data. The CLI's
// JSON shapes are not a published contract, so every reader here accepts the
// common field-name variants and degrades to null instead of throwing.
// `bb higgsfield raw <what>` prints the untouched payload for tuning.
import { z } from "zod";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Case- and separator-insensitive key lookup: `created_at` ≡ `createdAt`. */
function field(obj: Obj, keys: readonly string[]): unknown {
  const wanted = new Set(keys.map(canon));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(canon(key)) && value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
}
const canon = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** field(), then the same keys one level down (e.g. `data`, `account`). */
function deepField(obj: Obj, keys: readonly string[]): unknown {
  const direct = field(obj, keys);
  if (direct !== undefined) return direct;
  for (const value of Object.values(obj)) {
    if (isObj(value)) {
      const nested = field(value, keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[, _]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isObj(value)) {
    return num(field(value, ["available", "balance", "amount", "total", "value", "credits"]));
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  if (isObj(value)) return str(field(value, ["name", "title", "plan_name", "plan", "tier", "id", "slug"]));
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs. milliseconds since the epoch.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return isoDate(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

const LIST_KEYS = ["items", "data", "transactions", "results", "jobs", "records", "list", "entries", "generations"];
const CURSOR_KEYS = ["next_cursor", "nextCursor", "cursor", "next", "next_page_token", "nextPageToken"];

export function unwrapList(data: unknown): { items: Obj[]; next: string | null } {
  if (Array.isArray(data)) return { items: data.filter(isObj), next: null };
  if (!isObj(data)) return { items: [], next: null };
  let list = field(data, LIST_KEYS);
  if (isObj(list)) {
    // e.g. { data: { items: [...], next_cursor } }
    return unwrapList(list);
  }
  if (!Array.isArray(list)) {
    list = Object.values(data).find(
      (value) => Array.isArray(value) && value.some(isObj),
    );
  }
  const items = Array.isArray(list) ? list.filter(isObj) : [];
  let next = str(field(data, CURSOR_KEYS));
  const pageInfo = field(data, ["page_info", "pageInfo", "pagination", "meta"]);
  if (next === null && isObj(pageInfo)) next = str(field(pageInfo, CURSOR_KEYS));
  if (next !== null && /^https?:/.test(next)) {
    next = new URL(next).searchParams.get("cursor") ?? next;
  }
  const hasMore = field(data, ["has_more", "hasMore", "has_next"]);
  if (hasMore === false) next = null;
  return { items, next };
}

export const accountSchema = z.object({
  email: z.string().nullable(),
  plan: z.string().nullable(),
  credits: z.number().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

export function normalizeAccount(data: unknown): Account {
  const obj = isObj(data) ? data : {};
  const planValue = deepField(obj, ["plan", "plan_name", "subscription_plan_type", "plan_type", "subscription_plan", "tier", "subscription"]);
  return {
    email: str(deepField(obj, ["email", "user_email", "login"])),
    plan: str(planValue),
    credits: num(
      deepField(obj, [
        "credits",
        "available_credits",
        "credits_available",
        "credit_balance",
        "balance",
        "credits_balance",
        "wallet",
      ]),
    ),
  };
}

// ------------------------------------------------------------ transactions

export const mediaSchema = z.enum(["image", "video", "audio", "text"]);
export type Media = z.infer<typeof mediaSchema>;

export const categorySchema = z.enum([
  "spend", // a generation charged credits
  "refund", // a failed generation gave them back
  "subscription", // monthly plan grant
  "package", // purchased credit package or other grant
  "expiry", // unused subscription credits removed at renewal
]);
export type Category = z.infer<typeof categorySchema>;

export const transactionSchema = z.object({
  id: z.string(),
  at: z.string().nullable(),
  /** Negative = credits left the balance, positive = credits added. */
  amount: z.number(),
  label: z.string(),
  kind: z.string().nullable(),
  category: categorySchema,
  media: mediaSchema.nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;

const INCOME = /refund|top.?up|purchase|grant|bonus|deposit|renew|reward|gift|promo|credit(ed)?$|added|subscription|allocation/i;
const SPEND = /spend|debit|charge|generat|usage|consum|job|deduct|withdraw|use/i;
const EXPIRY = /reset|expir|forfeit|lapse/i;
const SUBSCRIPTION = /subscription|plan|monthly|renew/i;

function categorize(amount: number, kind: string | null, label: string): Category {
  const hint = `${kind ?? ""} ${label}`;
  if (amount < 0) return EXPIRY.test(hint) ? "expiry" : "spend";
  if (/refund/i.test(hint)) return "refund";
  return SUBSCRIPTION.test(label) ? "subscription" : "package";
}

export function normalizeTransactions(rows: Obj[]): Transaction[] {
  const raw = rows.map((row, index) => {
    const kind = str(field(row, ["action", "type", "kind", "transaction_type", "direction", "operation", "category"]));
    const amount = num(field(row, ["amount", "credits", "delta", "value", "credit_amount", "change", "cost"])) ?? 0;
    const label =
      str(field(row, ["display_name", "model", "model_name", "application", "app", "tool", "feature", "description", "reason", "title", "source", "job_type"])) ??
      kind ??
      "Other";
    return {
      id: str(field(row, ["id", "uuid", "transaction_id"])) ?? `row-${index}`,
      at: isoDate(field(row, ["created_at", "createdAt", "timestamp", "date", "time", "occurred_at", "updated_at"])),
      amount,
      label,
      kind,
    };
  });
  // When the API signs amounts, trust the sign. Otherwise infer the direction
  // from the transaction type and default to spend.
  const signed = raw.some((row) => row.amount < 0);
  return raw.map((row) => {
    let amount = row.amount;
    if (!signed && amount !== 0) {
      const hint = `${row.kind ?? ""} ${row.label}`;
      const income = INCOME.test(hint) && !SPEND.test(row.kind ?? "") && !EXPIRY.test(hint);
      amount = income ? amount : -amount;
    }
    return {
      ...row,
      amount,
      category: categorize(amount, row.kind, row.label),
      media: null,
    };
  });
}

// ------------------------------------------------------------- model catalog

/** `GPT Image 2.0` ≡ `GPT Image 2` ≡ `gpt_image_2`. */
export function modelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/(\d)\.0\b/g, "$1")
    .replace(/[^a-z0-9]/g, "");
}

/** modelKey(display name or job_type) → media type. */
export type ModelCatalog = Record<string, Media>;

export function buildCatalog(lists: Partial<Record<Media, unknown>>): ModelCatalog {
  const catalog: ModelCatalog = {};
  for (const media of mediaSchema.options) {
    for (const row of unwrapList(lists[media]).items) {
      const type = mediaSchema.safeParse(str(field(row, ["type", "media_type"])));
      const resolved = type.success ? type.data : media;
      for (const name of [field(row, ["display_name", "name"]), field(row, ["job_type", "id"])]) {
        const text = str(name);
        if (text !== null) catalog[modelKey(text)] ??= resolved;
      }
    }
  }
  return catalog;
}

const VIDEO_HINT = /video|seedance|veo|kling|sora|wan\b|clip|motion|fps|lipsync|talking|animate|cinematic/i;
const IMAGE_HINT = /image|banana|seedream|flux|upscale|enhancer|soul|photo|gpt|imagen|ideogram|recraft|reframe/i;
const AUDIO_HINT = /audio|music|voice|speech|sound|tts/i;

export function mediaFor(label: string, catalog: ModelCatalog): Media | null {
  const key = modelKey(label);
  const exact = catalog[key];
  if (exact !== undefined) return exact;
  // "Seedance 2.5" when the catalog lists "Seedance 2.5 Pro", and vice versa.
  for (const [name, media] of Object.entries(catalog)) {
    if (name.length >= 5 && (name.startsWith(key) || key.startsWith(name))) return media;
  }
  if (AUDIO_HINT.test(label)) return "audio";
  if (VIDEO_HINT.test(label)) return "video";
  if (IMAGE_HINT.test(label)) return "image";
  return null;
}

export function withMedia(transactions: Transaction[], catalog: ModelCatalog): Transaction[] {
  return transactions.map((tx) =>
    tx.category === "spend" || tx.category === "refund"
      ? { ...tx, media: mediaFor(tx.label, catalog) }
      : tx,
  );
}

// -------------------------------------------------------------------- jobs

export const jobSchema = z.object({
  id: z.string(),
  at: z.string().nullable(),
  model: z.string(),
  status: z.string(),
  kind: z.string().nullable(),
  media: mediaSchema.nullable(),
  cost: z.number().nullable(),
  prompt: z.string().nullable(),
  resultUrl: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export function normalizeJobs(rows: Obj[], catalog: ModelCatalog = {}): Job[] {
  return rows.map((row, index) => {
    const prompt = str(deepField(row, ["prompt", "text", "input_text"]));
    const model = str(field(row, ["display_name", "model", "model_name", "application", "workflow", "endpoint", "job_type"])) ?? "unknown";
    const jobType = str(field(row, ["job_type"]));
    return {
      id: str(field(row, ["id", "job_id", "uuid"])) ?? `job-${index}`,
      at: isoDate(field(row, ["created_at", "createdAt", "timestamp", "submitted_at", "date"])),
      model,
      status: str(field(row, ["status", "state"])) ?? "unknown",
      kind: str(field(row, ["type", "kind", "media_type", "job_type", "output_type"])),
      media: (jobType === null ? undefined : catalog[modelKey(jobType)]) ?? mediaFor(model, catalog),
      cost: num(field(row, ["cost", "credits", "credits_used", "price", "amount"])),
      prompt: prompt === null ? null : prompt.slice(0, 200),
      resultUrl: httpUrl(field(row, ["result_url", "url", "output_url"])),
    };
  });
}

/** The selected workspace's display name; null for an unnamed (personal) one. */
export function normalizeWorkspace(data: unknown): string | null {
  if (!isObj(data)) return null;
  return str(deepField(data, ["name", "workspace_name", "title"]));
}

function httpUrl(value: unknown): string | null {
  const text = str(value);
  return text !== null && /^https:\/\//.test(text) ? text : null;
}

// ------------------------------------------------------------ color slots

/** Series slots 0–6 are colored; everything else folds into "Other". */
export const SERIES_SLOTS = 7;

/**
 * Sticky color assignment: a model keeps its slot while it stays among the
 * top spenders, so a refresh or a range filter never repaints survivors.
 */
export function assignSlots(
  previous: Record<string, number>,
  ranked: readonly string[],
  slots = SERIES_SLOTS,
): Record<string, number> {
  const top = ranked.slice(0, slots);
  const next: Record<string, number> = {};
  const used = new Set<number>();
  for (const label of top) {
    const slot = previous[label];
    if (slot !== undefined && slot >= 0 && slot < slots && !used.has(slot)) {
      next[label] = slot;
      used.add(slot);
    }
  }
  let free = 0;
  for (const label of top) {
    if (next[label] !== undefined) continue;
    while (used.has(free)) free += 1;
    next[label] = free;
    used.add(free);
  }
  return next;
}

/** Labels ranked by net credits spent (spend minus refunds). */
export function rankModels(transactions: readonly Transaction[]): string[] {
  const totals = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.category !== "spend" && tx.category !== "refund") continue;
    totals.set(tx.label, (totals.get(tx.label) ?? 0) - tx.amount);
  }
  return [...totals.entries()]
    .filter(([, spent]) => spent > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}

// ------------------------------------------------------------------ cycle

export const cycleSchema = z.object({
  /** Last monthly subscription grant: the current cycle's start. */
  startedAt: z.string(),
  /** Estimated next renewal: start + the observed interval (≈ 1 month). */
  nextResetAt: z.string(),
  daysToReset: z.number(),
  daysElapsed: z.number(),
  cycleDays: z.number(),
  /** Credits the last grant added; the next one is assumed equal. */
  grantAmount: z.number(),
  /** Net credits spent since the cycle started. */
  spentThisCycle: z.number(),
  previous: z.array(
    z.object({
      startedAt: z.string(),
      granted: z.number(),
      /** Unused credits removed when that cycle ended (null = still open). */
      expired: z.number().nullable(),
    }),
  ),
});
export type Cycle = z.infer<typeof cycleSchema>;

const DAY_MS = 86_400_000;

export function detectCycle(transactions: readonly Transaction[], now = new Date()): Cycle | null {
  const grants = transactions
    .filter((tx) => tx.category === "subscription" && tx.at !== null)
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const last = grants.at(-1);
  if (last?.at == null) return null;
  const start = new Date(last.at);
  // Plans renew monthly; fall back to a calendar month when there is only
  // one grant or the observed gaps look irregular.
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  while (next.getTime() <= now.getTime()) next.setMonth(next.getMonth() + 1);
  const expiries = transactions.filter((tx) => tx.category === "expiry" && tx.at !== null);
  const previous = grants.map((grant, index) => {
    const from = Date.parse(grant.at ?? "");
    const nextGrant = grants[index + 1];
    const to = nextGrant?.at == null ? null : Date.parse(nextGrant.at);
    // The reset row lands seconds before the next grant.
    const expired =
      to === null
        ? null
        : expiries
            .filter((tx) => Math.abs(Date.parse(tx.at ?? "") - to) < DAY_MS)
            .reduce((sum, tx) => sum - tx.amount, 0);
    return { startedAt: grant.at ?? "", granted: grant.amount, expired: expired === null ? null : round(expired) };
  });
  let spent = 0;
  for (const tx of transactions) {
    if (tx.at === null || Date.parse(tx.at) < start.getTime()) continue;
    if (tx.category === "spend" || tx.category === "refund") spent -= tx.amount;
  }
  return {
    startedAt: start.toISOString(),
    nextResetAt: next.toISOString(),
    daysToReset: Math.max(0, (next.getTime() - now.getTime()) / DAY_MS),
    daysElapsed: Math.max(0, (now.getTime() - start.getTime()) / DAY_MS),
    cycleDays: (next.getTime() - start.getTime()) / DAY_MS,
    grantAmount: last.amount,
    spentThisCycle: round(spent),
    previous: previous.reverse(),
  };
}

// ---------------------------------------------------------------- summary

export const modelStatSchema = z.object({
  label: z.string(),
  media: mediaSchema.nullable(),
  /** Charged generations (one spend row each). */
  generations: z.number(),
  /** Failed generations whose credits were refunded. */
  refunds: z.number(),
  /** Net credits: spent minus refunded. */
  spent: z.number(),
  avgPerGeneration: z.number(),
  lastAt: z.string().nullable(),
});
export type ModelStat = z.infer<typeof modelStatSchema>;

export type DailyPoint = {
  date: string;
  spent: number;
  byLabel: Record<string, number>;
  byMedia: Record<string, number>;
};

export type Summary = {
  from: Date;
  to: Date;
  days: number;
  spent: number;
  generations: number;
  refunds: number;
  granted: number;
  expired: number;
  avgPerDay: number;
  models: ModelStat[];
  daily: DailyPoint[];
};

export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Everything the dashboard shows for one time range. Pure; runs in both server and app. */
export function summarize(
  transactions: readonly Transaction[],
  from: Date,
  to: Date = new Date(),
): Summary {
  const daily = new Map<string, DailyPoint>();
  for (let day = startOfDay(from); day <= to; day.setDate(day.getDate() + 1)) {
    const key = localDateKey(day);
    daily.set(key, { date: key, spent: 0, byLabel: {}, byMedia: {} });
  }
  const models = new Map<string, ModelStat>();
  let spent = 0;
  let generations = 0;
  let refunds = 0;
  let granted = 0;
  let expired = 0;
  for (const tx of transactions) {
    if (tx.at === null) continue;
    const at = new Date(tx.at);
    if (at < from || at > to) continue;
    if (tx.category === "subscription" || tx.category === "package") {
      granted += tx.amount;
      continue;
    }
    if (tx.category === "expiry") {
      expired -= tx.amount;
      continue;
    }
    // spend (negative) and refund (positive) both net into model spend.
    const delta = -tx.amount;
    spent += delta;
    const stat = models.get(tx.label) ?? {
      label: tx.label,
      media: tx.media,
      generations: 0,
      refunds: 0,
      spent: 0,
      avgPerGeneration: 0,
      lastAt: null,
    };
    stat.spent += delta;
    if (tx.category === "spend") {
      stat.generations += 1;
      generations += 1;
      if (stat.lastAt === null || tx.at > stat.lastAt) stat.lastAt = tx.at;
    } else {
      stat.refunds += 1;
      refunds += 1;
    }
    models.set(tx.label, stat);
    const point = daily.get(localDateKey(at));
    if (point !== undefined) {
      point.spent += delta;
      point.byLabel[tx.label] = (point.byLabel[tx.label] ?? 0) + delta;
      const media = tx.media ?? "unknown";
      point.byMedia[media] = (point.byMedia[media] ?? 0) + delta;
    }
  }
  const days = Math.max(1, (to.getTime() - from.getTime()) / DAY_MS);
  return {
    from,
    to,
    days,
    spent: round(spent),
    generations,
    refunds,
    granted: round(granted),
    expired: round(expired),
    avgPerDay: round(spent / days),
    models: [...models.values()]
      .map((stat) => {
        // Charged generations minus refunded ones is what actually succeeded.
        const successful = Math.max(1, stat.generations - stat.refunds);
        return {
          ...stat,
          spent: round(stat.spent),
          avgPerGeneration: round(stat.spent / successful),
        };
      })
      .sort((a, b) => b.spent - a.spent || b.generations - a.generations),
    daily: [...daily.values()],
  };
}

// ----------------------------------------------------------------- balance

export type BalancePoint = { date: string; credits: number };

/**
 * Closing balance per local day, rebuilt backwards from the current balance:
 * before each transaction the balance was (after − amount). Accurate as long
 * as the loaded history covers the range.
 */
export function dailyBalance(
  transactions: readonly Transaction[],
  credits: number,
  from: Date,
  to: Date = new Date(),
): BalancePoint[] {
  const desc = transactions
    .filter((tx) => tx.at !== null)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const points: BalancePoint[] = [];
  let balance = credits;
  let index = 0;
  for (let day = startOfDay(to); day >= startOfDay(from); day.setDate(day.getDate() - 1)) {
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    // Undo every transaction after this day's end.
    while (index < desc.length && Date.parse(desc[index]?.at ?? "") >= end.getTime()) {
      balance -= desc[index]?.amount ?? 0;
      index += 1;
    }
    points.push({ date: localDateKey(day), credits: round(Math.max(0, balance)) });
  }
  return points.reverse();
}

// ---------------------------------------------------------------- forecast

export const forecastSchema = z.object({
  /** Net credits/day over the last 7 days. */
  burn7d: z.number(),
  /** Net credits/day since the cycle started (or over 30 days without a cycle). */
  burnCycle: z.number(),
  /** Days until the balance hits zero at burnCycle; null when not burning. */
  runwayDays: z.number().nullable(),
  runsOutAt: z.string().nullable(),
  /** Credits left at the reset at burnCycle; null without a cycle. */
  leftAtReset: z.number().nullable(),
  /** Credits/day needed to use the whole balance before the reset. */
  paceToUseAll: z.number().nullable(),
  verdict: z.enum(["runs-out", "on-track", "will-expire", "idle", "unknown"]),
});
export type Forecast = z.infer<typeof forecastSchema>;

export function forecast(args: {
  transactions: readonly Transaction[];
  credits: number | null;
  cycle: Cycle | null;
  now?: Date;
}): Forecast {
  const now = args.now ?? new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const burn7d = summarize(args.transactions, weekAgo, now).spent / 7;
  const cycleDays = args.cycle === null ? 30 : Math.max(1, args.cycle.daysElapsed);
  const cycleFrom =
    args.cycle === null ? new Date(now.getTime() - 30 * DAY_MS) : new Date(args.cycle.startedAt);
  const burnCycle = summarize(args.transactions, cycleFrom, now).spent / cycleDays;
  const credits = args.credits;
  const runwayDays = credits !== null && burnCycle > 0 ? credits / burnCycle : null;
  const daysToReset = args.cycle?.daysToReset ?? null;
  const leftAtReset =
    credits === null || daysToReset === null
      ? null
      : Math.max(0, credits - burnCycle * daysToReset);
  let verdict: Forecast["verdict"] = "unknown";
  if (credits !== null) {
    if (burnCycle <= 0) verdict = "idle";
    else if (daysToReset === null) verdict = "unknown";
    else if (runwayDays !== null && runwayDays < daysToReset) verdict = "runs-out";
    else if (leftAtReset !== null && leftAtReset > credits * 0.1) verdict = "will-expire";
    else verdict = "on-track";
  }
  return {
    burn7d: round(burn7d),
    burnCycle: round(burnCycle),
    runwayDays: runwayDays === null ? null : Math.floor(runwayDays),
    runsOutAt:
      runwayDays === null ? null : new Date(now.getTime() + runwayDays * DAY_MS).toISOString(),
    leftAtReset: leftAtReset === null ? null : round(leftAtReset),
    paceToUseAll:
      credits === null || daysToReset === null || daysToReset < 0.5
        ? null
        : round(credits / daysToReset),
    verdict,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
