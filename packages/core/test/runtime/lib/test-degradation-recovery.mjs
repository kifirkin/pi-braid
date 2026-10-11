/**
 * Regression test: degradation verdict recovery + provider attribution.
 *
 * Root cause: the degradation verdict consumed the session-CUMULATIVE error
 * share (errors/toolCalls over the whole trajectory). The share decays
 * asymptotically, so a resolved error storm kept the verdict negative for
 * dozens of clean turns (a live whisper fired 23 minutes into
 * a healthy session because 3 overnight errors held the cumulative rate
 * above 10%). Compounding it, the storm clause used
 * `recent.some(m => m.consecutiveErrors >= max)` — ONE stale storm entry
 * kept the session degraded while the newest entry had consecutiveErrors 0.
 * And auto-recovery fired a generic agent-degradation whisper for what was
 * actually a provider outage (session-health mode != healthy).
 *
 * Pins five invariants:
 * 1. Evidence pattern: high cumulative share, clean trailing entries →
 *    healthy verdict, no reasons (pre-fix: DEGRADED).
 * 2. A live storm still trips: newest entry consecutiveErrors >= 3 →
 *    degraded with the consecutive-errors reason.
 * 3. Recovery boundary: 1 clean entry after a storm → still degraded
 *    (window still dirty); 2 consecutive clean entries → healthy.
 * 4. Attribution: session-health mode != healthy → the whisper names the
 *    external cause and recommends NO health-checking or re-planning;
 *    healthy mode → agent-degradation whisper (unchanged).
 * 5. Feed honesty: the verdict is driven by the trailing window (deltas),
 *    never by the asymptotically decaying cumulative share.
 *
 * Fixture style: HOME redirect BEFORE the first dist import (braid-paths
 * resolves DEGRADATION_FILE from os.homedir() at module-eval), mirroring
 * test-degradation-session-scoping.mjs.
 *
 * Run: node test/runtime/lib/test-degradation-recovery.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpBase = mkdtempSync(join(tmpdir(), "degradation-recovery-"));
process.env.HOME = tmpBase; // must precede the dist imports below

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { isDegraded, getDegradationReasons, recordTurnMetrics, resetMetrics } = await import(
  join(ROOT, "dist/lib/detection/degradation-detector.js")
);
const { buildDegradationWhisper } = await import(
  join(ROOT, "dist/extensions/self/auto-recovery/index.js")
);

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => sessionId,
      getSessionId: () => sessionId,
    },
  };
}

/** Heartbeat-shaped entry: cumulative errors/toolCalls like the real feed
 *  (totalToolsUsed / trajectory error totals), plus the trailing-error
 *  streak the scheduler counts at snapshot time. */
function entry(turnNumber, toolCalls, errors, consecutiveErrors, errorRate) {
  return {
    turnNumber,
    avgTurnDurationMs: 1000,
    toolCalls,
    errors,
    inputTokens: 100,
    outputTokens: 50,
    errorRate: errorRate ?? (toolCalls > 0 ? errors / toolCalls : 0),
    toolSuccessRate: toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100,
    memoryUsagePercent: 40,
    consecutiveErrors,
    tokenUsage: { input: 100, output: 50 },
  };
}

function feed(ctx, entries) {
  for (const e of entries) recordTurnMetrics(ctx, e);
}

test("evidence pattern: stale cumulative rate, clean newest entry → healthy", () => {
  const ctx = makeCtx("stale-evidence");
  resetMetrics(ctx);
  // Live telemetry mirror, abridged: an overnight provider storm left
  // 3 errors in the trajectory; the newest heartbeat snapshots are clean.
  feed(ctx, [
    entry(2, 8, 0, 0), // pre-storm healthy warm-up
    entry(5, 12, 2, 1), // 0.1667 cumulative
    entry(10, 20, 3, 0), // 0.1500 — the whisper fired on this state
    entry(12, 23, 3, 0), // 0.1304
    entry(16, 28, 3, 0), // 0.1071 — still above the 10% threshold
  ]);

  // Cumulative share is 10.7% and the 5-entry average of the errorRate
  // fields is ~13.8% — both above errorRateMax. The verdict must NOT be
  // degraded: the newest entry is clean and no errors are recent.
  assert.equal(isDegraded(ctx), false, "clean newest entries must clear the verdict");
  const reasons = getDegradationReasons(ctx);
  assert.equal(
    reasons.some((r) => /error rate|consecutive/i.test(r)),
    false,
    `no cumulative-history reasons, got: ${JSON.stringify(reasons)}`,
  );
});

test("live storm still trips: newest entry consecutiveErrors >= 3", () => {
  const ctx = makeCtx("live-storm");
  resetMetrics(ctx);
  feed(ctx, [
    entry(1, 4, 0, 0),
    entry(2, 7, 1, 1),
    entry(3, 9, 2, 2),
    entry(4, 10, 3, 3), // trailing streak at the threshold — still firing
    entry(5, 12, 5, 5),
  ]);

  assert.equal(isDegraded(ctx), true, "a genuine storm must still trip");
  const reasons = getDegradationReasons(ctx);
  assert.ok(
    reasons.some((r) => /consecutive/i.test(r)),
    `storm reason must name consecutive errors, got: ${JSON.stringify(reasons)}`,
  );
});

test("recovery boundary: 1 clean entry stays degraded, 2 clear it", () => {
  const ctx = makeCtx("recovery-boundary");
  resetMetrics(ctx);
  feed(ctx, [
    entry(1, 6, 0, 0),
    entry(2, 9, 1, 1),
    entry(3, 11, 3, 3), // storm entry
    entry(4, 14, 3, 0), // first clean snapshot — window still carries the storm
  ]);
  assert.equal(isDegraded(ctx), true, "one clean entry must not clear the verdict yet");

  recordTurnMetrics(
    ctx,
    entry(5, 17, 3, 0), // second consecutive clean snapshot
  );
  assert.equal(isDegraded(ctx), false, "two consecutive clean entries clear the verdict");
  assert.deepEqual(
    getDegradationReasons(ctx).filter((r) => /error rate|consecutive/i.test(r)),
    [],
    "no stale storm reasons after recovery",
  );
});

test("attribution: provider session-health mode names the external cause", () => {
  const external = buildDegradationWhisper(["High error rate: 20.8%"], "balance");
  assert.match(external, /balance/i, "external whisper names the session-health mode");
  assert.match(external, /provider|external/i, "external whisper labels the cause as external");
  assert.doesNotMatch(
    external,
    /re-plan|different approach|health_maintenance/i,
    "external whisper must not recommend health-checking or re-planning",
  );

  const agent = buildDegradationWhisper(["High error rate: 20.8%"], "healthy");
  assert.match(agent, /health_maintenance/i, "agent whisper keeps the self-check advice");
  assert.match(agent, /re-plan|different approach/i, "agent whisper keeps the re-plan advice");
});

test("cleanup", () => {
  rmSync(tmpBase, { recursive: true, force: true });
});
