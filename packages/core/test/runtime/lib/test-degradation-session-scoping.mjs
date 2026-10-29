/**
 * Regression test: per-session degradation scoping.
 *
 * Root cause: getStateFrom(ctx) seeded a NEW session's enforcement state
 * with `{ ..._global }` — the process-global mirror loaded from the 30-day
 * degradation.json (~/.pi/agent/braid/metrics/). A fresh session therefore
 * started with the PREVIOUS sessions' stale error metrics: the enforcement
 * errorRate trajectory was poisoned from turn 1 and drove false-positive
 * degradation verdicts / rollbacks (the watchdog false-positive).
 *
 * PER-SESSION scoping. Enforcement reacts to
 * the CURRENT session's error history; the 30-day degradation.json stays on
 * disk for analysis/telemetry (live session writes are mirrored back into
 * _global via mirrorToGlobal), but must not seed another session's
 * enforcement state.
 *
 * Pins four invariants:
 * 1. A polluted-but-scalar degradation.json loads into the TELEMETRY
 * mirror (_global) — getAllMetrics() (no ctx) keeps its entries.
 * 2. A NEW session (ctx) starts CLEAN: zero metrics, not degraded, no
 * reasons — despite the poisoned file on disk. (Revert-proof: pre-fix
 * the session inherited all 40 stale entries.)
 * 3. Config still carries over from the loaded file (operator-tuned
 * thresholds are not history).
 * 4. Live session writes stay session-local AND keep the telemetry file
 * warm: the recorded entry appears in the session AND is mirrored into
 * _global; a second session still starts clean (no cross-session
 * bleed within the process).
 *
 * Fixture style: HOME redirect BEFORE the first dist import (braid-paths
 * resolves DEGRADATION_FILE from os.homedir() at module-eval), mirroring
 * test-degradation-load-sanitize.mjs.
 *
 * Run: node test/runtime/lib/test-degradation-session-scoping.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpBase = mkdtempSync(join(tmpdir(), "degradation-scoping-"));
process.env.HOME = tmpBase; // must precede the dist imports below

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const {
  loadMetrics,
  saveMetrics,
  getAllMetrics,
  getMetricsSummary,
  getConfig,
  isDegraded,
  recordTurnMetrics,
  getRecentMetrics,
} = await import(join(ROOT, "dist/lib/detection/degradation-detector.js"));
const { DEGRADATION_FILE, METRICS_DIR } = await import(
  join(ROOT, "dist/lib/config/braid-paths.js")
);

assert.ok(DEGRADATION_FILE.startsWith(tmpBase), "DEGRADATION_FILE redirected to tmp HOME");

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => sessionId,
      getSessionId: () => sessionId,
    },
  };
}

/** A scalar-valid metrics entry with BAD health numbers (poison vector). */
function poisonedEntry(turnNumber) {
  return {
    turnNumber,
    avgTurnDurationMs: 1000,
    toolCalls: 4,
    errors: 2,
    inputTokens: 100,
    outputTokens: 50,
    errorRate: 0.5,
    toolSuccessRate: 30,
    memoryUsagePercent: 40,
    consecutiveErrors: 2,
    tokenUsage: { input: 100, output: 50 },
    timestamp: Date.now(),
    healthcheckScore: 60,
  };
}

test("polluted degradation.json seeds the TELEMETRY mirror but NOT a new session", async () => {
  mkdirSync(METRICS_DIR, { recursive: true });
  writeFileSync(
    DEGRADATION_FILE,
    JSON.stringify({
      metrics: Array.from({ length: 40 }, (_, i) => poisonedEntry(i + 1)),
      config: { healthcheckMinScore: 70 },
      isDegraded: true,
      lastHealthcheck: { score: 10, timestamp: Date.now() - 1000 },
    }),
    "utf-8",
  );

  await loadMetrics();

  // 1. Telemetry mirror keeps the loaded 30-day history (file still feeds
  // analysis) — the entries are scalar-valid so sanitize keeps them.
  assert.equal(getAllMetrics().length, 40, "telemetry mirror keeps the loaded history");
  assert.equal(getMetricsSummary().degraded, true, "global mirror is degraded (as the file says)");

  // 2. A NEW session starts CLEAN despite the poisoned file (the fix).
  const ctx = makeCtx("scoping-fresh-session");
  const summary = getMetricsSummary(ctx);
  assert.equal(summary.totalTurns, 0, "new session inherits NO stale metrics");
  assert.equal(summary.degraded, false, "new session is not degraded");
  assert.deepEqual(summary.reasons, [], "no degradation reasons from stale history");
  assert.equal(isDegraded(ctx), false);

  // 3. Config still carries over (thresholds are not history).
  assert.equal(getConfig(ctx).healthcheckMinScore, 70, "operator config carried over");

  // 4. Session-local write: lands in the session, NOT in another session.
  recordTurnMetrics(ctx, {
    turnNumber: 1,
    avgTurnDurationMs: 50,
    toolCalls: 2,
    errors: 0,
    inputTokens: 10,
    outputTokens: 5,
    errorRate: 0,
    toolSuccessRate: 100,
    consecutiveErrors: 0,
    tokenUsage: { input: 10, output: 5 },
    memoryUsagePercent: 40,
  });
  const after = getMetricsSummary(ctx);
  assert.equal(after.totalTurns, 1, "session sees its own write");
  assert.equal(after.degraded, false, "clean write keeps the session healthy");
  assert.equal(getRecentMetrics(ctx, 1)[0].toolCalls, 2);

  // Telemetry mirror received the live entry (file stays warm).
  assert.equal(getAllMetrics().length, 41, "live entry mirrored into the 30-day telemetry");

  // 5. A SECOND session still starts clean (no cross-session bleed).
  const ctx2 = makeCtx("scoping-second-session");
  assert.equal(getMetricsSummary(ctx2).totalTurns, 0, "second session also clean");
  assert.equal(isDegraded(ctx2), false);

  // saveMetrics persists the mirror (parseable, still 41 entries).
  await saveMetrics();
  const { readFileSync } = await import("node:fs");
  const onDisk = JSON.parse(readFileSync(DEGRADATION_FILE, "utf-8"));
  assert.equal(onDisk.metrics.length, 41, "telemetry file keeps accumulating");
});

test("cleanup", () => {
  rmSync(tmpBase, { recursive: true, force: true });
});
