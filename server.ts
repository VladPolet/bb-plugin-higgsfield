// bb-plugin-higgsfield — credits balance and consumption dashboard.
//
// Auth is delegated to the Higgsfield CLI (`higgsfield auth login`, OAuth 2.0
// PKCE in the browser — pick "Continue with Google" there). The host worker
// (host.ts) runs the CLI on the user's machine; this server entry turns its
// JSON into one dashboard payload shared by the sidebar page (app.tsx), the
// `bb higgsfield` CLI, and agents (skills/higgsfield-usage). Range-dependent
// numbers are computed with `summarize()` from normalize.ts on both sides.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals, type CliResult } from "./contract.js";
import {
  accountSchema,
  assignSlots,
  buildCatalog,
  cycleSchema,
  detectCycle,
  forecast,
  forecastSchema,
  jobSchema,
  mediaSchema,
  normalizeAccount,
  normalizeJobs,
  normalizeTransactions,
  normalizeWorkspace,
  rankModels,
  summarize,
  transactionSchema,
  unwrapList,
  withMedia,
  type Media,
  type ModelCatalog,
  type Transaction,
} from "./normalize.js";

const dashboardSchema = z.object({
  state: z.enum(["ready", "signed-out", "missing-cli", "error"]),
  message: z.string().nullable(),
  fetchedAt: z.string(),
  account: accountSchema.nullable(),
  workspace: z.string().nullable(),
  /** Every loaded transaction, newest first. */
  transactions: z.array(transactionSchema),
  /** True when older history exists beyond the loaded pages. */
  truncated: z.boolean(),
  /** Sticky model → color slot (0–6); unlisted models render as "Other". */
  slots: z.record(z.string(), z.number()),
  cycle: cycleSchema.nullable(),
  forecast: forecastSchema,
  jobs: z.array(jobSchema),
  jobStatus: z.array(z.object({ status: z.string(), count: z.number() })),
  warnings: z.array(z.string()),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

const rawTargets = ["status", "transactions", "jobs", "workspace", "models"] as const;
type RawTarget = (typeof rawTargets)[number];
const isRawTarget = (value: string | undefined): value is RawTarget =>
  rawTargets.includes(value as RawTarget);

export const rpcContract = defineRpcContract({
  dashboard: {
    input: z.object({ force: z.boolean().optional() }).nullable(),
    output: dashboardSchema,
  },
  login: {
    input: z.null(),
    output: z.object({
      started: z.boolean(),
      url: z.string().nullable(),
      message: z.string(),
    }),
  },
  logout: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

/** Realtime channel app.tsx refetches on. */
const CHANGED = "higgsfield-changed";
const SLOTS_KEY = "color-slots";
const CATALOG_KEY = "model-catalog";
const CACHE_MS = 60_000;
const CATALOG_TTL_MS = 12 * 60 * 60_000;
const PAGE_SIZE = 100;
/** Enough history for the current cycle plus two previous ones. */
const HISTORY_DAYS = 95;
const DAY_MS = 86_400_000;

const emptyForecast = forecast({ transactions: [], credits: null, cycle: null });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cliPath: {
      type: "string",
      label: "Higgsfield CLI path",
      description:
        "Command or absolute path of the Higgsfield CLI. It owns login (`higgsfield auth login`).",
      default: "higgsfield",
    },
    maxPages: {
      type: "number",
      label: "Max transaction pages",
      description: `Upper bound on 100-row transaction pages fetched per refresh (history goes back up to ${HISTORY_DAYS} days).`,
      default: 10,
      experimental_schema: z.number().int().min(1).max(50),
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
    cache = null;
    bb.realtime.publish(CHANGED, { reason: "settings" });
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  host.experimental_onSignal("authChanged", ({ payload }) => {
    bb.log.info(`auth changed: ${payload.message}`);
    cache = null;
    bb.realtime.publish(CHANGED, { reason: "auth" });
  });

  async function hostId(): Promise<string> {
    const config = await bb.sdk.system.config();
    if (config.primaryHostId === null) {
      throw new Error("This BB server has no local host to run the Higgsfield CLI on.");
    }
    return config.primaryHostId;
  }

  const storedCatalogSchema = z.object({
    at: z.number(),
    catalog: z.record(z.string(), mediaSchema),
  });
  /** Model name → media type from `higgsfield model list`, cached for 12h. */
  async function modelCatalog(id: string): Promise<ModelCatalog> {
    const stored = storedCatalogSchema.safeParse(await bb.storage.kv.get<unknown>(CATALOG_KEY));
    if (stored.success && Date.now() - stored.data.at < CATALOG_TTL_MS) {
      return stored.data.catalog;
    }
    const results = await Promise.all(
      mediaSchema.options.map(async (kind) => {
        const result = await host.call("models", { binary: current.cliPath, kind }, { hostId: id });
        return [kind, result.ok ? result.data : null] as const;
      }),
    );
    const catalog = buildCatalog(Object.fromEntries(results) as Partial<Record<Media, unknown>>);
    if (Object.keys(catalog).length > 0) {
      await bb.storage.kv.set(CATALOG_KEY, { at: Date.now(), catalog });
      return catalog;
    }
    return stored.success ? stored.data.catalog : {};
  }

  /**
   * Models in the current cycle claim colors first (the default view), then
   * the rest of the last 90 days, so a small current cycle is never grey.
   */
  async function colorSlots(
    transactions: Transaction[],
    cycleStart: string | null,
  ): Promise<Record<string, number>> {
    const stored = z
      .record(z.string(), z.number())
      .safeParse(await bb.storage.kv.get<unknown>(SLOTS_KEY));
    const since = (iso: string) => transactions.filter((tx) => tx.at !== null && tx.at >= iso);
    const recent = cycleStart ?? new Date(Date.now() - 30 * DAY_MS).toISOString();
    const ranked = [
      ...new Set([
        ...rankModels(since(recent)),
        ...rankModels(since(new Date(Date.now() - 90 * DAY_MS).toISOString())),
      ]),
    ];
    const next = assignSlots(stored.success ? stored.data : {}, ranked);
    await bb.storage.kv.set(SLOTS_KEY, next);
    return next;
  }

  async function fetchTransactions(
    id: string,
    since: Date,
  ): Promise<{ result: CliResult | null; transactions: Transaction[]; truncated: boolean }> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < current.maxPages; page += 1) {
      const result = await host.call(
        "transactions",
        { binary: current.cliPath, size: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        { hostId: id },
      );
      if (!result.ok) return { result, transactions: normalizeTransactions(rows), truncated: false };
      const { items, next } = unwrapList(result.data);
      rows.push(...items);
      const oldest = normalizeTransactions(items)
        .map((tx) => tx.at)
        .filter((at): at is string => at !== null)
        .sort()[0];
      const reachedSince = oldest !== undefined && new Date(oldest) < since;
      if (next === null || items.length === 0 || reachedSince) {
        return { result: null, transactions: normalizeTransactions(rows), truncated: false };
      }
      cursor = next;
    }
    return { result: null, transactions: normalizeTransactions(rows), truncated: true };
  }

  function failureState(result: Extract<CliResult, { ok: false }>): Dashboard["state"] {
    if (result.reason === "auth") return "signed-out";
    if (result.reason === "missing-cli") return "missing-cli";
    return "error";
  }

  function emptyDashboard(): Dashboard {
    return {
      state: "ready",
      message: null,
      fetchedAt: new Date().toISOString(),
      account: null,
      workspace: null,
      transactions: [],
      truncated: false,
      slots: {},
      cycle: null,
      forecast: emptyForecast,
      jobs: [],
      jobStatus: [],
      warnings: [],
    };
  }

  let cache: { at: number; value: Dashboard } | null = null;
  let inflight: Promise<Dashboard> | null = null;

  async function buildDashboard(): Promise<Dashboard> {
    const id = await hostId();
    const empty = emptyDashboard();
    const status = await host.call("accountStatus", { binary: current.cliPath }, { hostId: id });
    if (!status.ok) {
      return { ...empty, state: failureState(status), message: status.message };
    }
    const account = normalizeAccount(status.data);
    const warnings: string[] = [];
    if (account.credits === null) {
      warnings.push("Could not find a credit balance in `higgsfield account status`. Run `bb higgsfield raw status` to inspect it.");
    }

    const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
    const [tx, jobsResult, workspaceResult, catalog] = await Promise.all([
      fetchTransactions(id, since),
      host.call("jobs", { binary: current.cliPath, size: 50 }, { hostId: id }),
      host.call("workspaceStatus", { binary: current.cliPath }, { hostId: id }),
      modelCatalog(id),
    ]);
    if (tx.result !== null && !tx.result.ok) {
      warnings.push(`Transactions: ${tx.result.message}`);
    }
    const transactions = withMedia(tx.transactions, catalog).sort((a, b) =>
      (b.at ?? "").localeCompare(a.at ?? ""),
    );
    const jobs = jobsResult.ok ? normalizeJobs(unwrapList(jobsResult.data).items, catalog) : [];
    if (!jobsResult.ok) warnings.push(`Jobs: ${jobsResult.message}`);
    const statusCounts = new Map<string, number>();
    for (const job of jobs) {
      statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1);
    }
    const cycle = detectCycle(transactions);
    return {
      ...empty,
      account,
      workspace: workspaceResult.ok ? normalizeWorkspace(workspaceResult.data) : null,
      transactions,
      truncated: tx.truncated,
      slots: await colorSlots(transactions, cycle?.startedAt ?? null),
      cycle,
      forecast: forecast({ transactions, credits: account.credits, cycle }),
      jobs: jobs.slice(0, 25),
      jobStatus: [...statusCounts.entries()]
        .map(([jobStatus, count]) => ({ status: jobStatus, count }))
        .sort((a, b) => b.count - a.count),
      warnings,
    };
  }

  async function dashboard(force = false): Promise<Dashboard> {
    if (!force && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.value;
    inflight ??= buildDashboard()
      .catch(
        (cause: unknown): Dashboard => ({
          ...emptyDashboard(),
          state: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .then((value) => {
        if (value.state !== "error") cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function login() {
    // The login call waits up to a few seconds for the CLI to print its URL.
    return host.call("login", { binary: current.cliPath }, { hostId: await hostId(), timeoutMs: 60_000 });
  }
  async function logout() {
    const result = await host.call("logout", { binary: current.cliPath }, { hostId: await hostId() });
    cache = null;
    bb.realtime.publish(CHANGED, { reason: "auth" });
    return result.ok
      ? { ok: true, message: "Signed out of Higgsfield." }
      : { ok: false, message: result.message };
  }

  bb.rpc.register(rpcContract, {
    dashboard: (input) => dashboard(input?.force === true),
    login: () => login(),
    logout: () => logout(),
  });

  async function raw(target: RawTarget, extra?: string): Promise<CliResult> {
    const id = await hostId();
    const binary = current.cliPath;
    switch (target) {
      case "status":
        return host.call("accountStatus", { binary }, { hostId: id });
      case "transactions":
        // `raw transactions <cursor>` pages through full 100-row pages.
        return host.call(
          "transactions",
          { binary, size: extra === undefined ? 5 : 100, ...(extra === undefined ? {} : { cursor: extra }) },
          { hostId: id },
        );
      case "jobs":
        return host.call("jobs", { binary, size: 5 }, { hostId: id });
      case "workspace":
        return host.call("workspaceStatus", { binary }, { hostId: id });
      case "models": {
        const kind = mediaSchema.safeParse(extra ?? "image");
        if (!kind.success) {
          return { ok: false, reason: "failed", message: "Use: raw models <image|video|audio|text>" };
        }
        return host.call("models", { binary, kind: kind.data }, { hostId: id });
      }
    }
  }

  registerCli(bb, { dashboard, login, logout, raw });
}

// ---------------------------------------------------------------------- CLI

type CliDeps = {
  dashboard: (force?: boolean) => Promise<Dashboard>;
  login: () => Promise<{ started: boolean; url: string | null; message: string }>;
  logout: () => Promise<{ ok: boolean; message: string }>;
  raw: (target: RawTarget, extra?: string) => Promise<CliResult>;
};

const fmt = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const day = (iso: string) => iso.slice(0, 10);

function rangeFrom(range: string, d: Dashboard): Date | null {
  const now = Date.now();
  if (range === "cycle") return d.cycle === null ? new Date(now - 30 * DAY_MS) : new Date(d.cycle.startedAt);
  const match = /^(\d{1,3})d$/.exec(range);
  return match === null ? null : new Date(now - Number(match[1]) * DAY_MS);
}

function notReadyText(d: Dashboard): string {
  const hint =
    d.state === "signed-out"
      ? "\nRun `bb higgsfield login` (or `higgsfield auth login`) to sign in."
      : "";
  return `Higgsfield: ${d.state}${d.message === null ? "" : ` — ${d.message}`}${hint}`;
}

function dashboardText(d: Dashboard): string {
  if (d.state !== "ready") return notReadyText(d);
  const f = d.forecast;
  const c = d.cycle;
  const lines = [
    `Account:   ${d.account?.email ?? "—"}  (plan: ${d.account?.plan ?? "—"})`,
    ...(d.workspace === null ? [] : [`Workspace: ${d.workspace}`]),
    `Credits:   ${fmt(d.account?.credits)}`,
  ];
  if (c !== null) {
    lines.push(
      `Reset:     ${day(c.nextResetAt)} (in ${fmt(Math.ceil(c.daysToReset))} days) · +${fmt(c.grantAmount)} subscription credits`,
      `Cycle:     started ${day(c.startedAt)} · spent ${fmt(c.spentThisCycle)}`,
    );
    const last = c.previous.find((cycle) => cycle.expired !== null);
    if (last !== undefined) {
      lines.push(`Last cycle: ${fmt(last.expired)} of ${fmt(last.granted)} expired unused`);
    }
  }
  lines.push(
    `Burn:      ${fmt(f.burnCycle)}/day this cycle · ${fmt(f.burn7d)}/day last 7d` +
      (f.runwayDays === null ? "" : ` · balance lasts ~${f.runwayDays} days`),
  );
  const verdict: Record<typeof f.verdict, string> = {
    "runs-out": `Forecast:  runs out ${f.runsOutAt === null ? "" : day(f.runsOutAt)}, before the reset`,
    "will-expire": `Forecast:  ~${fmt(f.leftAtReset)} left at reset; use ${fmt(f.paceToUseAll)}/day to spend it all`,
    "on-track": "Forecast:  on track to use the balance by the reset",
    idle: "Forecast:  no spending yet this cycle",
    unknown: "Forecast:  no subscription renewal found in history",
  };
  lines.push(verdict[f.verdict]);
  const from = rangeFrom("cycle", d) ?? new Date();
  const s = summarize(d.transactions, from);
  if (s.models.length > 0) {
    lines.push("", `By model (this cycle): ${s.generations} generations, ${s.refunds} refunded`);
    for (const m of s.models.slice(0, 10)) {
      lines.push(
        `  ${fmt(m.spent).padStart(9)} cr  ${String(m.generations).padStart(4)} gen  ${fmt(m.avgPerGeneration).padStart(6)}/gen  ${m.label}${m.media === null ? "" : ` [${m.media}]`}`,
      );
    }
  }
  if (d.truncated) lines.push("", "Note: history truncated by the max-pages setting.");
  for (const warning of d.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

function truncate(text: string, max = 60_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function registerCli(bb: BbPluginApi, deps: CliDeps) {
  const usage = [
    "Usage:",
    "  bb higgsfield status [--refresh] [--json]   Balance, reset, burn, forecast, per-model summary",
    "  bb higgsfield models [--range cycle|7d|30d|90d] [--json]   Generations and credits per model",
    "  bb higgsfield transactions [--limit N] [--json]",
    "  bb higgsfield jobs [--limit N] [--json]",
    "  bb higgsfield login                          Start browser sign-in (Google works)",
    "  bb higgsfield logout",
    "  bb higgsfield raw <status|transactions [cursor]|jobs|workspace|models [kind]>",
  ].join("\n");

  bb.cli.register({
    name: "higgsfield",
    summary: "Higgsfield credits, consumption, and sign-in",
    commands: [
      { name: "status", summary: "Credits, next reset, burn rate, forecast", usage: "bb higgsfield status [--refresh] [--json]" },
      { name: "models", summary: "Generations and credits per model", usage: "bb higgsfield models [--range cycle|7d|30d|90d] [--json]" },
      { name: "transactions", summary: "List recent credit transactions", usage: "bb higgsfield transactions [--limit N] [--json]" },
      { name: "jobs", summary: "List recent generation jobs", usage: "bb higgsfield jobs [--limit N] [--json]" },
      { name: "login", summary: "Sign in through the browser", usage: "bb higgsfield login" },
      { name: "logout", summary: "Sign out", usage: "bb higgsfield logout" },
      { name: "raw", summary: "Print raw CLI JSON for debugging", usage: "bb higgsfield raw <status|transactions|jobs|workspace|models>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const rest = argv.filter((arg) => arg !== "--json" && arg !== "--refresh");
      const [command, ...args] = rest;
      const option = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
      };
      const limit = Number(option("--limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return { exitCode: 1, stderr: "--limit must be an integer from 1 to 500." };
      }
      const out = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: truncate(json ? JSON.stringify(value) : text),
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const d = await deps.dashboard(refresh);
          const { transactions: _t, jobs: _j, slots: _s, ...summary } = d;
          const cycleModels =
            d.state === "ready" ? summarize(d.transactions, rangeFrom("cycle", d) ?? new Date()).models : [];
          return {
            ...out({ ...summary, cycleModels }, dashboardText(d)),
            exitCode: d.state === "ready" ? 0 : 1,
          };
        }
        case "models": {
          const d = await deps.dashboard(refresh);
          if (d.state !== "ready") return { exitCode: 1, stderr: notReadyText(d) };
          const range = option("--range") ?? "cycle";
          const from = rangeFrom(range, d);
          if (from === null) return { exitCode: 1, stderr: "--range must be cycle or <N>d, e.g. 7d." };
          const s = summarize(d.transactions, from);
          const header = `${range}: ${fmt(s.spent)} credits · ${s.generations} generations · ${s.refunds} refunded`;
          return out(
            s.models,
            [
              header,
              ...s.models.map(
                (m) =>
                  `${fmt(m.spent).padStart(9)} cr  ${String(m.generations).padStart(4)} gen  ${String(m.refunds).padStart(3)} failed  ${fmt(m.avgPerGeneration).padStart(6)}/gen  ${m.label}${m.media === null ? "" : ` [${m.media}]`}`,
              ),
            ].join("\n"),
          );
        }
        case "transactions": {
          const d = await deps.dashboard(refresh);
          if (d.state !== "ready") return { exitCode: 1, stderr: notReadyText(d) };
          const rows = d.transactions.slice(0, limit);
          return out(
            rows,
            rows.length === 0
              ? "No transactions."
              : rows
                  .map((tx) => `${(tx.at ?? "").slice(0, 16).replace("T", " ")}  ${fmt(tx.amount).padStart(10)}  ${tx.category.padEnd(12)}  ${tx.label}`)
                  .join("\n"),
          );
        }
        case "jobs": {
          const d = await deps.dashboard(refresh);
          const rows = d.jobs.slice(0, limit);
          return out(
            rows,
            rows.length === 0
              ? "No recent jobs."
              : rows
                  .map((job) => `${(job.at ?? "").slice(0, 16).replace("T", " ")}  ${job.status.padEnd(10)}  ${job.model}${job.cost === null ? "" : `  (${fmt(job.cost)} cr)`}`)
                  .join("\n"),
          );
        }
        case "login": {
          const result = await deps.login();
          return {
            exitCode: result.started ? 0 : 1,
            stdout: [result.message, result.url === null ? null : `Sign-in URL: ${result.url}`]
              .filter(Boolean)
              .join("\n"),
          };
        }
        case "logout": {
          const result = await deps.logout();
          return { exitCode: result.ok ? 0 : 1, stdout: result.message };
        }
        case "raw": {
          const target = args[0];
          if (!isRawTarget(target)) break;
          const result = await deps.raw(target, args[1]);
          return {
            exitCode: result.ok ? 0 : 1,
            stdout: truncate(JSON.stringify(result.ok ? result.data : result, null, 2)),
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
