/**
 * EW-7.12+: Universal whisper envelope test (runtime only).
 *
 * HISTORY (2026-06-21):
 *   The audit's §6.12 found that ~30% of system-injected messages had no
 *   prefix at all ("Context at 80%.", "## Session Size Notice",
 *   "VbC correction: ...") and the rest had inconsistent prefixes
 *   ("[enforcement]", "[Quality]", "[chains]", "[TIMER FIRED]"). The agent
 *   could confuse these with human user input, especially because many
 *   use imperative voice ("Consider X", "Run Y").
 *
 * FIX:
 *   - Add `lib/utils/whisper-format.ts` with `formatWhisperEnvelope` and
 *     `applyWhisperEnvelope` helpers.
 *   - `sendTrackedMessage` (the trunk) calls `applyWhisperEnvelope` so
 *     every system-injected message gets the universal prefix.
 *
 * This test exercises the runtime behavior of formatWhisperEnvelope and
 * applyWhisperEnvelope.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Import the runtime helpers from the compiled output
const { formatWhisperEnvelope, applyWhisperEnvelope } = await import(
  "../../../dist/lib/utils/whisper-format.js"
);

console.log("=== EW-7.12+: Universal whisper envelope ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── Runtime tests ────────────────────────────────────────────────────────────

test("formatWhisperEnvelope uses the source's first segment as subsystem", () => {
  assert.equal(
    formatWhisperEnvelope("enforcement/whisper"),
    "[braid-whisper - enforcement]",
    "enforcement/whisper should produce the enforcement subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("memory/context-manager"),
    "[braid-whisper - memory]",
    "memory/context-manager should produce the memory subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("timer/fire"),
    "[braid-whisper - timer]",
    "timer/fire should produce the timer subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("cognitive/sycophancy-detector"),
    "[braid-whisper - cognitive]",
    "cognitive/* should produce the cognitive subsystem tag",
  );
});

test("formatWhisperEnvelope falls back to 'system' for empty/bare source", () => {
  assert.equal(formatWhisperEnvelope(""), "[braid-whisper - system]");
  assert.equal(formatWhisperEnvelope("unknown"), "[braid-whisper - unknown]");
});

test("applyWhisperEnvelope prepends the envelope to the first text element", () => {
  const content = [{ type: "text", text: "Error burst detected: 3 consecutive errors." }];
  applyWhisperEnvelope(content, "enforcement/whisper");
  assert.equal(
    content[0].text,
    "[braid-whisper - enforcement] Error burst detected: 3 consecutive errors.",
  );
});

test("applyWhisperEnvelope mutates the existing text in place", () => {
  const content = [{ type: "text", text: "memory recall" }];
  const before = content;
  applyWhisperEnvelope(content, "memory/three-memory-stores");
  assert.strictEqual(content, before, "should mutate the same array reference");
  assert.match(content[0].text, /^\[braid-whisper - memory\] /);
});

test("applyWhisperEnvelope handles empty content array", () => {
  const content = [];
  applyWhisperEnvelope(content, "enforcement/whisper");
  assert.equal(content.length, 1, "should prepend a new text element");
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[braid-whisper - enforcement] ");
});

test("applyWhisperEnvelope handles content with no text element", () => {
  const content = [{ type: "image", data: "fake" }];
  applyWhisperEnvelope(content, "memory/context-manager");
  assert.equal(content.length, 2, "should prepend a new text element");
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[braid-whisper - memory] ");
  assert.equal(content[1].type, "image");
});

test("applyWhisperEnvelope preserves body-level sub-tags like [dream] or [recall]", () => {
  const content = [{ type: "text", text: "[dream] Likely to get stuck in edit loop." }];
  applyWhisperEnvelope(content, "enforcement/dreamer");
  assert.equal(
    content[0].text,
    "[braid-whisper - enforcement] [dream] Likely to get stuck in edit loop.",
    "sub-tag should be preserved after the universal envelope",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}