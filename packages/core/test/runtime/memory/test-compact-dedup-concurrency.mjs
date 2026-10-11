/**
 * Fixture test (P1v3): the compaction dedup guard is concurrency-scoped, not a
 * lifetime per-leaf block.
 *
 * The guard must:
 *   1. dedupe the in-cycle double-fire from pi-core's two call sites
 *      (compact() + _runAutoCompaction()) — one compaction runs, one is skipped;
 *   2. NOT starve a later legitimate compaction on the SAME session+leaf: after
 *      completion (isCompactionActive=false) a new cycle must run.
 *
 * Old behavior: markCompactProcessed held a persistent `sessionId::leafId` key
 * for the whole session, so the second cycle on the same leaf was silently
 * skipped ("duplicate - skipping") — a real starvation bug. This test fails on
 * that code (cycle 2 never runs) and passes on the concurrency-scoped guard.
 *
 * Run: node test/runtime/memory/test-compact-dedup-concurrency.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  [x] ${name}: ${e.message}`);
      failed++;
    });
}

const { registerBeforeCompactHandler, registerSessionCompactHandler } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
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
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i}` }],
        timestamp: 1000 + i,
      },
    });
  }
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
}

function makePrep() {
  return { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false };
}

/**
 * Fire session_before_compact. Returns true if the handler RAN (observed via
 * event.customInstructions being set by STEP 2 of the normal path).
 */
async function fireBeforeCompact(pi, ctx) {
  const evt = { type: "session_before_compact", preparation: makePrep() };
  await pi._emit(evt, ctx);
  return evt.customInstructions !== undefined;
}

console.log("=== compaction dedup guard: concurrency-scoped (P1v3) ===\n");

await test("double-fire in one cycle dedupes; a later cycle on the same leaf runs", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  // Cycle 1, first firing (manual compact()) — must run.
  const ran1 = await fireBeforeCompact(pi, ctx);

  // Cycle 1, second firing (_runAutoCompaction()) while compaction in-flight — must be skipped.
  const ran2 = await fireBeforeCompact(pi, ctx);

  assert.equal(ran1, true, "first firing of the cycle runs");
  assert.equal(ran2, false, "second firing of the same cycle is deduped (one runs, one skipped)");

  // Compaction completes (active=false) — session_compact closes the cycle.
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c1", summary: "s1", firstKeptEntryId: "e4" },
    },
    ctx,
  );

  // Cycle 2 on the SAME session+leaf — must run (not starved).
  const ran3 = await fireBeforeCompact(pi, ctx);
  assert.equal(
    ran3,
    true,
    "a later compaction cycle on the same leaf must run (no lifetime per-leaf block)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
