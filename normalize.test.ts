import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignSlots,
  buildCatalog,
  detectCycle,
  forecast,
  mediaFor,
  normalizeAccount,
  normalizeJobs,
  normalizeTransactions,
  normalizeWorkspace,
  rankModels,
  summarize,
  unwrapList,
  withMedia,
} from "./normalize.ts";

test("account: flat, nested, and real shapes", () => {
  assert.deepEqual(normalizeAccount({ email: "a@b.c", plan: "pro", credits: "1,250.5" }), {
    email: "a@b.c",
    plan: "pro",
    credits: 1250.5,
  });
  assert.deepEqual(
    normalizeAccount({ user: { email: "a@b.c" }, subscription: { plan_name: "Ultimate" }, wallet: { available: 42 } }),
    { email: "a@b.c", plan: "Ultimate", credits: 42 },
  );
  assert.deepEqual(
    normalizeAccount({ credits: 1141.84, email: "x@y.z", subscription_plan_type: "max" }),
    { email: "x@y.z", plan: "max", credits: 1141.84 },
  );
});

test("list unwrap and cursor", () => {
  const page = unwrapList({ data: { items: [{ id: 1 }], next_cursor: "abc" } });
  assert.equal(page.items.length, 1);
  assert.equal(page.next, "abc");
  assert.equal(unwrapList({ transactions: [{ id: 1 }], has_more: false, cursor: "x" }).next, null);
  assert.equal(unwrapList({ cursor: "5", items: [{ id: 1 }] }).next, "5");
});

// Captured from `higgsfield account transactions --json` (2026-09-29).
const REAL_ROWS = [
  { action: "spend", created_at: "2026-09-29T07:02:41Z", credits: -6.5, display_name: "GPT Image 2.0" },
  { action: "spend", created_at: "2026-09-29T07:01:04Z", credits: -2, display_name: "Nano Banana Pro" },
  { action: "spend", created_at: "2026-09-29T07:00:04Z", credits: -2, display_name: "Nano Banana Pro" },
  { action: "refund", created_at: "2026-09-29T04:44:51Z", credits: 2, display_name: "Nano Banana Pro" },
  { action: "grant", created_at: "2026-09-15T11:04:00.666Z", credits: 1800, display_name: "Subscription Credits" },
  { action: "deduct", created_at: "2026-09-15T11:04:00.650Z", credits: -644.76, display_name: "Subscription Credits Reset" },
  { action: "grant", created_at: "2026-08-15T10:52:48Z", credits: 1800, display_name: "Subscription Credits" },
  { action: "grant", created_at: "2026-08-11T10:03:57Z", credits: 500, display_name: "Credit Package" },
];

test("transactions: categories from the real CLI", () => {
  const txs = normalizeTransactions(REAL_ROWS);
  assert.deepEqual(
    txs.map((t) => t.category),
    ["spend", "spend", "spend", "refund", "subscription", "expiry", "subscription", "package"],
  );
  assert.equal(txs[0]?.label, "GPT Image 2.0");
});

test("transactions: unsigned amounts use the type", () => {
  const txs = normalizeTransactions([
    { id: "1", credits: 10, type: "generation", model: "nano_banana_2", timestamp: 1790000000 },
    { id: "2", credits: 500, type: "subscription_renewal", timestamp: 1790000000 },
  ]);
  assert.deepEqual(txs.map((t) => t.amount), [-10, 500]);
  assert.deepEqual(txs.map((t) => t.category), ["spend", "subscription"]);
});

test("catalog: media type by name, job type, and fuzzy match", () => {
  const catalog = buildCatalog({
    image: [{ display_name: "GPT Image 2", job_type: "gpt_image_2", type: "image" }],
    video: [{ display_name: "Seedance 2.5 Pro", job_type: "seedance_2_5_pro", type: "video" }],
  });
  assert.equal(mediaFor("GPT Image 2.0", catalog), "image");
  assert.equal(mediaFor("Seedance 2.5", catalog), "video");
  assert.equal(mediaFor("Nano Banana Pro", catalog), "image"); // keyword fallback
  assert.equal(mediaFor("Mystery Tool", catalog), null);
  const [job] = normalizeJobs(
    [{ display_name: "GPT Image 2", job_type: "gpt_image_2", status: "completed", params: { prompt: "a cat" }, result_url: "https://cdn.example/x.png" }],
    catalog,
  );
  assert.equal(job?.media, "image");
  assert.equal(job?.prompt, "a cat");
  assert.equal(job?.resultUrl, "https://cdn.example/x.png");
  assert.equal(normalizeWorkspace({ id: "uuid", name: null, plan_type: "max" }), null);
});

test("slots are sticky across re-ranking", () => {
  const first = assignSlots({}, ["a", "b", "c"]);
  assert.deepEqual(first, { a: 0, b: 1, c: 2 });
  // b drops out, d arrives, c overtakes a: survivors keep their colors.
  const second = assignSlots(first, ["c", "a", "d"]);
  assert.deepEqual(second, { c: 2, a: 0, d: 1 });
  assert.equal(Object.keys(assignSlots({}, "abcdefghij".split(""))).length, 7);
});

test("summarize: net spend, generations, refunds per model", () => {
  const txs = normalizeTransactions(REAL_ROWS);
  const s = summarize(txs, new Date("2026-09-29T00:00:00Z"), new Date("2026-09-29T12:00:00Z"));
  assert.equal(s.generations, 3);
  assert.equal(s.refunds, 1);
  assert.equal(s.spent, 8.5);
  const banana = s.models.find((m) => m.label === "Nano Banana Pro");
  assert.equal(banana?.generations, 2);
  assert.equal(banana?.spent, 2);
  assert.equal(banana?.avgPerGeneration, 2); // 2 credits over 1 successful generation
  assert.deepEqual(rankModels(txs), ["GPT Image 2.0", "Nano Banana Pro"]);
});

test("cycle: next reset, grant, expiry of the previous cycle", () => {
  const txs = normalizeTransactions(REAL_ROWS);
  const now = new Date("2026-09-29T12:00:00Z");
  const cycle = detectCycle(txs, now);
  assert.ok(cycle !== null);
  assert.equal(cycle.startedAt, "2026-09-15T11:04:00.666Z");
  assert.equal(cycle.nextResetAt.slice(0, 10), "2026-10-15");
  assert.equal(Math.round(cycle.daysToReset), 16);
  assert.equal(cycle.grantAmount, 1800);
  assert.equal(cycle.spentThisCycle, 8.5);
  const august = cycle.previous.find((p) => p.startedAt.startsWith("2026-08-15"));
  assert.equal(august?.expired, 644.76);
  assert.equal(cycle.previous[0]?.expired, null); // current cycle still open

  const f = forecast({ transactions: txs, credits: 1000, cycle, now });
  assert.equal(f.verdict, "will-expire");
  assert.ok(f.leftAtReset !== null && f.leftAtReset > 900);
  const hungry = forecast({ transactions: txs, credits: 5, cycle, now });
  assert.equal(hungry.verdict, "runs-out");
  assert.equal(withMedia(txs, {})[0]?.media, "image");
});

test("dailyBalance: rebuilds closing balances backwards", async () => {
  const { dailyBalance } = await import("./normalize.ts");
  const txs = normalizeTransactions([
    { action: "spend", created_at: "2026-09-29T10:00:00", credits: -10, display_name: "A" },
    { action: "spend", created_at: "2026-09-28T10:00:00", credits: -5, display_name: "A" },
    { action: "grant", created_at: "2026-09-27T10:00:00", credits: 100, display_name: "Subscription Credits" },
  ]);
  const points = dailyBalance(txs, 85, new Date("2026-09-26T12:00:00"), new Date("2026-09-29T15:00:00"));
  assert.deepEqual(points.map((p) => p.credits), [0, 100, 95, 85]);
});
