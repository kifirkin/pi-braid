/**
 * Regression test: degradation-detector sanitize-on-load + async-storage
 * load-side size seatbelt (OOM follow-up).
 *
 * Root cause: the write side whitelists via toScalarEntry (see
 * test-degradation-ctx-guard.mjs), but loadMetrics() had NO filter — a
 * polluted degradation.json on disk (~508MB of credential-carrying,
 * ctx-shaped metric entries after the 0.84.4 isCtx break) was JSON-parsed
 * and spread straight into _global at startup, then re-stringified on
 * every heartbeat. Likewise loadState() read and parsed a file of ANY size.
 *
 * Pins three invariants:
 * 1. loadMetrics() rebuilds state through the whitelist: only scalar,
 * fresh (<= 30d) metric entries survive, capped to the LAST 100;
 * polluted (nested / huge-string / non-array-shaped) and stale
 * entries are DROPPED; the file on disk is left untouched; unknown
 * top-level keys and non-scalar config fields never reach _global.
 * 2. loadState() refuses to read state files above the 10MB bound —
 * returns null without throwing.
 * 3. A clean file loads unchanged (no over-filtering: valid scalar
 * entries survive with their values, config round-trips).
 *
 * Fixture style: dist-module behavioral tests (see header of
 * test-call-llm-behavior.mjs). The HOME env override must happen BEFORE
 * the first dist import: braid-paths.ts resolves DEGRADATION_FILE from
 * os.homedir() at module-eval, so redirecting $HOME redirects the file
 * loadMetrics() reads to a throwaway tmp tree instead of real user state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpBase = mkdtempSync(join(tmpdir(), "degradation-load-sanitize-"));
process.env.HOME = tmpBase; // must precede the dist imports below

const { loadMetrics, getAllMetrics, getConfig, getMetricsSummary, getDegradationReasons } =
  await import(`../../../dist/lib/detection/degradation-detector.js`);
const { loadState } = await import(`../../../dist/lib/state/async-storage.js`);
const { DEGRADATION_FILE, METRICS_DIR } = await import(`../../../dist/lib/config/braid-paths.js`);
const { clearLogBuffer, getLogBuffer } = await import(`../../../dist/lib/core/logger.js`);

// Sanity: the HOME override actually redirected the degradation file away
// from real user state — never run this suite against ~/.pi.
assert.ok(DEGRADATION_FILE.startsWith(tmpBase), "DEGRADATION_FILE redirected to tmp HOME");
assert.equal(DEGRADATION_FILE, join(tmpBase, ".pi/agent/braid/metrics/degradation.json"));

const TEST_START = Date.now();

/** A fully valid scalar PerformanceMetrics entry (write-side shape). */
function scalarEntry(turnNumber, overrides = {}) {
  return {
    turnNumber,
    avgTurnDurationMs: 100,
    toolCalls: 2,
    errors: 0,
    inputTokens: 10,
    outputTokens: 20,
    errorRate: 0,
    toolSuccessRate: 100,
    memoryUsagePercent: 40,
    consecutiveErrors: 0,
    tokenUsage: { input: 10, output: 20 },
    timestamp: Date.now(),
    healthcheckScore: 95,
    ...overrides,
  };
}

function metricsDir() {
  mkdirSync(METRICS_DIR, { recursive: true });
  return METRICS_DIR;
}

test("loadMetrics: polluted file is sanitized — scalar-only, <=100 entries, file untouched", async () => {
  metricsDir(); // creates the metrics dir (side effect)
  const polluted = {
    metrics: [
      scalarEntry(1),
      scalarEntry(2, { healthcheckScore: 90 }),
      // ctx pollution signature: nested provider/session objects.
      {
        turnNumber: 3,
        timestamp: Date.now(),
        sessionManager: { sessionId: "s1", fileEntries: [{ type: "session" }] },
        modelRegistry: { credentials: { key: "sk-or-v1-SECRET" } },
        ui: { nested: { deeper: true } },
      },
      // huge string inside an entry (3MB) — pollution signature.
      scalarEntry(4, { note: "x".repeat(3 * 1024 * 1024) }),
      // non-object entries.
      [1, 2, 3],
      "garbage",
      // stale scalar entry (40 days old) — pre-purge pollution.
      scalarEntry(5, { timestamp: Date.now() - 40 * 24 * 60 * 60 * 1000 }),
    ],
    config: { healthcheckMinScore: 33, checkIntervalMs: "60", evilKey: { nested: true } },
    isDegraded: "yes", // string, not boolean — must not be copied
    // shape-invalid: if the object were taken despite the non-numeric
    // timestamp, its numeric score 20 would flag "Low healthcheck"against
    // the default min 80 — the absence of that reason below proves the
    // shape check fired.
    lastHealthcheck: { score: 20, timestamp: "not-a-number" },
    unknownTopLevel: { credential: "material" }, // must NEVER reach _global
  };
  const file = DEGRADATION_FILE;
  const before = JSON.stringify(polluted);
  writeFileSync(file, before, "utf-8");

  clearLogBuffer();
  await loadMetrics();

  const metrics = getAllMetrics();
  assert.equal(metrics.length, 2, "only the two fresh scalar entries survive");
  assert.equal(metrics[0].turnNumber, 1);
  assert.equal(metrics[1].turnNumber, 2);
  for (const m of metrics) {
    assert.equal(typeof m.timestamp, "number");
    assert.ok(m.timestamp >= TEST_START, "rebuilt entries carry fresh timestamps");
    assert.equal(typeof m.errorRate, "number");
    assert.equal(typeof m.toolSuccessRate, "number");
    assert.equal(typeof m.tokenUsage.input, "number");
    assert.equal(typeof m.tokenUsage.output, "number");
  }
  // Valid values survive the rebuild.
  assert.equal(metrics[0].toolCalls, 2);
  assert.equal(metrics[0].avgTurnDurationMs, 100);
  assert.equal(metrics[0].tokenUsage.input, 10);
  assert.equal(metrics[0].healthcheckScore, 95);

  // No pollution signatures anywhere in in-memory state.
  const blob = JSON.stringify({ metrics: getAllMetrics(), summary: getMetricsSummary() });
  assert.ok(!blob.includes("sessionManager"), "no sessionManager graph in memory");
  assert.ok(!blob.includes("fileEntries"), "no session fileEntries in memory");
  assert.ok(!blob.includes("modelRegistry"), "no modelRegistry in memory");
  assert.ok(!blob.includes("sk-or-v1"), "no credentials in memory");
  assert.ok(!blob.includes("unknownTopLevel"), "unknown top-level keys never copied");

  // Config: known numeric field kept, non-numeric fell back to default,
  // unknown key dropped.
  const cfg = getConfig();
  assert.equal(cfg.healthcheckMinScore, 33);
  assert.equal(cfg.checkIntervalMs, 60000);
  assert.ok(!("evilKey" in cfg));

  // isDegraded: non-boolean in file -> previous default (false) kept.
  assert.equal(getMetricsSummary().degraded, false);
  // lastHealthcheck: shape-invalid in file -> not taken (a taken
  // {score: 20} would flag "Low healthcheck"against the default min 80).
  assert.ok(
    !getDegradationReasons().some((r) => r.includes("Low healthcheck")),
    "shape-invalid lastHealthcheck must not leak into state",
  );

  // The file on disk is untouched (load is read-only).
  assert.equal(readFileSync(file, "utf-8"), before, "polluted file must not be rewritten");

  // Count-only warn was emitted (no entry content in the log line).
  const log = getLogBuffer()
    .map((e) => `${e.level}:${e.message}`)
    .join("\n");
  assert.ok(log.includes("sanitized"), "sanitize warn logged");
  assert.ok(log.includes("dropped 5"), "dropped count reported");
  assert.ok(!log.includes("sk-or-v1"), "log carries no dropped content");
});

test("loadMetrics: caps to the LAST 100 scalar entries (write-side cap)", async () => {
  writeFileSync(
    DEGRADATION_FILE,
    JSON.stringify({ metrics: Array.from({ length: 150 }, (_, i) => scalarEntry(i + 1)) }),
    "utf-8",
  );
  await loadMetrics();
  const metrics = getAllMetrics();
  assert.equal(metrics.length, 100);
  assert.equal(metrics[0].turnNumber, 51, "first kept entry is the 51st of 150");
  assert.equal(metrics[99].turnNumber, 150, "last kept entry is the newest");
});

test("loadState: oversize file (>10MB) returns null without throwing", async () => {
  const bigFile = join(metricsDir(), "oversize-state.json");
  writeFileSync(bigFile, "x".repeat(11 * 1024 * 1024), "utf-8"); // 11MB > 10MB bound
  let result;
  await assert.doesNotReject(async () => {
    result = await loadState(bigFile);
  });
  assert.equal(result, null, "oversized state file is refused, not read");
});

test("loadMetrics: clean file loads unchanged (no over-filtering)", async () => {
  const clean = {
    metrics: [
      scalarEntry(1, { healthcheckScore: 88, errors: 1, errorRate: 0.5, toolSuccessRate: 50 }),
      scalarEntry(2, { healthcheckScore: 91 }),
    ],
    config: {
      healthcheckMinScore: 70,
      errorRateMax: 0.2,
      toolSuccessMin: 60,
      checkIntervalMs: 30000,
      maxConsecutiveErrors: 5,
    },
    isDegraded: true,
    lastHealthcheck: { score: 50, timestamp: Date.now() - 1000 },
  };
  writeFileSync(DEGRADATION_FILE, JSON.stringify(clean), "utf-8");
  await loadMetrics();

  const metrics = getAllMetrics();
  assert.equal(metrics.length, 2, "both valid entries survive");
  assert.equal(metrics[0].healthcheckScore, 88);
  assert.equal(metrics[0].errorRate, 0.5);
  assert.equal(metrics[0].toolSuccessRate, 50);
  assert.equal(metrics[1].healthcheckScore, 91);

  const cfg = getConfig();
  assert.deepEqual(cfg, clean.config, "full config round-trips");

  const state = getMetricsSummary();
  assert.equal(state.degraded, true, "boolean isDegraded round-trips");
  assert.ok(
    getDegradationReasons().some((r) => r.includes("Low healthcheck: 50%")),
    "valid lastHealthcheck round-trips (score 50 < min 70 flags a reason)",
  );
});

test("cleanup", () => {
  rmSync(tmpBase, { recursive: true, force: true });
});
