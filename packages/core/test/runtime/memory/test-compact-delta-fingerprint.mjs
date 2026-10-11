/**
 * Fixture test (Option A,): delta+fingerprint skip (Pattern 8,
 * pi-ultra-compact borrow).
 *
 * Repeated auto-compaction cycles re-summarize the SAME input when nothing has
 * changed since the last compaction ("silent re-prime starvation"): the agent
 * keeps receiving the same summary and the redundant steering (pre-filter,
 * semantic compression, summarization) burns tokens for zero new value.
 *
 * Coverage:
 * (a) First compaction on a leaf records a fingerprint; a SECOND firing with
 * the SAME input is cancelled ({ cancel: true }) — no re-steering. Fails
 * pre-fix: the second firing re-steers (no cancel).
 * (b) A firing with CHANGED input (new message appended) does NOT skip.
 * (c) Manual/agent-initiated path (reason="manual") is never skipped even with
 * identical input.
 * (d) Critical usage (>85%) is never skipped even with identical input.
 *
 * The fake pi `_emit`mirrors the installed pi-core runner.js cancel contract:
 * a session-before handler returning an object with a truthy `.cancel`
 * short-circuits the emit (runner.js:570/586-588, pi-core 0.83.0).
 *
 * Run: node test/runtime/memory/test-compact-delta-fingerprint.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ───────────────────────
// The compaction handlers verify budgets through analyzeSession, whose usage
// flows through the ONE resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent and broke the fingerprint/budget pins.
// Redirect HOME to a temp dir BEFORE the dist imports (os.homedir() reads
// $HOME on POSIX — same seam as test-context-limit-config.mjs;
// mock.method(os, "homedir") is not viable because braid-settings captures
// the named import and bakes SETTINGS_PATH at module-eval time) and write the
// EXPLICIT contextLimitTokens this scenario pins: 200_000 — the provider
// window the fixtures were written against (now pinned explicitly so the
// suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-compact-delta-fp-"));
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

const {
  registerBeforeCompactHandler,
  registerSessionCompactHandler,
} = await import(join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js"));

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    // Mirrors installed pi-core runner.js emit(): returns the handler result
    // and short-circuits when a session-before handler returns .cancel.
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      let result;
      for (const h of handlers.get(name) ?? []) {
        result = await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
        if (result?.cancel) return result;
      }
      return result;
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 50, branchLength = 100 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
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
  // Mutable usage so a test can escalate to critical (d) between firings.
  const usage = {
    percent,
    tokens: Math.round((percent / 100) * 200000),
    contextWindow: 200000,
  };
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => usage,
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
  // Rescale the branch content so the session-tree measure (the live
  // metric's source) reports `pct` of the 200k window. Keeps ids/keeps
  // intact; the fake accessor is synced for any residual reads.
  function setLivePercent(pct) {
    const per = Math.max(0, Math.round(((pct / 100) * 200000 * 4) / branchLength) - 7);
    for (const e of branch) {
      const idx = Number(e.id.slice(1));
      e.message.content[0].text = `msg ${idx} ${"x".repeat(per)}`;
    }
    usage.percent = pct;
    usage.tokens = Math.round((pct / 100) * 200000);
  }

  return { ctx, branch, usage, setLivePercent };
}

/**
 * Pre-fill messagesToSummarize with the full branch (pi-core's token-based span)
 * and firstKeptEntryId (pi-core's prepareCompaction always sets it).
 */
function makePrep(branch, firstKeptEntryId) {
  return {
    messagesToSummarize: branch.map((e) => e.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
  };
}

/**
 * Run one successful compaction cycle on the leaf: session_before_compact
 * (records the pending fingerprint) -> session_compact (records it and resets
 * the in-flight flag so the next firing is not deduped). pi-core 0.85.1 has
 * no compaction_end extension event; session_compact closes the cycle.
 */
async function runSuccessfulCycle(pi, ctx, prep, reason) {
  const res = await pi._emit({ type: "session_before_compact", preparation: prep, reason }, ctx);
  await pi._emit({ type: "session_compact", compactionEntry: { id: "c1", summary: "s1" } }, ctx);
  return res;
}

console.log("=== delta+fingerprint skip: no re-compaction when input unchanged ===\n");

await test("(a) same input on a second firing is cancelled (no re-steer)", async () => {
  const { ctx, branch } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  // First cycle: no recorded fingerprint -> no skip; fingerprint recorded.
  const first = await runSuccessfulCycle(pi, ctx, makePrep(branch, "e70"), "threshold");
  assert.equal(first?.cancel, undefined, "first firing must not be cancelled");

  // Second firing with IDENTICAL input -> cancelled.
  const second = await pi._emit(
    { type: "session_before_compact", preparation: makePrep(branch, "e70"), reason: "threshold" },
    ctx,
  );
  assert.equal(second?.cancel, true, "second firing with identical input must be cancelled");
});

await test("(b) changed input (new message appended) does NOT skip", async () => {
  const { ctx, branch } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  await runSuccessfulCycle(pi, ctx, makePrep(branch, "e70"), "threshold");

  // Append a new message -> the compaction input changed.
  branch.push({
    id: "e100",
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "msg 100" }],
      timestamp: 1100,
    },
  });
  const res = await pi._emit(
    { type: "session_before_compact", preparation: makePrep(branch, "e71"), reason: "threshold" },
    ctx,
  );
  assert.equal(res?.cancel, undefined, "changed input must not be cancelled");
});

await test("(c) manual/agent-initiated path is never skipped", async () => {
  const { ctx, branch } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  await runSuccessfulCycle(pi, ctx, makePrep(branch, "e70"), "threshold");

  // Identical input but reason="manual" (pi-core manual compact() path) ->
  // explicit intent, never skipped.
  const res = await pi._emit(
    { type: "session_before_compact", preparation: makePrep(branch, "e70"), reason: "manual" },
    ctx,
  );
  assert.equal(res?.cancel, undefined, "manual compaction must never be cancelled");
});

await test("(d) critical usage (>85%) is never skipped", async () => {
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  await runSuccessfulCycle(pi, ctx, makePrep(branch, "e70"), "threshold");

  // Identical input but context now critical -> must still compact (overflow
  // avoidance), never skipped.
  setLivePercent(90);
  const res = await pi._emit(
    { type: "session_before_compact", preparation: makePrep(branch, "e70"), reason: "threshold" },
    ctx,
  );
  assert.equal(res?.cancel, undefined, "critical usage must never be skipped");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
