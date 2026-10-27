/**
 * Fixture: context_compress slide/archive must actually move the live working
 * set, and the reported metrics must reflect it.
 *
 * Modeled against the real pi-core 0.85.1 contracts (this is what separates
 * this fixture from fakes that model pi-core wrong):
 *   - SessionManager.getTree() returns ROOT nodes only — one node for a
 *     linear session. Counting anything by walking the tree therefore sees
 *     almost nothing (the "0 tags, 0 summaries" defect).
 *   - Branch entries are { id, type: "message", message: { role, content } } —
 *     a user turn is entry.message.role, not entry.type/entry.role.
 *   - ctx.compact(options) forwards options.customInstructions to
 *     compact(customInstructions), so the SLIDE_MODE marker arrives as a
 *     string on session_before_compact.
 *   - A session_before_compact handler may return { compaction } (the
 *     extension-compaction channel): pi-core then skips the default LLM
 *     summarization and appends the provided result verbatim.
 *   - session_compact carries the outcome on compactionEntry (pi-core 0.85.1
 *     has no compaction_end extension event)
 *     { summary, firstKeptEntryId, ... }, not at the top level.
 *
 * Live reproduction evidence this pins (live orchestrator sessions):
 *   - slide keep=80 @ branch 562 anchored exactly at index 482 and the live
 *     set dropped 85.6% -> 37.9% AFTER settle — the in-run inspect that
 *     reported "unchanged" was taken before the batch-settle compact fired;
 *   - archive(keepRecentTurns=2) at ~470 entries resolved to span [0..0] and
 *     archived a single entry;
 *   - every context_inspect stats line read "0 tags, 0 summaries" regardless
 *     of the session's real labels/compactions.
 *
 * Run: node test/runtime/memory/test-compress-slide-archive-movement.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

const { registerContextCompress } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const {
  registerBeforeCompactHandler,
  registerSessionCompactOutcomeHandler,
} = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const { getCmState, resetCompactionHealth, getCompactionHealth } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { analyzeSession } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/analysis.js")
);
const { measureLiveUsage, resolveWindow } = await import(
  join(ROOT, "dist/lib/detection/context-usage.js")
);

/**
 * ExtensionAPI double. `sm` is the fake session manager the tests simulate;
 * the documented appendEntry seam delegates to its appendCustomEntry, exactly
 * as pi's own implementation wraps it.
 */
function makeFakePi(sm) {
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
    appendEntry(customType, data) {
      sm?.appendCustomEntry?.(customType, data);
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      let result;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ...args);
        // Mirror the real runner: session_before_* handler results flow through.
        if (name === "session_before_compact" && r) result = r;
      }
      return result;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake session manager modeling pi-core's real contracts:
 * - getTree() returns ROOTS ONLY (single root for a linear branch).
 * - Branch entries are { id, type: "message", message: { role, content } }.
 * - appendCustomEntry/appendCompaction mutate the branch like the real one.
 */
function makeFakeSm({ branchLength = 12, percent = 40, userEvery = 2 } = {}) {
  const branch = [];
  // Unique session file per instance: extension state (dedup guard, batch
  // settle, cmState) is keyed by session file path — sharing one across
  // tests would leak compaction-cycle state between them.
  const sessionFile = join(
    tmpdir(),
    `slide-archive-movement-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  // Content sized so measureLiveUsage lands near the requested percent:
  // estimate is chars/4, sized against the RESOLVED window (configured
  // overrides included) so the fixture is settings-independent.
  const window = resolveWindow(100000).contextWindow;
  const textLen = Math.max(40, Math.round(((percent / 100) * window * 4) / branchLength));
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message",
      message: {
        role: i % userEvery === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `entry ${i} ${"x".repeat(textLen - 8)}` }],
        timestamp: 1000 + i,
      },
    });
  }
  const labels = new Map();
  const sm = {
    branch,
    labels,
    getSessionFile: () => sessionFile,
    getSessionId: () => "fixture-session",
    getLeafId: () => branch[branch.length - 1]?.id,
    getBranch: () => branch,
    // REAL contract: roots only, never the full node list.
    getTree: () => [{ entry: branch[0], children: [], label: labels.get(branch[0].id) }],
    getLabel: (id) => labels.get(id),
    getChildren: () => [],
    appendCustomEntry: (customType, data) => {
      const prev = branch[branch.length - 1];
      const entry = {
        id: `c${branch.length}`,
        parentId: prev.id,
        type: "custom",
        customType,
        data,
        timestamp: new Date().toISOString(),
      };
      branch.push(entry);
      return entry.id;
    },
    appendCompaction: (summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) => {
      const prev = branch[branch.length - 1];
      const entry = {
        id: `k${branch.length}`,
        parentId: prev.id,
        type: "compaction",
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromHook,
        usage,
        timestamp: new Date().toISOString(),
      };
      branch.push(entry);
      return entry.id;
    },
  };
  return sm;
}

function makeFakeCtx(sm) {
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: { contextWindow: 100000 },
    sessionManager: sm,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
  };
  return ctx;
}

function makePrep(branch, firstKeptEntryId) {
  // pi-core 0.85.1 preparation shape from prepareCompaction().
  const messagesToSummarize = branch
    .filter((e) => e.type === "message")
    .slice(0, 5)
    .map((e) => e.message);
  return { firstKeptEntryId, messagesToSummarize, turnPrefixMessages: [], isSplitTurn: false };
}

console.log("=== context_compress slide/archive movement ===\n");

await test("slide: steering yields a deterministic extension compaction (no LLM path)", async () => {
  const sm = makeFakeSm({ branchLength: 60, percent: 80 });
  const ctx = makeFakeCtx(sm);
  const pi = makeFakePi(sm);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);
  const tool = pi.tools.get("context_compress");

  const result = await tool.execute(
    "s-1",
    { action: "slide", keep: 20 },
    undefined,
    undefined,
    ctx,
  );
  // Arming only queues; the settle drain lands the compaction.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "slide arms the batch-settle compact");
  assert.equal(
    ctx.compactCalls[0]?.customInstructions,
    "SLIDE_MODE:true",
    "the marker rides customInstructions (what ctx.compact forwards)",
  );

  const slide = getCmState(ctx).slideMode;
  assert.ok(slide?.active && slide.cutEntryId, "slideMode persisted for session_before_compact");
  assert.equal(slide.cutEntryId, "e40", "cut point is branch[60-20] = e40");
  assert.equal(slide.droppedCount, 40);

  // pi-core fires session_before_compact with the marker as a string and its
  // own default preparation; the handler must return the extension compaction
  // so pi-core skips the LLM update call entirely.
  const prep = makePrep(sm.branch, "e50");
  const outcome = await pi._emit(
    {
      type: "session_before_compact",
      preparation: prep,
      customInstructions: ctx.compactCalls[0].customInstructions,
      reason: "manual",
    },
    ctx,
  );

  assert.ok(outcome?.compaction, "handler returns the extension compaction object");
  assert.equal(
    outcome.compaction.firstKeptEntryId,
    "e40",
    "compaction anchor is the declared cut entry",
  );
  assert.ok(
    typeof outcome.compaction.summary === "string" && outcome.compaction.summary.trim().length > 0,
    "compaction summary is non-empty (verify-stage coherence)",
  );
  assert.ok(
    outcome.compaction.summary.length < 500,
    "compaction summary is a one-liner, not a re-rendered summary",
  );
  assert.equal(
    typeof outcome.compaction.tokensBefore,
    "number",
    "tokensBefore measured for the compaction record",
  );
  assert.equal(getCmState(ctx).slideMode, null, "slideMode consumed (one-shot)");

  // Landed like pi-core would, the branch carries the compaction entry.
  const landed = sm.appendCompaction(
    outcome.compaction.summary,
    outcome.compaction.firstKeptEntryId,
    outcome.compaction.tokensBefore,
    outcome.compaction.details ?? { readFiles: [], modifiedFiles: [] },
    true,
    undefined,
  );
  assert.ok(landed, "fixture appendCompaction accepted the extension result");
  assert.equal(result.details.slideTriggered, true);
});

await test("slide: after the compaction lands, the live usage metric drops", async () => {
  const sm = makeFakeSm({ branchLength: 60, percent: 80 });
  const ctx = makeFakeCtx(sm);
  const pi = makeFakePi(sm);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);
  const tool = pi.tools.get("context_compress");

  const before = measureLiveUsage(ctx);
  assert.ok(before && before.percent > 50, `pre-slide live usage is high, got ${before?.percent}`);

  await tool.execute("s-2", { action: "slide", keep: 20 }, undefined, undefined, ctx);
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  const outcome = await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(sm.branch, "e50"),
      customInstructions: ctx.compactCalls[0].customInstructions,
      reason: "manual",
    },
    ctx,
  );
  assert.ok(outcome?.compaction, "extension compaction returned (precondition)");

  sm.appendCompaction(
    outcome.compaction.summary,
    outcome.compaction.firstKeptEntryId,
    outcome.compaction.tokensBefore,
    { readFiles: [], modifiedFiles: [] },
    true,
    undefined,
  );
  const after = measureLiveUsage(ctx);
  assert.ok(after, "post-compaction live measurement available");
  assert.ok(
    after.tokens < before.tokens * 0.6,
    `live tokens must drop with the anchor (before=${before.tokens}, after=${after.tokens})`,
  );
  assert.ok(after.percent < before.percent, "live percent must drop");
  const audit = analyzeSession(ctx);
  assert.ok(
    audit.usage.tokens < before.tokens,
    "analyzeSession reports the dropped working set, not the branch total",
  );
});

await test("archive: keepRecentTurns resolves the span from real user entries", async () => {
  const sm = makeFakeSm({ branchLength: 20, percent: 45, userEvery: 2 });
  const ctx = makeFakeCtx(sm);
  const pi = makeFakePi(sm);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  // User entries sit at even indices: 0,2,4,...,18. Keeping the last 2 user
  // turns (indices 16 and 18) archives everything before index 16: span
  // [0..15], boundary entry e16.
  const result = await tool.execute(
    "a-1",
    { action: "archive", keepRecentTurns: 2, topic: "t", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(150);
  assert.equal(ctx.compactCalls.length, 1, "compact armed (usage >= 30%)");
  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode, "rangeMode persisted");
  assert.equal(rangeMode.startIndex, 0);
  assert.equal(
    rangeMode.endIndex,
    15,
    "span covers everything before the 2nd-last user turn (index 16), not just entry 0",
  );
  assert.equal(rangeMode.firstKeptEntryId, "e16", "boundary is the entry after the span");
  assert.ok(result.details.endIndex === 15, "details report the resolved span");
});

await test("archive summary and tags register in the session stats", async () => {
  const sm = makeFakeSm({ branchLength: 20, percent: 45, userEvery: 2 });
  sm.labels.set("e6", "checkpoint-tag");
  sm.labels.set("e15", "second-tag");
  const ctx = makeFakeCtx(sm);
  const pi = makeFakePi(sm);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  const auditBefore = analyzeSession(ctx);
  assert.equal(auditBefore.tagCount, 2, "labels on the branch are counted as tags");

  await tool.execute(
    "a-2",
    { action: "archive", startIndex: 0, endIndex: 7, topic: "t", summary: "ARCHIVED WORK" },
    undefined,
    undefined,
    ctx,
  );
  const auditAfter = analyzeSession(ctx);
  assert.equal(
    auditAfter.summaryCount,
    1,
    "the archive summary entry the tool just wrote registers as a summary",
  );
  assert.equal(auditAfter.tagCount, 2, "tags stay counted after the archive");
});

await test("session_compact verify reads the pi-core compactionEntry envelope", async () => {
  resetCompactionHealth();
  const sm = makeFakeSm({ branchLength: 20, percent: 45 });
  const ctx = makeFakeCtx(sm);
  const pi = makeFakePi(sm);
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  // Pre-compaction usage captured by the fingerprint block at
  // session_before_compact (real cycle) — mirrored here.
  getCmState(ctx).preCompactionUsagePercent = 45;

  // Land the compaction like pi-core would, so the post-compaction live
  // measurement the budget verify takes sees the dropped working set.
  sm.appendCompaction(
    "compact summary",
    "e10",
    40000,
    { readFiles: [], modifiedFiles: [] },
    false,
    undefined,
  );

  // pi-core 0.85.1 shape: outcome carried on compactionEntry.
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: {
        id: "c1",
        summary: "compact summary",
        firstKeptEntryId: "e10",
        tokensBefore: 40000,
      },
    },
    ctx,
  );
  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "success", "a coherent session_compact records success");
  assert.equal(health.totalVerifyFailures, 0, "no verify rollback for a healthy compaction");

  // Negative: an incoherent entry must still be rejected.
  resetCompactionHealth();
  getCmState(ctx).preCompactionUsagePercent = 45;
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: {
        id: "c2",
        summary: "",
        firstKeptEntryId: "e10",
        tokensBefore: 40000,
      },
    },
    ctx,
  );
  assert.equal(
    getCompactionHealth().totalVerifyFailures,
    1,
    "empty summary inside result is still a verify failure",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
