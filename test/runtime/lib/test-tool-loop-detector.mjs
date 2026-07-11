/**
 * Test: tool-loop-detector - single source of truth for tool-loop detection.
 *
 * Verifies the consolidated detector that replaces 3 overlapping
 * detectors (turn-outcome LLM, dreamer tailRun, policy-rules
 * reflection_gap). The test focuses on the pure functions (no
 * ExtensionContext needed) plus a behavioral test via the
 * compiled module.
 *
 * The detector is in src/lib/detection/tool-loop-detector.ts.
 * Constants: TOOL_LOOP_THRESHOLD=16, TOOL_LOOP_WINDOW=20,
 * TOOL_LOOP_COOLDOWN_TURNS=8.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC_PATH = join(ROOT, "src/lib/detection/tool-loop-detector.ts");
const DIST_PATH = join(ROOT, "dist/lib/detection/tool-loop-detector.js");

assert.ok(existsSync(SRC_PATH), "tool-loop-detector source must exist");
const src = readFileSync(SRC_PATH, "utf-8");

console.log("=== tool-loop-detector tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  [x] ${name}: ${e.message}`);
      failed++;
    });
}

// ── Constants exported and consistent ──────────────────────────────────────

await test("exports TOOL_LOOP_THRESHOLD = 16", () => {
  assert.match(src, /export\s+const\s+TOOL_LOOP_THRESHOLD\s*=\s*16\b/);
});

await test("exports TOOL_LOOP_WINDOW = 20", () => {
  assert.match(src, /export\s+const\s+TOOL_LOOP_WINDOW\s*=\s*20\b/);
});

await test("exports TOOL_LOOP_COOLDOWN_TURNS = 8", () => {
  assert.match(src, /export\s+const\s+TOOL_LOOP_COOLDOWN_TURNS\s*=\s*8\b/);
});

// ── Pure function behavior (no LLM, no ctx) ─────────────────────────────────

await test("createToolLoopState returns fresh state", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  assert.deepStrictEqual(s.history, []);
  assert.strictEqual(s.lastFiredAtTurn, -1);
  assert.strictEqual(s.turnCount, 0);
});

await test("recordToolCall appends and trims to WINDOW", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 30; i++) m.recordToolCall(s, `tool-${i}`);
  assert.strictEqual(s.history.length, 20, "history capped at TOOL_LOOP_WINDOW (20)");
  // Most recent 20 should be tool-10 through tool-29
  assert.strictEqual(s.history[0], "tool-10");
  assert.strictEqual(s.history[19], "tool-29");
});

await test("recordToolCall ignores empty tool names", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  m.recordToolCall(s, "");
  m.recordToolCall(s, undefined);
  assert.strictEqual(s.history.length, 0);
});

await test("detectToolLoop returns isLoop=false when history is short", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  // 15 same-tool calls (below threshold of 16)
  for (let i = 0; i < 15; i++) m.recordToolCall(s, "read");
  const r = m.detectToolLoop(s);
  assert.strictEqual(r.isLoop, false);
});

await test("detectToolLoop returns isLoop=true at exactly 16 consecutive", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "read");
  const r = m.detectToolLoop(s);
  assert.strictEqual(r.isLoop, true);
  assert.strictEqual(r.tool, "read");
  assert.strictEqual(r.count, 16);
  assert.match(r.message, /## Tool Loop Detected/);
  assert.match(r.message, /`read`/);
  assert.match(r.message, /16 times in a row/);
});

await test("detectToolLoop only counts the tail (interruption breaks streak)", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  // 15 reads, 1 bash, 15 more reads -> tail is 15, not 30
  for (let i = 0; i < 15; i++) m.recordToolCall(s, "read");
  m.recordToolCall(s, "bash");
  for (let i = 0; i < 15; i++) m.recordToolCall(s, "read");
  const r = m.detectToolLoop(s);
  assert.strictEqual(r.isLoop, false, "tail is only 15, not 16");
});

await test("detectToolLoop respects cooldown after markLoopFired", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "read");
  // First call fires
  const r1 = m.detectToolLoop(s);
  assert.strictEqual(r1.isLoop, true);
  m.markLoopFired(s);
  m.recordTurnEnd(s);
  // Second call within cooldown should NOT fire
  const r2 = m.detectToolLoop(s);
  assert.strictEqual(r2.isLoop, false, "in cooldown");
});

await test("detectToolLoop fires again after cooldown elapses", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "read");
  const r1 = m.detectToolLoop(s);
  assert.strictEqual(r1.isLoop, true);
  m.markLoopFired(s);
  // Simulate 8 turns passing (cooldown is 8)
  for (let i = 0; i < 8; i++) m.recordTurnEnd(s);
  // Still in loop? Add more reads to be sure
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "read");
  const r2 = m.detectToolLoop(s);
  assert.strictEqual(r2.isLoop, true, "after cooldown, can fire again");
});

await test("detectToolLoop message format is unified", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "write");
  const r = m.detectToolLoop(s);
  // The message should NOT say "[dream]" or "[reflection]" - those were
  // the contradictory tags. The unified message starts with "## Tool Loop Detected".
  assert.match(r.message, /^## Tool Loop Detected/);
  assert.doesNotMatch(r.message, /\[dream\]/);
  assert.doesNotMatch(r.message, /\[reflection\]/);
});

await test("detectToolLoop message includes all 4 suggested actions", async () => {
  const m = await import(DIST_PATH);
  const s = m.createToolLoopState();
  for (let i = 0; i < 16; i++) m.recordToolCall(s, "read");
  const r = m.detectToolLoop(s);
  assert.match(r.message, /think\(\)/);
  assert.match(r.message, /memory.*tool/);
  assert.match(r.message, /breaking the task/);
  assert.match(r.message, /Check if the problem has changed/);
});

// ── Source-level: only one detector for tool loops ─────────────────────────

await test("the detector file documents the consolidation", () => {
  // Sanity check: the file should explicitly call out that it
  // replaces overlapping detectors. Without this comment, future
  // contributors might re-introduce the contradiction.
  assert.match(src, /THREE overlapping detectors|three overlapping/);
  assert.match(src, /turn-outcome/);
  assert.match(src, /dreamer/);
  assert.match(src, /policy-rules/);
});

// ── Stateless convenience (used by dreamer) ─────────────────────────────────

await test("detectToolLoopFromSequence returns isLoop=false on short sequence", async () => {
  const m = await import(DIST_PATH);
  const r = m.detectToolLoopFromSequence(["read", "read", "read"]);
  assert.strictEqual(r.isLoop, false);
});

await test("detectToolLoopFromSequence detects at threshold", async () => {
  const m = await import(DIST_PATH);
  const seq = new Array(16).fill("read");
  const r = m.detectToolLoopFromSequence(seq);
  assert.strictEqual(r.isLoop, true);
  assert.strictEqual(r.tool, "read");
  assert.strictEqual(r.count, 16);
});

await test("detectToolLoopFromSequence caps at WINDOW (long sequences still detect)", async () => {
  const m = await import(DIST_PATH);
  // 30 reads - only last 20 considered (WINDOW=20), all 20 are reads -> loop
  const r = m.detectToolLoopFromSequence(new Array(30).fill("read"));
  assert.strictEqual(r.isLoop, true);
  assert.strictEqual(r.count, 20, "tail of 20 reads (capped to WINDOW=20)");
});

await test("detectToolLoopFromSequence and detectToolLoop agree on unified message", async () => {
  const m = await import(DIST_PATH);
  // Build a state from the sequence, then compare
  const seq = ["a", "b", ...new Array(16).fill("read")];
  const s = m.createToolLoopState();
  for (const t of seq) m.recordToolCall(s, t);
  const fromState = m.detectToolLoop(s);
  const fromSeq = m.detectToolLoopFromSequence(seq);
  assert.strictEqual(fromState.isLoop, fromSeq.isLoop);
  assert.strictEqual(fromState.tool, fromSeq.tool);
  assert.strictEqual(fromState.count, fromSeq.count);
  // Messages should be identical (this is the unification guarantee)
  assert.strictEqual(fromState.message, fromSeq.message);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== tool-loop-detector tests passed ===");
