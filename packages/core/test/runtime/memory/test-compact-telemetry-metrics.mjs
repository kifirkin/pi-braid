/**
 * Fixture test: verify/rollback + archive-coverage counters.
 *
 * The originals archive is always-on and the verify stage sets
 * cmState.verifyFailed; neither was counted. This change adds two
 * closed counters to CompactionHealth so loss telemetry measures the real
 * Option B state:
 *
 * totalVerifyFailures — verify-stage rejections (rollbacks): a
 * "successful"compaction the coherence/budget
 * verify rejected. Incremented in the verify-failure
 * branch of the session_compact outcome stage where verifyFailed is set.
 * totalArchivesWritten — originals archives actually appended to disk.
 * Incremented AFTER a successful appendFileSync in
 * writeOriginalsArchive (coverage, NOT loss — never
 * part of the loss gate).
 *
 * Coverage:
 * (a) verify-failed compaction (empty summary) -> totalVerifyFailures == 1
 * and lastOutcome reflects the true outcome ("failure"). Fails pre-fix:
 * the field does not exist (undefined).
 * (b) healthy compaction (always-on archive) -> totalArchivesWritten == 1.
 * Fails pre-fix: the field does not exist (undefined).
 * (c) abort + fingerprint-skip paths increment NEITHER counter.
 * (d) resetCompactionHealth() zeros both.
 * (e) formatCompactionLossLine reports the verify count; an archives-only
 * state (healthy compaction, zero failures) yields a non-null but
 * archive-inclusive telemetry line.
 *
 * Reuses fixture patterns from test-compact-originals-archive.mjs (real temp
 * dir so the always-on archive actually lands) and
 * test-compact-verify-rollback.mjs (drive getCmState + session_compact). Health
 * is reset in each test and after the suite so it stays isolated.
 *
 * Run: node test/runtime/memory/test-compact-telemetry-metrics.mjs
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
// fixed) and broke the verify/outcome pins. Redirect HOME to a temp dir
// BEFORE the dist imports (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-telemetry-metrics-"));
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
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} = await import(join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js"));
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getCompactionHealth, getCmState } = sharedMod;
const resetCompactionHealth = sharedMod.resetCompactionHealth ?? (() => {});
const formatCompactionLossLine = sharedMod.formatCompactionLossLine ?? (() => null);

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

/**
 * Fake ctx whose sessionManager points its session.filePath into a real temp
 * dir (so the always-on originals archive write actually lands on disk and
 * increments totalArchivesWritten).
 */
function makeFakeCtx({ percent = 50, branchLength = 100 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const tmp = mkdtempSync(join(tmpdir(), "cm-telemetry-metrics-"));
  const sessionFilePath = join(tmp, "session.jsonl");
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
    cwd: tmp,
    mode: "test",
    hasUI: false,
    getContextUsage: () => usage,
    sessionManager: {
      session: { filePath: sessionFilePath },
      getSessionFile: () => sessionFilePath,
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

  return { ctx, branch, usage, tmp, sessionId, setLivePercent };
}

function makePrep(branch, firstKeptEntryId) {
  return {
    messagesToSummarize: branch.map((e) => e.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
  };
}

/** Kick off a compaction cycle (captures originals + pre-compaction usage). */
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

console.log("=== option B verify/rollback + archive-coverage counters ===\n");

await test("(a) verify-failed compaction increments totalVerifyFailures and records the true outcome", async () => {
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  // Coherence fails first (blank summary) -> verifyFailed path.
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  const health = getCompactionHealth();
  assert.equal(
    health.totalVerifyFailures,
    1,
    "verify-failed compaction must increment totalVerifyFailures by 1",
  );
  assert.equal(
    health.lastOutcome,
    "failure",
    "lastOutcome must reflect the real outcome (failure)",
  );
  assert.equal(health.totalFailures, 1, "a verify rejection is also a failure outcome");
  assert.equal(
    getCmState(ctx).verifyFailed,
    false,
    "verifyFailed must be consumed+cleared by the archive write",
  );
});

await test("(b) healthy compaction increments totalArchivesWritten (always-on coverage)", async () => {
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  // Budget dropped below captured 50% -> verify passes.
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e70" }), ctx);

  const health = getCompactionHealth();
  assert.equal(
    health.totalArchivesWritten,
    1,
    "healthy compaction must increment totalArchivesWritten by 1",
  );
  assert.equal(health.lastOutcome, "success", "healthy compaction is a success");
  assert.equal(health.totalCompactions, 1, "healthy compaction counts as a compact");
  assert.equal(
    health.totalVerifyFailures,
    0,
    "healthy compaction must NOT increment verify-failures",
  );
});

await test("(c) abort + fingerprint-skip paths increment NEITHER counter", async () => {
  resetCompactionHealth();

  // (c1) Abort: originals captured but compaction cancelled -> no archive, no verify.
  const { ctx, branch } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await startCompact(pi, ctx, branch);
  await pi._emit(makeFailedEvent({ aborted: true }), ctx);

  assert.equal(getCompactionHealth().lastOutcome, "aborted", "abort must be recorded as aborted");
  assert.equal(
    getCompactionHealth().totalVerifyFailures,
    0,
    "abort must NOT increment totalVerifyFailures",
  );
  assert.equal(
    getCompactionHealth().totalArchivesWritten,
    0,
    "abort must NOT increment totalArchivesWritten",
  );

  // (c2) Fingerprint-skip: a successful cycle records the fingerprint + archive;
  // a second identical firing is cancelled (skip) and its abort end must not
  // move either counter beyond the already-written first archive.
  const {
    ctx: ctx2,
    branch: branch2,
    setLivePercent: setLivePercent2,
  } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi2 = makeFakePi();
  registerBeforeCompactHandler(pi2);
  registerSessionCompactHandler(pi2);
  registerSessionCompactOutcomeHandler(pi2);
  registerSessionCompactFailedHandler(pi2);

  // First cycle: no recorded fingerprint -> runs, records fingerprint, writes archive.
  const first = await pi2._emit(
    { type: "session_before_compact", preparation: makePrep(branch2, "e70"), reason: "threshold" },
    ctx2,
  );
  assert.equal(first?.cancel, undefined, "first firing must not be cancelled");
  // Drop post-compaction usage so the first cycle is genuinely healthy (budget
  // verify passes) — a verify failure here would pollute the verify counter.
  setLivePercent2(20);
  await pi2._emit(makeCompactEvent({ summary: "s1", firstKeptEntryId: "e70" }), ctx2);
  const before = getCompactionHealth().totalArchivesWritten;
  assert.equal(before, 1, "the successful first cycle writes one archive");

  // Second firing with IDENTICAL input -> cancelled before capture/verify.
  const second = await pi2._emit(
    { type: "session_before_compact", preparation: makePrep(branch2, "e70"), reason: "threshold" },
    ctx2,
  );
  assert.equal(second?.cancel, true, "second firing with identical input must be skipped");
  await pi2._emit(makeFailedEvent({ aborted: true }), ctx2);

  const after = getCompactionHealth();
  assert.equal(after.lastOutcome, "aborted", "skipped firing ends aborted");
  assert.equal(
    after.totalVerifyFailures,
    0,
    "fingerprint-skip must NOT increment totalVerifyFailures",
  );
  assert.equal(
    after.totalArchivesWritten,
    before,
    "fingerprint-skip must NOT increment totalArchivesWritten",
  );
});

await test("(d) resetCompactionHealth zeros both counters", async () => {
  // Build nonzero state through real scenarios: a verify failure (verify+archive)
  // plus a healthy compaction (archive).
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  const ctx2 = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi2 = makeFakePi();
  registerBeforeCompactHandler(pi2);
  registerSessionCompactOutcomeHandler(pi2);

  await startCompact(pi2, ctx2.ctx, ctx2.branch);
  ctx2.setLivePercent(20);
  await pi2._emit(
    makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e70" }),
    ctx2.ctx,
  );

  assert.ok(
    getCompactionHealth().totalVerifyFailures > 0,
    "fixture must have a nonzero verify count before reset",
  );
  assert.ok(
    getCompactionHealth().totalArchivesWritten > 0,
    "fixture must have a nonzero archive count before reset",
  );

  resetCompactionHealth();
  const health = getCompactionHealth();
  assert.equal(health.totalVerifyFailures, 0, "reset must zero totalVerifyFailures");
  assert.equal(health.totalArchivesWritten, 0, "reset must zero totalArchivesWritten");
  assert.equal(health.lastOutcome, null, "reset must clear lastOutcome");
  assert.equal(health.totalCompactions, 0, "reset must clear the success count too");
});

await test("(e) loss line reports the verify count; archives-only yields non-null archive-inclusive telemetry", async () => {
  // Verify-failed compaction -> the loss line carries both the verify rollback
  // count and the archive coverage count.
  resetCompactionHealth();
  const { ctx, branch, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await startCompact(pi, ctx, branch);
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  let line = formatCompactionLossLine();
  assert.ok(line, "loss line must be non-null when a verify rollback happened");
  assert.match(line, /verify rollbacks: 1/, "loss line must report the verify-failure count");
  assert.match(line, /archives: 1/, "loss line must report archive coverage");

  // Archives-only: a healthy compaction with zero failures. The line must stay
  // non-null (coverage is reported even with zero loss) and carry the archive
  // count — but it must NOT claim any verify rollback.
  resetCompactionHealth();
  const {
    ctx: ctx2,
    branch: branch2,
    setLivePercent: setLivePercent2,
  } = makeFakeCtx({ percent: 50, branchLength: 100 });
  const pi2 = makeFakePi();
  registerBeforeCompactHandler(pi2);
  registerSessionCompactOutcomeHandler(pi2);

  await startCompact(pi2, ctx2, branch2);
  setLivePercent2(20);
  await pi2._emit(makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e70" }), ctx2);

  const health = getCompactionHealth();
  assert.equal(health.totalFailures, 0, "healthy compaction must have zero failures");
  assert.equal(health.totalVerifyFailures, 0, "healthy compaction must have zero verify rollbacks");
  line = formatCompactionLossLine();
  assert.ok(line, "archives-only with zero failures must yield a non-null telemetry line");
  assert.match(
    line,
    /archives: 1/,
    "archive-inclusive telemetry line must report the archive count",
  );

  // And with no activity at all, the line is null (clean quick-inspector line).
  resetCompactionHealth();
  assert.equal(formatCompactionLossLine(), null, "no activity -> nothing to report (null)");
});

// Reset health after the suite so the counters don't leak into other tests.
resetCompactionHealth();

// Clean up temp dirs created by this test run (best-effort).
const base = tmpdir();
for (const n of readdirSync(base).filter((n) => n.startsWith("cm-telemetry-metrics-"))) {
  try {
    rmSync(join(base, n), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
