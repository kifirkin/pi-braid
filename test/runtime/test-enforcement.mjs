/**
 * Enforcement Extension Tests — validates sub-modules extracted from the
 * 1268L monolithic index.ts.
 *
 * Covers: similarity.ts, signals.ts, handler-registry.ts registration pattern.
 * Run: node test/runtime/test-enforcement.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const ROOT = join(import.meta.dirname, "../..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// similarity.ts
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[1] similarity.ts — text similarity + file tracking");

{
  const mod = await import("../../dist/extensions/enforcement/similarity.js");
  const { computeSimilarity, knownFiles, loadFileContent } = mod;

  test("computeSimilarity returns 1 for identical texts", () => {
    const sim = computeSimilarity("hello world", "hello world");
    assert.ok(sim >= 0.99, `expected ~1.0, got ${sim}`);
  });

  test("computeSimilarity returns 0 for completely different texts", () => {
    const sim = computeSimilarity("alpha beta gamma", "delta epsilon zeta");
    assert.equal(sim, 0);
  });

  test("computeSimilarity returns partial for overlapping texts", () => {
    const sim = computeSimilarity("line one\nline two\nline three", "line one\ndifferent two\nline four");
    assert.ok(sim > 0 && sim < 1, `expected between 0-1, got ${sim}`);
  });

  test("knownFiles is a Map", () => {
    assert.ok(knownFiles instanceof Map);
  });

  test("loadFileContent returns null for non-existent file", async () => {
    const content = await loadFileContent("/nonexistent/path/file.txt");
    assert.equal(content, null);
  });

  test("loadFileContent returns content for real file", async () => {
    const content = await loadFileContent(join(ROOT, "package.json"));
    assert.ok(content && content.includes("pi-braid"), "should read package.json content");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// signals.ts
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[2] signals.ts — enforcement signals + contrast mode");

{
  const mod = await import("../../dist/extensions/enforcement/signals.js");
  const { enforcementSignals, determineContrastMode } = mod;

  test("enforcementSignals is an object", () => {
    assert.ok(typeof enforcementSignals === "object");
    assert.ok(!Array.isArray(enforcementSignals));
  });

  test("enforcementSignals accepts entries with turn/text/acted", () => {
    enforcementSignals["memory"] = { turn: 1, text: "test signal", acted: false };
    assert.equal(enforcementSignals["memory"].text, "test signal");
    assert.equal(enforcementSignals["memory"].turn, 1);
    assert.equal(enforcementSignals["memory"].acted, false);
    // Clean up
    delete enforcementSignals["memory"];
  });
}

// ═══════════════════════════════════════════════════════════════════════
// handler-registry.ts — structure verification
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[3] handler-registry.ts — structure");

{
  const { HANDLER_REGISTRATIONS } = await import("../../dist/extensions/enforcement/handler-registry.js");

  test("exports registerHandlers function", () => {
    assert.ok(HANDLER_REGISTRATIONS, "HANDLER_REGISTRATIONS exported");
  });

  test("registers all handlers (from HANDLER_REGISTRATIONS metadata)", () => {
    assert.equal(HANDLER_REGISTRATIONS.length, 10, "expected 10 handler registrations");
  });

  test("registers input handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "input"), "input registered");
  });

  test("registers session_start handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "session_start"), "session_start registered");
  });

  test("registers tool_call handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "tool_call"), "tool_call registered");
  });

  test("registers 2 turn_end handlers (onEvent + registerTurnEndHandler)", () => {
    const turnEnds = HANDLER_REGISTRATIONS.filter((r) => r.event === "turn_end");
    assert.equal(turnEnds.length, 2, `expected 2 turn_end handlers, got ${turnEnds.length}`);
  });

  test("registers 1 message_end handler (merged conflict + analysis)", () => {
    const msgEnds = HANDLER_REGISTRATIONS.filter((r) => r.event === "message_end");
    assert.equal(msgEnds.length, 1, `expected 1 message_end, got ${msgEnds.length}`);
  });

  test("registers auto_retry_end handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "auto_retry_end"), "auto_retry_end registered");
  });

  test("registers session_compact handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "session_compact"), "session_compact registered");
  });

  test("registers session_shutdown handler", () => {
    assert.ok(HANDLER_REGISTRATIONS.some((r) => r.event === "session_shutdown"), "session_shutdown registered");
  });

  // Read source for inline heuristic checks (can't verify via metadata)
  const handlerSrc = readFileSync(join(ROOT, "src/extensions/enforcement/handler-registry.ts"), "utf-8");
  test("has _classifyRetryError helper with inline heuristic (no import)", () => {
    assert.ok(handlerSrc.includes("return \"rate_limit\""));
    assert.ok(handlerSrc.includes("return \"server_error\""));
    assert.ok(handlerSrc.includes("return \"network\""));
    assert.ok(handlerSrc.includes("return \"unknown\""));
    assert.ok(!handlerSrc.includes('from "../../../lib/error-classifier.js"'), "should not import error-classifier");
  });

  test("has extractTextContent helper", () => {
    assert.ok(handlerSrc.includes("function extractTextContent"));
  });
}

// ═══════════════════════════════════════════════════════════════════════
// index.ts — thin wrapper verification
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[4] index.ts — thin wrapper");

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
// Lazy-load verification — heavy modules should NOT be eagerly imported
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[5] Lazy-load verification");

{
  const src = readFileSync(join(ROOT, "src/extensions/enforcement/handler-registry.ts"), "utf-8");

  test("mars-reflector not eagerly imported", () => {
    assert.ok(!src.includes('from "../../lib/mars-reflector.js"'), "mars-reflector should be dynamic");
    assert.ok(src.includes('await import("../../lib/mars-reflector.js")'), "mars-reflector should be lazy");
  });

  test("dreamer not eagerly imported", () => {
    assert.ok(!src.includes('from "../../lib/dreamer.js"'), "dreamer should be dynamic");
    assert.ok(src.includes('await import("../../lib/dreamer.js")'), "dreamer should be lazy");
  });

  test("claim-tracker lazily imported from turn-end-handler.ts", () => {
    const hasAnyImport = src.includes('claim-tracker');
    assert.ok(!hasAnyImport, "claim-tracker should NOT be in handler-registry.ts (moved to turn-end-handler.ts)");
    const turnEndSrc = readFileSync(`${ROOT}/src/extensions/enforcement/handlers/turn-end-handler.ts`, "utf8");
    const hasStatic = turnEndSrc.includes('from "../../../lib/claim-tracker.js"');
    const hasDynamic = turnEndSrc.includes('await import("../../../lib/claim-tracker.js")');
    assert.ok(!hasStatic, "turn-end-handler: claim-tracker should be lazy");
    assert.ok(hasDynamic, "turn-end-handler: claim-tracker should be lazy");
  });

  test("verification-judge not eagerly imported", () => {
    assert.ok(!src.includes('from "./verification-judge.js"'), "verification-judge should be dynamic");
    assert.ok(src.includes('await import("./verification-judge.js")'), "verification-judge should be lazy");
  });

  test("judge fully removed (legacy LLM judge deleted)", () => {
    assert.ok(!src.includes('from "./judge.js"'), "judge should not be statically imported");
    assert.ok(!src.includes('await import("./judge.js")'), "judge should not be dynamically imported");
  });

  test("belief-policy-engine IS eagerly imported (used in 7+ call sites)", () => {
    assert.ok(src.includes('from "../../lib/belief-policy-engine.js"'), "belief-policy-engine should be eager");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
