/**
 * Test: Degradation Detector — module import tests.
 *
 * Tests actual function behavior via module imports (not source analysis).
 */

import { ok, strictEqual, deepStrictEqual } from "assert";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

// Dynamic import to get TypeScript module (compiled to JS)
let degradationDetector;

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log("  ✅ " + msg); }
  else { failed++; console.log("  ❌ " + msg); }
};

async function main() {
  // Load the compiled JS module
  const modulePath = join(ROOT, "dist/lib/degradation-detector.js");
  degradationDetector = await import(modulePath);

  console.log("\n[1] Default Configuration");
  testDefaultConfig();

  console.log("\n[2] Update and Reset Config");
  testUpdateResetConfig();

  console.log("\n[3] Record Healthcheck Score");
  testRecordHealthcheckScore();

  console.log("\n[4] Record Turn Metrics");
  testRecordTurnMetrics();

  console.log("\n[5] Degradation Detection");
  testDegradationDetection();

  console.log("\n[6] Record Error and Tool Success");
  testRecordErrorAndSuccess();

  console.log("\n[7] Get Metrics");
  testGetMetrics();

  console.log("\n[8] Create Turn Metrics Helper");
  testCreateTurnMetrics();

  console.log("\n[9] Capture System Metrics");
  testCaptureSystemMetrics();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function testDefaultConfig() {
  const config = degradationDetector.getConfig();
  strictEqual(config.healthcheckMinScore, 80);
  strictEqual(config.errorRateMax, 0.1);
  strictEqual(config.toolSuccessMin, 70);
  strictEqual(config.maxConsecutiveErrors, 3);
  assert(true, "Default config values correct");
}

function testUpdateResetConfig() {
  // Save original
  const original = degradationDetector.getConfig();

  // Update
  degradationDetector.updateConfig({ healthcheckMinScore: 90 });
  const updated = degradationDetector.getConfig();
  strictEqual(updated.healthcheckMinScore, 90);
  assert(true, "updateConfig updates values");

  // Reset
  degradationDetector.resetConfig();
  const reset = degradationDetector.getConfig();
  strictEqual(reset.healthcheckMinScore, 80);
  assert(true, "resetConfig restores defaults");
}

function testRecordHealthcheckScore() {
  // Reset first
  degradationDetector.resetMetrics();
  degradationDetector.resetConfig();

  // Record score above threshold
  degradationDetector.recordHealthcheckScore(90);
  let degraded = degradationDetector.isDegraded();
  strictEqual(degraded, false);
  assert(true, "isDegraded false when score above threshold");

  // Record score below threshold
  degradationDetector.recordHealthcheckScore(70);
  degraded = degradationDetector.isDegraded();
  strictEqual(degraded, true);
  assert(true, "isDegraded true when score below threshold");

  // Check reasons
  const reasons = degradationDetector.getDegradationReasons();
  ok(reasons.length > 0);
  ok(reasons.some(r => r.includes("healthcheck") || r.includes("Low healthcheck")));
  assert(true, "getDegradationReasons returns healthcheck reason");
}

function testRecordTurnMetrics() {
  degradationDetector.resetMetrics();

  const metrics = {
    turnNumber: 1,
    avgTurnDurationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 10,
    errors: 2,
  };

  degradationDetector.recordTurnMetrics(metrics);

  const current = degradationDetector.getCurrentMetrics();
  ok(current !== null);
  strictEqual(current.turnNumber, 1);
  strictEqual(current.toolCalls, 10);
  strictEqual(current.errors, 2);
  // errorRate = errors / toolCalls = 2/10 = 0.2
  strictEqual(current.errorRate, 0.2);
  // toolSuccessRate = ((10-2)/10)*100 = 80
  strictEqual(current.toolSuccessRate, 80);
  assert(true, "recordTurnMetrics records correctly");
}

function testDegradationDetection() {
  degradationDetector.resetMetrics();
  degradationDetector.resetConfig();

  // Record multiple turns with high error rate
  for (let i = 0; i < 5; i++) {
    degradationDetector.recordTurnMetrics({
      turnNumber: i,
      avgTurnDurationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: 10,
      errors: 5, // 50% error rate > 10% threshold
    });
  }

  const degraded = degradationDetector.isDegraded();
  strictEqual(degraded, true);
  assert(true, "isDegraded true when error rate exceeds threshold");

  const reasons = degradationDetector.getDegradationReasons();
  ok(reasons.some(r => r.includes("error rate") || r.includes("Error rate")));
  assert(true, "Degradation reason mentions error rate");
}

function testRecordErrorAndSuccess() {
  degradationDetector.resetMetrics();

  // Record a turn
  degradationDetector.recordTurnMetrics({
    turnNumber: 1,
    avgTurnDurationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 10,
    errors: 0,
  });

  // Record an error
  degradationDetector.recordError();
  const current = degradationDetector.getCurrentMetrics();
  strictEqual(current.consecutiveErrors, 1);
  assert(true, "recordError increments consecutiveErrors");

  // Record tool success
  degradationDetector.recordToolSuccess();
  const afterSuccess = degradationDetector.getCurrentMetrics();
  strictEqual(afterSuccess.consecutiveErrors, 0);
  assert(true, "recordToolSuccess resets consecutiveErrors");
}

function testGetMetrics() {
  degradationDetector.resetMetrics();

  // Record multiple turns
  for (let i = 0; i < 5; i++) {
    degradationDetector.recordTurnMetrics({
      turnNumber: i,
      avgTurnDurationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: 10,
      errors: 0,
    });
  }

  // getRecentMetrics
  const recent = degradationDetector.getRecentMetrics(3);
  strictEqual(recent.length, 3);
  assert(true, "getRecentMetrics returns correct count");

  // getAllMetrics
  const all = degradationDetector.getAllMetrics();
  strictEqual(all.length, 5);
  assert(true, "getAllMetrics returns all metrics");

  // getMetricsSummary
  const summary = degradationDetector.getMetricsSummary();
  strictEqual(summary.totalTurns, 5);
  strictEqual(summary.degraded, false);
  ok(Array.isArray(summary.reasons));
  assert(true, "getMetricsSummary returns correct summary");
}

function testCreateTurnMetrics() {
  const metrics = degradationDetector.createTurnMetrics(
    1,    // turnNumber
    1500,  // durationMs
    200,   // inputTokens
    100,   // outputTokens
    20,    // toolCalls
    2      // errors
  );

  strictEqual(metrics.turnNumber, 1);
  strictEqual(metrics.avgTurnDurationMs, 1500);
  strictEqual(metrics.inputTokens, 200);
  strictEqual(metrics.outputTokens, 100);
  strictEqual(metrics.toolCalls, 20);
  strictEqual(metrics.errors, 2);
  strictEqual(metrics.errorRate, 0.1); // 2/20
  strictEqual(metrics.toolSuccessRate, 90); // ((20-2)/20)*100
  ok(metrics.memoryUsagePercent >= 0);
  assert(true, "createTurnMetrics creates correct metrics object");
}

function testCaptureSystemMetrics() {
  const sysMetrics = degradationDetector.captureSystemMetrics();
  ok(sysMetrics.memoryUsagePercent >= 0);
  ok(sysMetrics.memoryUsagePercent <= 100);
  assert(true, "captureSystemMetrics returns valid memory usage");
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
