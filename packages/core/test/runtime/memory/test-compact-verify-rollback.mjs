/**
 * Fixture test (Option A,): compaction verify/rollback stage.
 *
 * A compaction that "succeeds"can still destroy context silently: an
 * empty/boilerplate summary (the STEP 0.75 defect class), a summary larger than
 * the dropped span (budget not recovered), or a branch left incoherent (missing
 * first-kept anchor). Before the verify stage existed, the outcome stage recorded
 * recordCompactionOutcome("success") on any truthy result with no coherence or
 * budget validation.
 *
 * Coverage:
 * (a) Coherent compaction (non-empty summary, firstKeptEntryId present,
 * budget dropped) -> verify passes, success outcome recorded, NO failure
 * feedback, verifyFailed NOT set. This is the control path.
 * (b) Compaction with EMPTY summary -> verify fails -> failure outcome with a
 * coherence reason, honest "Compaction verify FAILED"log line, and the
 * verifyFailed flag set then consumed+cleared by the originals
 * archive write (which also lands under <tmp>/archives/). Fails pre-fix:
 * plain success recorded.
 * (c) Compaction where budget did NOT drop -> verify fails -> failure outcome
 * with a budget reason. Fails pre-fix: plain success recorded.
 * (d) No compaction fired (aborted) -> no verify, no failure state change.
 *
 * Run: node test/runtime/memory/test-compact-verify-rollback.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ───────────────────────
// The compaction handlers verify budgets through analyzeSession, whose usage
// flows through the ONE resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent (percent mutated between phases, tokens
// fixed) and broke the budget-reason pins. Redirect HOME to a temp dir BEFORE
// the dist imports (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-verify-rollback-"));
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
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getCompactionHealth, getCmState } = sharedMod;
const resetCompactionHealth = sharedMod.resetCompactionHealth ?? (() => {});
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

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
  // Real temp dir so the originals archive (written on verify failure)
  // lands under tmp/archives instead of polluting /tmp.
  const tmp = mkdtempSync(join(tmpdir(), "cm-verify-rollback-"));
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
  // Mutable usage so a test can drop usage between session_before_compact
  // (pre-compaction capture) and session_compact (post-compaction recompute).
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
      session: { filePath: join(tmp, "session.jsonl") },
      getSessionFile: () => join(tmp, "session.jsonl"),
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

  return { ctx, branch, usage, tmp, setLivePercent };
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
 * Kick off a compaction cycle: session_before_compact captures the
 * pre-compaction usage, then the test mutates usage to the post-compaction
 * value before firing session_compact.
 */
async function startCompact(pi, ctx, branch) {
  await pi._emit(
    { type: "session_before_compact", preparation: makePrep(branch, "e70"), reason: "threshold" },
    ctx,
  );
}

function makeCompactEvent({ summary, firstKeptEntryId = "e70" } = {}) {
  return {
    type: "session_compact",
    reason: "threshold",
    willRetry: false,
    compactionEntry: { id: "c1", summary: summary ?? "s1", firstKeptEntryId },
  };
}

function makeFailedEvent({ aborted = true } = {}) {
  return { type: "session_compact_failed", reason: "threshold", aborted, willRetry: false };
}

function compactionFailedLine(logs) {
  return logs.some(
    (l) =>
      l.source === "context-manager" &&
      l.message.includes("Compaction verify FAILED") &&
      l.message.includes("originals preserved in branch"),
  );
}

console.log("=== compaction verify/rollback stage: coherence + budget validation ===\n");

await test("(a) coherent compaction (summary + anchor + budget drop) records success", async () => {
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  // Post-compaction: budget dropped well below the captured 50%.
  setLivePercent(20);
  clearLogBuffer();
  await pi._emit(makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e70" }), ctx);

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "success", "coherent compaction must record success");
  assert.equal(health.totalCompactions, 1);
  assert.equal(health.totalFailures, 0, "coherent compaction must NOT count as a failure");
  assert.equal(getCmState(ctx).verifyFailed, false, "verifyFailed must stay false on success");
  assert.ok(
    !compactionFailedLine(getLogBuffer()),
    "no failure feedback line may be logged on a coherent compaction",
  );
});

await test("(b) empty summary -> verify failure with coherence reason + honest log + flag", async () => {
  resetCompactionHealth();
  const { ctx, branch, tmp, setLivePercent } = makeFakeCtx({
    percent: 50,
    branchLength: 100,
  });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  // Budget WOULD pass; coherence must fail first (blank summary).
  setLivePercent(20);
  clearLogBuffer();
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "failure", "empty-summary compaction must record failure");
  assert.equal(health.totalFailures, 1);
  assert.equal(health.totalCompactions, 0, "a verify failure must NOT count as a success");
  assert.match(
    health.lastErrorMessage ?? "",
    /^verify: coherence/,
    "failure must carry a specific coherence reason",
  );
  assert.equal(
    getCmState(ctx).verifyFailed,
    false,
    "verifyFailed must be consumed+cleared by the archive write " +
      "(the archive write owns the flag lifecycle)",
  );
  // The verify failure triggers the originals archive write.
  const archives = readdirSync(join(tmp, "archives")).filter((f) => f.endsWith(".jsonl"));
  assert.equal(archives.length, 1, "originals archive must be written on verify failure");
  const logs = getLogBuffer();
  assert.ok(compactionFailedLine(logs), "honest 'Compaction verify FAILED' line must be logged");
  assert.ok(
    !logs.some((l) => l.message.includes("Compaction completed successfully")),
    "must NOT log the plain success line on a verify failure",
  );
});

await test("(c) budget not dropped -> verify failure with budget reason", async () => {
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  // Coherence passes (non-empty summary + anchor) but usage stays at 50% ->
  // the summary did not recover budget (no-op treadmill).
  setLivePercent(50);
  clearLogBuffer();
  await pi._emit(makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e70" }), ctx);

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "failure", "no-budget-drop compaction must record failure");
  assert.equal(health.totalFailures, 1);
  assert.equal(health.totalCompactions, 0);
  assert.match(
    health.lastErrorMessage ?? "",
    /^verify: budget/,
    "failure must carry a specific budget reason",
  );
  assert.equal(
    getCmState(ctx).verifyFailed,
    false,
    "verifyFailed must be consumed+cleared by the archive write",
  );
  assert.ok(compactionFailedLine(getLogBuffer()), "honest failure line must still be logged");
});

await test("(d) no compaction fired (aborted) -> no verify, no state change", async () => {
  resetCompactionHealth();
  const { ctx, branch } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  clearLogBuffer();
  registerSessionCompactFailedHandler(pi);
  await pi._emit(makeFailedEvent({ aborted: true }), ctx);

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "aborted", "abort must be recorded, not a verify outcome");
  assert.equal(health.totalFailures, 0, "abort must NOT be a verify failure");
  assert.equal(health.totalCompactions, 0);
  assert.equal(
    getCmState(ctx).verifyFailed,
    false,
    "verifyFailed must stay false when no compaction completed",
  );
  assert.ok(
    !compactionFailedLine(getLogBuffer()),
    "no failure feedback when no compaction completed",
  );
});

// Clean up temp dirs created by this test run (best-effort).
const base = tmpdir();
for (const n of readdirSync(base).filter((n) => n.startsWith("cm-verify-rollback-"))) {
  try {
    rmSync(join(base, n), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
