/**
 * Fixture test (Option B b /): per-session navigation-adoption
 * counters.
 *
 * The counters measure whether the agent actually STEERS with loss-preferring
 * navigation (tag/checkout/log/archive/slide) instead of destructive compact —
 * LONG-RUNNING-SESSIONS.md: "navigation adoption per long session ...
 * trending up, compaction-per-session trending down".
 *
 * Coverage:
 * (a) tag/checkout/log each increment their counter once per successful call
 * (and per-CALL, so N successful calls => N).
 * (b) archive/slide/compact/deep_clean each increment their counter on a
 * successful dispatch. Fails pre-fix: no counters exist.
 * (c) abort/error/no-op paths do NOT increment — the block stays absent
 * (nil) or unchanged because recordNavigationAction is only reached on
 * the success path.
 * (d) context_inspect detail=detailed surfaces the navigation line with the
 * accumulated counts, separating loss-preferring navigation from
 * compacts. Fails pre-fix: no navigation line exists at all.
 * (e) context_inspect detail=quick has NO navigation line (the quick surface
 * stays byte-identical here).
 *
 * Run: node test/runtime/memory/test-navigation-adoption-counters.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ──────────────────────
// The context_inspect/context_compress surfaces read usage through the ONE
// resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent and broke the threshold pins (Steer line,
// refusal bands). Redirect HOME to a temp dir BEFORE the dist imports
// (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-nav-counters-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getCmState } = sharedMod;
// recordNavigationAction is new in this round; guard so the assertions run
// standalone against pre-fix code (where the helper does not exist yet) and
// fail on the COUNTS, not on module load.
const recordNavigationAction = sharedMod.recordNavigationAction ?? (() => {});
const { registerContextNavigate } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-navigate.js")
);
const { registerContextCompress } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { registerContextInspect } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-inspect.js")
);

function makeFakePi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    // The documented durable-entry seam; this suite asserts other surfaces.
    appendEntry() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
      }
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 50, branchLength = 10 } = {}) {
  const sessionId = `nav-adopt-${++sessionSeq}`;
  const labels = new Map();
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    // 8-hex-char ids (e.g. 00000003) so checkout targets resolve via the
    // hex-id fast path in resolveTarget.
    branch.push({
      id: String(i + 1).padStart(8, "0"),
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            // Branch content sized so the session-tree measure (the live
            // metric's source) reports the intended percent; the fake
            // accessor below stays in agreement with the branch.
            text: `msg ${i} ${"x".repeat(
              Math.max(0, Math.round(((percent / 100) * 200000 * 4) / branchLength) - 7),
            )}`,
          },
        ],
        timestamp: 1000 + i,
      },
    });
  }
  const sm = {
    getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    getSessionId: () => sessionId,
    getLeafId: () => branch[branch.length - 1].id,
    getBranch: () => branch,
    getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
    getChildren: () => [],
    getLabel: (id) => labels.get(id),
    appendLabelChange: (id, name) => {
      labels.set(id, name);
    },
    appendCustomEntry: () => {},
    branchWithSummary: (targetId, summary) => {
      const newId = "f0000001";
      branch.push({ id: newId, type: "branch_summary", summary });
      return newId;
    },
  };
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    abortCalls: 0,
    abort: () => {
      ctx.abortCalls++;
    },
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    sessionManager: sm,
  };
  return ctx;
}

// Nil the session counter block so each test starts (and ends) clean.
function resetNavigationBlock(ctx) {
  getCmState(ctx).navigationAdoption = undefined;
}

function navCounts(ctx) {
  const na = getCmState(ctx).navigationAdoption;
  return {
    block: na,
    tags: na?.tags ?? 0,
    checkouts: na?.checkouts ?? 0,
    logs: na?.logs ?? 0,
    archives: na?.archives ?? 0,
    slides: na?.slides ?? 0,
    compacts: na?.compacts ?? 0,
    deepCleans: na?.deepCleans ?? 0,
  };
}

const piNav = makeFakePi();
registerContextNavigate(piNav);
const navTool = piNav.tools.get("context_navigate");
assert.ok(navTool, "context_navigate tool must be registered");

const piComp = makeFakePi();
registerContextCompress(piComp);
const compTool = piComp.tools.get("context_compress");
assert.ok(compTool, "context_compress tool must be registered");

const piInsp = makeFakePi();
registerContextInspect(piInsp);
const inspTool = piInsp.tools.get("context_inspect");
assert.ok(inspTool, "context_inspect tool must be registered");

console.log("=== navigation-adoption counters + inspect surface (option B) ===\n");

await test("(a) tag/checkout/log each increment their counter on success", async () => {
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);

  const t1 = await navTool.execute("c1", { action: "tag", name: "t1" }, null, null, ctx);
  assert.ok(!t1.details.error, `tag t1 should succeed, got: ${JSON.stringify(t1.details)}`);
  let c = navCounts(ctx);
  assert.equal(c.tags, 1, "tag should increment tags to 1");
  assert.equal(c.block.tags, 1, "block tags === 1");

  const t2 = await navTool.execute("c2", { action: "tag", name: "t2" }, null, null, ctx);
  assert.ok(!t2.details.error, `tag t2 should succeed`);
  c = navCounts(ctx);
  assert.equal(c.tags, 2, "second successful tag should increment to 2");

  const l1 = await navTool.execute("c3", { action: "log" }, null, null, ctx);
  assert.ok(!l1.details.error, "log should succeed");
  c = navCounts(ctx);
  assert.equal(c.logs, 1, "log should increment logs to 1");

  const co1 = await navTool.execute(
    "c4",
    { action: "checkout", target: "00000001", message: "go explore" },
    null,
    null,
    ctx,
  );
  assert.ok(co1.details?.checkout, `checkout should commit, got: ${JSON.stringify(co1.details)}`);
  assert.equal(ctx.abortCalls, 1, "checkout success must have aborted the turn");
  c = navCounts(ctx);
  assert.equal(c.checkouts, 1, "checkout should increment checkouts to 1");

  assert.equal(c.tags, 2, "tags accumulated to 2");
  assert.equal(c.logs, 1, "logs accumulated to 1");
  assert.deepEqual(
    { tags: c.tags, checkouts: c.checkouts, logs: c.logs },
    { tags: 2, checkouts: 1, logs: 1 },
    "no cross-kind leakage between counters",
  );
  resetNavigationBlock(ctx);
});

await test("(b) archive/slide/compact/deep_clean each increment on success", async () => {
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);

  const ar = await compTool.execute(
    "c1",
    { action: "archive", topic: "work", summary: "did the work" },
    null,
    null,
    ctx,
  );
  assert.ok(!ar.details.error, `archive should succeed, got: ${JSON.stringify(ar.details)}`);
  assert.equal(ar.details.compressed, 10, "archive auto-range on a 10-entry branch");

  const sl = await compTool.execute("c2", { action: "slide", keep: 5 }, null, null, ctx);
  assert.ok(sl.details?.slideTriggered, `slide should trigger, got: ${JSON.stringify(sl.details)}`);

  const cp = await compTool.execute("c3", { action: "compact" }, null, null, ctx);
  assert.ok(!cp.details.error, `compact should succeed, got: ${JSON.stringify(cp.details)}`);

  const dc = await compTool.execute(
    "c4",
    { action: "deep_clean", topic: "old", summary: "archived old work", tagName: "clean-tag" },
    null,
    null,
    ctx,
  );
  assert.ok(
    dc.details?.compactionTriggered,
    `deep_clean should trigger, got: ${JSON.stringify(dc.details)}`,
  );

  const c = navCounts(ctx);
  assert.deepEqual(
    { archives: c.archives, slides: c.slides, compacts: c.compacts, deepCleans: c.deepCleans },
    { archives: 1, slides: 1, compacts: 1, deepCleans: 1 },
    "each compression action increments exactly its own kind once",
  );
  resetNavigationBlock(ctx);
});

await test("(c) abort/error/no-op paths do NOT increment", async () => {
  // ---- context_navigate error paths on one session - no block may appear ----
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);
  await navTool.execute("e1", { action: "tag" }, null, null, ctx); // missing name
  await navTool.execute(
    "e2",
    { action: "checkout", target: "zzzzzzzz", message: "m" },
    null,
    null,
    ctx,
  ); // unresolvable -> recovery fallback
  await navTool.execute("e3", { action: "checkout" }, null, null, ctx); // missing params
  assert.equal(
    getCmState(ctx).navigationAdoption,
    undefined,
    "navigate error paths must NOT create the counter block",
  );

  // Compact refusal (usage > 70%) must not increment.
  const hot = makeFakeCtx({ percent: 80, branchLength: 10 });
  resetNavigationBlock(hot);
  const ref = await compTool.execute("e6", { action: "compact" }, null, null, hot);
  assert.ok(ref.details?.refused, "compact at 80% must be refused");
  assert.equal(
    getCmState(hot).navigationAdoption,
    undefined,
    "refused compact must NOT create the counter block",
  );

  // Compact skip (usage < 30%) must not increment.
  const low = makeFakeCtx({ percent: 20, branchLength: 10 });
  resetNavigationBlock(low);
  const skip = await compTool.execute("e7", { action: "compact" }, null, null, low);
  assert.ok(skip.details?.skipped, "compact at 20% must be skipped");
  assert.equal(
    getCmState(low).navigationAdoption,
    undefined,
    "skipped compact must NOT create the counter block",
  );

  // Slide with branch <= keep ("nothing to slide") must not increment.
  const tiny = makeFakeCtx({ percent: 50, branchLength: 3 });
  resetNavigationBlock(tiny);
  const noslide = await compTool.execute("e8", { action: "slide" }, null, null, tiny); // default keep 50 > 3
  assert.equal(noslide.details?.slid, 0, "slide on a tiny branch reports nothing slid");
  assert.equal(
    getCmState(tiny).navigationAdoption,
    undefined,
    "no-op slide must NOT create the counter block",
  );

  // Slide with invalid keep must not increment.
  const badkeep = makeFakeCtx({ percent: 50, branchLength: 10 });
  resetNavigationBlock(badkeep);
  await compTool.execute("e9", { action: "slide", keep: 0 }, null, null, badkeep);
  assert.equal(
    getCmState(badkeep).navigationAdoption,
    undefined,
    "invalid-keep slide must NOT increment",
  );

  // Archive without topic/summary must not increment.
  const noargs = makeFakeCtx({ percent: 50, branchLength: 10 });
  resetNavigationBlock(noargs);
  await compTool.execute("e10", { action: "archive" }, null, null, noargs);
  assert.equal(
    getCmState(noargs).navigationAdoption,
    undefined,
    "missing-arg archive must NOT increment",
  );

  // Deep_clean without topic/summary must not increment.
  const nodc = makeFakeCtx({ percent: 50, branchLength: 10 });
  resetNavigationBlock(nodc);
  await compTool.execute("e11", { action: "deep_clean" }, null, null, nodc);
  assert.equal(
    getCmState(nodc).navigationAdoption,
    undefined,
    "missing-arg deep_clean must NOT increment",
  );

  // Duplicate tag name (error) must not increment — but the FIRST tag was a
  // real success, so the counter must stay exactly 1.
  const dup = makeFakeCtx();
  resetNavigationBlock(dup);
  await navTool.execute("d1", { action: "tag", name: "dup" }, null, null, dup);
  assert.equal(navCounts(dup).tags, 1, "first tag succeeds -> 1");
  const d2 = await navTool.execute("d2", { action: "tag", name: "dup" }, null, null, dup);
  assert.ok(d2.details?.error, "duplicate tag must be an error");
  assert.equal(navCounts(dup).tags, 1, "duplicate-tag error must NOT increment");

  resetNavigationBlock(ctx);
});

await test("(d) detail=detailed surfaces the navigation line with accumulated counts", async () => {
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);

  await navTool.execute("c1", { action: "tag", name: "t1" }, null, null, ctx);
  await navTool.execute("c2", { action: "log" }, null, null, ctx);
  await navTool.execute(
    "c3",
    { action: "checkout", target: "00000001", message: "m" },
    null,
    null,
    ctx,
  );
  await compTool.execute(
    "c4",
    { action: "archive", topic: "work", summary: "done" },
    null,
    null,
    ctx,
  );
  await compTool.execute("c5", { action: "slide", keep: 5 }, null, null, ctx);
  await compTool.execute("c6", { action: "compact" }, null, null, ctx);
  await compTool.execute(
    "c7",
    { action: "deep_clean", topic: "old", summary: "archived" },
    null,
    null,
    ctx,
  );

  const res = await inspTool.execute("d1", { detail: "detailed" }, null, null, ctx);
  const text = res.content[0].text;
  assert.ok(
    /### Navigation Adoption/.test(text),
    `detailed inspect must render a Navigation Adoption section, got:\n${text}`,
  );
  assert.ok(
    /navigation: 1 tags \/ 1 checkouts \/ 1 logs · archives 1 \/ slides 1 \(deep-cleans 1\) vs compacts 1/.test(
      text,
    ),
    `navigation line must carry the accumulated counts, got:\n${text}`,
  );
  // Loss-preferring navigation must be visually separated from compacts.
  const navSection = text.split("### Navigation Adoption")[1] ?? "";
  assert.ok(/·/.test(navSection), "navigation line must use the loss-preferring · separators");
  assert.ok(/vs compacts 1/.test(text), "compacts must be reported separately (vs)");
  resetNavigationBlock(ctx);
});

await test("(e) detail=quick has NO navigation line", async () => {
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);

  // Give the session real steering so the block exists before the quick check.
  await navTool.execute("c1", { action: "tag", name: "t1" }, null, null, ctx);
  await compTool.execute(
    "c2",
    { action: "archive", topic: "work", summary: "done" },
    null,
    null,
    ctx,
  );
  assert.ok(getCmState(ctx).navigationAdoption, "block must exist before the quick check");

  const res = await inspTool.execute("d1", { detail: "quick" }, null, null, ctx);
  const text = res.content[0].text;
  assert.doesNotMatch(
    text,
    /navigation/i,
    `detail=quick must NOT contain any navigation line, got:\n${text}`,
  );
  assert.doesNotMatch(
    text,
    /Navigation Adoption/i,
    `detail=quick must not contain the Navigation Adoption header, got:\n${text}`,
  );
  resetNavigationBlock(ctx);
});

// Sanity: recordNavigationAction is lazily safe and idempotent in shape.
await test("(sanity) recordNavigationAction lazily inits and accumulates directly", async () => {
  const ctx = makeFakeCtx();
  resetNavigationBlock(ctx);
  assert.equal(getCmState(ctx).navigationAdoption, undefined, "block absent before any record");
  recordNavigationAction(ctx, "log");
  recordNavigationAction(ctx, "log");
  recordNavigationAction(ctx, "tag");
  const c = navCounts(ctx);
  assert.equal(c.logs, 2, "direct calls accumulate");
  assert.equal(c.tags, 1, "direct tag increments");
  assert.equal(c.checkouts, 0, "untouched kinds stay 0");
  resetNavigationBlock(ctx);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
