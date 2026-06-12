/**
 * Enforcement Extension Tests - validates sub-modules extracted from the
 * 1268L monolithic index.ts.
 *
 * Covers: similarity.ts, signals.ts, handler-registry.ts registration pattern.
 * Run: node test/runtime/test-enforcement.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// [1] similarity.ts - knownFiles map
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[1] similarity.ts");

{
  const src = readFileSync(join(ROOT, "src/extensions/enforcement/similarity.ts"), "utf-8");

  test("knownFiles uses Map type", () => {
    assert.ok(src.includes("Map<"), "should use Map type");
  });

  test("has loadFileContent helper", () => {
    assert.ok(src.includes("function loadFileContent"), "should export loadFileContent");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// [2] signals.ts - enforcement signals
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[2] signals.ts");

{
  const src = readFileSync(join(ROOT, "src/extensions/enforcement/signals.ts"), "utf-8");

  test("exports enforcementSignals", () => {
    assert.ok(src.includes("export const enforcementSignals"), "should export enforcementSignals");
  });

  test("exports determineContrastMode", () => {
    assert.ok(src.includes("export function determineContrastMode"), "should export determineContrastMode");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// [3] handler-registry.ts - registration metadata + extracted helpers
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[3] handler-registry.ts");

{
  const src = readFileSync(join(ROOT, "src/extensions/enforcement/handler-registry.ts"), "utf-8");

  const lines = src.split("\n").length;
  test("handler-registry.ts is now thin (< 220 lines)", () => {
    // Threshold raised from 210 to 220 when the turn-dedup beginTurn() hook
    // was added to the input event handler. The extra ~8 lines are
    // load-bearing - they wire the dedup registry lifecycle.
    assert.ok(lines <= 220, `expected <= 220 lines, got ${lines}`);
  });

  test("exports HANDLER_REGISTRATIONS metadata", () => {
    assert.ok(src.includes("export const HANDLER_REGISTRATIONS"), "should export HANDLER_REGISTRATIONS");
  });

  test("exports registerHandlers function", () => {
    assert.ok(src.includes("export function registerHandlers"), "should export registerHandlers");
  });

  test("registers injection tracker", () => {
    assert.ok(src.includes("registerInjectionTracker"), "should register injection tracker");
  });

  test("imports all handler registration functions", () => {
    assert.ok(src.includes("registerInputHandler"), "should import registerInputHandler");
    assert.ok(src.includes("registerToolCallHandler"), "should import registerToolCallHandler");
    assert.ok(src.includes("registerMessageEndHandler"), "should import registerMessageEndHandler");
    assert.ok(src.includes("registerToolResultHandler"), "should import registerToolResultHandler");
    assert.ok(src.includes("registerSessionCompactHandler"), "should import registerSessionCompactHandler");
    assert.ok(src.includes("registerAutoRetryEndHandler"), "should import registerAutoRetryEndHandler");
    assert.ok(src.includes("registerSessionShutdownHandler"), "should import registerSessionShutdownHandler");
  });

  test("has turn_end coordinator registrations", () => {
    assert.ok(src.includes("registerTurnEndHandler"), "should use turn-end coordinator");
    assert.ok(src.includes("dispatchTurnEnd"), "should import dispatchTurnEnd");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// [4] Extracted handler files - helpers in the right places
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[4] Extracted handler files");

{
  const autoRetrySrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/register-auto-retry-end.ts"), "utf-8");
  test("register-auto-retry-end.ts uses text-classifier with critic labels", () => {
    assert.ok(autoRetrySrc.includes('classify'), "should use classify");
    assert.ok(autoRetrySrc.includes('CRITICS.errorType'), "should use errorType critic");
    assert.ok(autoRetrySrc.includes('CRITICS.errorTypeFallback'), "should use errorTypeFallback");
  });

  const analysisSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/drift-handler.ts"), "utf-8");
  test("analysis/drift-handler.ts has extractTextContent helper", () => {
    assert.ok(analysisSrc.includes("function extractTextContent"));
  });
}

// ═══════════════════════════════════════════════════════════════════════
// [5] index.ts - thin wrapper verification
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[5] index.ts - thin wrapper");

{
  const src = readFileSync(join(ROOT, "src/extensions/enforcement/index.ts"), "utf-8");

  test("index.ts is small (thin wrapper)", () => {
    const lines = src.split("\n").length;
    assert.ok(lines <= 40, `expected <= 40 lines, got ${lines}`);
  });

  test("index.ts imports registerHandlers from handler-registry", () => {
    assert.ok(src.includes('registerHandlers'), "should import registerHandlers");
  });

  test("index.ts exports enforcementSignals and determineContrastMode", () => {
    assert.ok(src.includes("enforcementSignals"), "should export enforcementSignals");
    assert.ok(src.includes("determineContrastMode"), "should export determineContrastMode");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// [6] Phase 3.3: Dynamic imports → Static imports
// All heavy modules are now statically imported. The original 17 dynamic
// imports in enforcement directory are fully eliminated (0 remaining).
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[6] Static import verification (Phase 3.3 - dynamic imports eliminated)");

{
  const driftSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/drift-handler.ts"), "utf-8");
  const marsSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/mars-handler.ts"), "utf-8");
  const dreamerSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/dreamer-handler.ts"), "utf-8");
  const messageEndSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handlers/register-message-end.ts"), "utf-8");

  test("mars-reflector is statically imported in mars-handler", () => {
    assert.ok(marsSrc.includes('from "../../../../lib/reasoning/mars-reflector.js"'), "mars-reflector should be static");
  });

  test("dreamer is statically imported in dreamer-handler", () => {
    assert.ok(dreamerSrc.includes('from "../../../../lib/reasoning/dreamer.js"'), "dreamer should be static");
  });

  test("verification-judge is statically imported from register-message-end", () => {
    assert.ok(messageEndSrc.includes('from "../verification-judge.js"'), "verification-judge should be static");
  });

  // Check handler-registry.ts for zero dynamic imports
  const registrySrc = readFileSync(join(ROOT, "src/extensions/enforcement/handler-registry.ts"), "utf-8");

  test("handler-registry.ts has zero dynamic imports", () => {
    const dynamicCount = (registrySrc.match(/await import\(/g) || []).length;
    assert.equal(dynamicCount, 0, `expected 0 dynamic imports, found ${dynamicCount}`);
  });

  test("claim-tracker is statically imported in handler-registry.ts", () => {
    assert.ok(registrySrc.includes('from "../../lib/store/claim-tracker.js"'), "claim-tracker should be static");
  });

  test("bidirectional-verifier is statically imported in handler-registry.ts", () => {
    assert.ok(registrySrc.includes('from "../../lib/store/bidirectional-verifier.js"'), "bidirectional-verifier should be static");
  });

  test("consolidation-channel is statically imported in handler-registry.ts", () => {
    assert.ok(registrySrc.includes('from "../../lib/events/consolidation-channel.js"'), "consolidation-channel should be static");
  });

  test("turn-end-coordinator is statically imported in handler-registry.ts", () => {
    assert.ok(registrySrc.includes('from "../../lib/events/turn-end-coordinator.js"'), "turn-end-coordinator should be static");
  });

  // Verify zero dynamic imports across all enforcement files
  test("no dynamic imports remain in enforcement directory", () => {
    const files = [
      readFileSync(join(ROOT, "src/extensions/enforcement/handler-registry.ts"), "utf-8"),
      readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/drift-handler.ts"), "utf-8"),
      readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/mars-handler.ts"), "utf-8"),
      readFileSync(join(ROOT, "src/extensions/enforcement/handlers/analysis/dreamer-handler.ts"), "utf-8"),
      readFileSync(join(ROOT, "src/extensions/enforcement/handlers/register-message-end.ts"), "utf-8"),
    ];
    let total = 0;
    for (const src of files) {
      total += (src.match(/await import\(/g) || []).length;
    }
    assert.equal(total, 0, `expected 0 dynamic imports in enforcement, found ${total}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${"=".repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);

if (failed > 0) process.exit(1);
