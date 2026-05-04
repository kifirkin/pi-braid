/**
 * Test: Degradation Detector — performance monitoring and degradation detection.
 *
 * Tests file structure, function signatures, and logic via source analysis.
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] File exists and exports expected functions ─────────────────
console.log("\n[1] Degradation detector structure");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // Core API functions
  assert(src.includes("export function isDegraded"), "exports isDegraded()");
  assert(src.includes("export function getDegradationReasons"), "exports getDegradationReasons()");
  assert(src.includes("export function recordTurnMetrics"), "exports recordTurnMetrics()");
  assert(src.includes("export function recordHealthcheckScore"), "exports recordHealthcheckScore()");
  assert(src.includes("export function recordError"), "exports recordError()");
  assert(src.includes("export function recordToolSuccess"), "exports recordToolSuccess()");
  assert(src.includes("export function getConfig"), "exports getConfig()");
  assert(src.includes("export function updateConfig"), "exports updateConfig()");
  assert(src.includes("export function resetConfig"), "exports resetConfig()");
  assert(src.includes("export function getCurrentMetrics"), "exports getCurrentMetrics()");
  assert(src.includes("export function getRecentMetrics"), "exports getRecentMetrics()");
  assert(src.includes("export function getAllMetrics"), "exports getAllMetrics()");
  assert(src.includes("export function getMetricsSummary"), "exports getMetricsSummary()");
  assert(src.includes("export function createTurnMetrics"), "exports createTurnMetrics()");
  assert(src.includes("export function captureSystemMetrics"), "exports captureSystemMetrics()");
  assert(src.includes("export function resetMetrics"), "exports resetMetrics()");
  assert(src.includes("export async function saveMetrics"), "exports saveMetrics()");
  assert(src.includes("export async function loadMetrics"), "exports loadMetrics()");
}

// ── [2] Interfaces and types ──────────────────────────────────────
console.log("\n[2] Interfaces and types");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  assert(src.includes("interface PerformanceMetrics"), "Defines PerformanceMetrics interface");
  assert(src.includes("interface DegradationConfig"), "Defines DegradationConfig interface");
  assert(src.includes("interface DegradationState"), "Defines DegradationState interface");

  // PerformanceMetrics fields
  assert(src.includes("turnNumber:"), "PerformanceMetrics has turnNumber");
  assert(src.includes("errorRate:"), "PerformanceMetrics has errorRate");
  assert(src.includes("toolSuccessRate:"), "PerformanceMetrics has toolSuccessRate");
  assert(src.includes("consecutiveErrors:"), "PerformanceMetrics has consecutiveErrors");
  assert(src.includes("memoryUsagePercent:"), "PerformanceMetrics has memoryUsagePercent");
  assert(src.includes("avgTurnDurationMs:"), "PerformanceMetrics has avgTurnDurationMs");

  // DegradationConfig fields
  assert(src.includes("healthcheckMinScore:"), "DegradationConfig has healthcheckMinScore");
  assert(src.includes("errorRateMax:"), "DegradationConfig has errorRateMax");
  assert(src.includes("toolSuccessMin:"), "DegradationConfig has toolSuccessMin");
  assert(src.includes("maxConsecutiveErrors:"), "DegradationConfig has maxConsecutiveErrors");
}

// ── [3] Default configuration ───────────────────────────────────────
console.log("\n[3] Default configuration");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  assert(src.includes("healthcheckMinScore: 80"), "default healthcheckMinScore = 80");
  assert(src.includes("errorRateMax: 0.1"), "default errorRateMax = 0.1");
  assert(src.includes("toolSuccessMin: 70"), "default toolSuccessMin = 70");
  assert(src.includes("maxConsecutiveErrors: 3"), "default maxConsecutiveErrors = 3");
}

// ── [4] Degradation detection logic ──────────────────────────────────
console.log("\n[4] Degradation detection logic");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // Check that updateDegradationStatusFrom checks all 4 conditions
  assert(src.includes("consecutiveErrors >= state.config.maxConsecutiveErrors"),
    "Checks consecutive errors threshold");
  assert(src.includes("avgErrorRate > state.config.errorRateMax"),
    "Checks error rate threshold");
  assert(src.includes("avgToolSuccess < state.config.toolSuccessMin"),
    "Checks tool success threshold");
  assert(src.includes("lastHealthcheck.score < state.config.healthcheckMinScore"),
    "Checks healthcheck score threshold");

  // Check the sliding window is 5
  const recent5 = src.match(/recent = s\.metrics\.slice\(-5\)/);
  assert(recent5 !== null, "Uses sliding window of 5 recent metrics");
}

// ── [5] Overloaded function patterns ────────────────────────────────
console.log("\n[5] Overloaded function patterns (ctx-aware)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  assert(src.includes("export function recordHealthcheckScore(score: number): void;"),
    "recordHealthcheckScore overload (no ctx)");
  assert(src.includes("export function recordHealthcheckScore(ctx: ExtensionContext, score: number): void;"),
    "recordHealthcheckScore overload (with ctx)");

  assert(src.includes("export function updateConfig(partial: Partial<DegradationConfig>): void;"),
    "updateConfig overload (no ctx)");
  assert(src.includes("export function updateConfig(ctx: ExtensionContext, partial: Partial<DegradationConfig>): void;"),
    "updateConfig overload (with ctx)");
}

// ── [6] createTurnMetrics calculation logic ─────────────────────────
console.log("\n[6] createTurnMetrics logic");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // toolSuccessRate = ((toolCalls - errors) / toolCalls) * 100
  assert(src.includes("((toolCalls - errors) / toolCalls) * 100"),
    "toolSuccessRate calculated correctly");

  // errorRate = errors / toolCalls
  assert(src.includes("errors / toolCalls"), "errorRate calculated correctly");

  // Default toolSuccessRate for zero toolCalls
  assert(src.includes("toolSuccessRate: toolCalls > 0"),
    "handles toolCalls > 0 guard");
}

// ── [7] Metrics storage limits ─────────────────────────────────────
console.log("\n[7] Metrics storage limits");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // Max 100 metrics stored
  assert(src.includes("s.metrics.length > 100"), "Limits storage to 100 metrics");
  assert(src.includes("s.metrics.slice(-100)"), "Slides window to last 100");
}

// ── [8] Session-scoped state integration ─────────────────────────────
console.log("\n[8] Session-scoped state integration");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // Uses getExtensionState
  assert(src.includes('getExtensionState(ctx, "degradation-detector"'),
    "Uses getExtensionState for session-scoped state");

  // Global fallback
  assert(src.includes("let _global:"), "Has global fallback state");
}

// ── [9] Error handling ─────────────────────────────────────────────
console.log("\n[9] Error handling");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  // saveMetrics has try-catch
  assert(src.includes("saveMetrics(): Promise<void>"), "saveMetrics exists");
  assert(src.includes("catch (error)"), "saveMetrics has error handling");

  // loadMetrics has try-catch
  assert(src.includes("loadMetrics(): Promise<void>"), "loadMetrics exists");
  assert(src.includes("catch (error)"), "loadMetrics has error handling");
}

// ── [10] File persistence ──────────────────────────────────────────
console.log("\n[10] File persistence");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  assert(src.includes("METRICS_FILE"), "Defines METRICS_FILE path");
  assert(src.includes('"metrics", "degradation.json"'),
    "Metrics file path includes degradation.json");
  assert(src.includes("saveStateImmediate"), "Uses saveStateImmediate for persistence");
}

// ── [11] captureSystemMetrics ──────────────────────────────────────
console.log("\n[11] captureSystemMetrics");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/degradation-detector.ts`, "utf8");

  assert(src.includes("export function captureSystemMetrics()"),
    "captureSystemMetrics is exported");
  assert(src.includes("memoryUsagePercent"), "Captures memoryUsagePercent");
  assert(src.includes("os.freemem()"), "Uses os.freemem()");
  assert(src.includes("os.totalmem()"), "Uses os.totalmem()");
}

// ── Report ────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
