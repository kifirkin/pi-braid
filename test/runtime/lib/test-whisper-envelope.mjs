/**
 * EW-7.12+: Universal whisper envelope test.
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
 *     `applyWhisperEnvelope` helpers. The envelope is
 *     `[braid-whisper - <subsystem>]` (subsystem = first source segment).
 *   - `sendTrackedMessage` (the trunk) calls `applyWhisperEnvelope` so
 *     every system-injected message - 30+ call sites across
 *     enforcement, memory, timer, drift, dreamer, etc. - automatically
 *     gets the universal prefix.
 *   - The redundant inline `[enforcement] ` prefix is removed from the
 *     wrapper (`whisper.ts`) and 4 analysis handlers (dreamer, mars,
 *     drift, register-session-start context-full).
 *
 * This test pins the contract at BOTH levels:
 *   - Runtime: formatWhisperEnvelope and applyWhisperEnvelope produce
 *     the expected output.
 *   - Source: sendTrackedMessage calls applyWhisperEnvelope; the
 *     redundant inline prefixes are gone.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  whisperFormat: join(ROOT, "src/lib/utils/whisper-format.ts"),
  injectionTracker: join(ROOT, "src/lib/utils/injection-tracker.ts"),
  whisperWrapper: join(ROOT, "src/extensions/enforcement/whisper.ts"),
  dreamerHandler: join(ROOT, "src/extensions/enforcement/handlers/analysis/dreamer-handler.ts"),
  marsHandler: join(ROOT, "src/extensions/enforcement/handlers/analysis/mars-handler.ts"),
  driftHandler: join(ROOT, "src/extensions/enforcement/handlers/analysis/drift-handler.ts"),
  registerSessionStart: join(ROOT, "src/extensions/enforcement/handlers/register-session-start.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const formatSrc = readFileSync(FILES.whisperFormat, "utf-8");
const trackerSrc = readFileSync(FILES.injectionTracker, "utf-8");
const wrapperSrc = readFileSync(FILES.whisperWrapper, "utf-8");
const dreamerSrc = readFileSync(FILES.dreamerHandler, "utf-8");
const marsSrc = readFileSync(FILES.marsHandler, "utf-8");
const driftSrc = readFileSync(FILES.driftHandler, "utf-8");
const sessionStartSrc = readFileSync(FILES.registerSessionStart, "utf-8");

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
  // The body-level sub-tag is part of the message text, not the envelope.
  // The envelope prepends to whatever the body says.
  const content = [{ type: "text", text: "[dream] Likely to get stuck in edit loop." }];
  applyWhisperEnvelope(content, "enforcement/dreamer");
  assert.equal(
    content[0].text,
    "[braid-whisper - enforcement] [dream] Likely to get stuck in edit loop.",
    "sub-tag should be preserved after the universal envelope",
  );
});

// ── Source tests: trunk calls applyWhisperEnvelope ──────────────────────────

test("sendTrackedMessage imports applyWhisperEnvelope", () => {
  assert.match(
    trackerSrc,
    /import\s*\{[^}]*applyWhisperEnvelope[^}]*\}\s*from\s*["']\.\/whisper-format\.js["']/,
    "sendTrackedMessage must import applyWhisperEnvelope from whisper-format.js",
  );
});

test("sendTrackedMessage calls applyWhisperEnvelope", () => {
  // Pin position: the envelope must be applied before the flood cap so the
  // tracked (and possibly suppressed) content reflects what would have
  // been delivered. See `lib/utils/whisper-format.ts` for the rationale.
  const fnBody = trackerSrc.match(
    /export\s+function\s+sendTrackedMessage\s*\([\s\S]*?\):\s*void\s*\{([\s\S]*?)Per-turn whisper cap/,
  );
  assert.ok(fnBody, "sendTrackedMessage body before flood-cap check not found");
  const beforeFloodCap = fnBody[1];
  assert.ok(
    /applyWhisperEnvelope\s*\(\s*params\.content\s*,\s*injectionMeta\.source\s*\)/.test(
      beforeFloodCap,
    ),
    "applyWhisperEnvelope must be called with (params.content, injectionMeta.source) " +
      "BEFORE the flood cap check",
  );
});

test("sendTrackedMessage applies the envelope after the suppressNudges check", () => {
  // Order matters: suppressNudges first (no work for off-switch), then
  // envelope, then flood cap. Pin this so future refactors don't reorder.
  const fnBody = trackerSrc.match(
    /export\s+function\s+sendTrackedMessage\s*\([\s\S]*?\):\s*void\s*\{([\s\S]*?)Per-turn whisper cap/,
  );
  assert.ok(fnBody);
  const beforeFloodCap = fnBody[1];
  const suppressIdx = beforeFloodCap.search(/areCognitiveNudgesDisabled/);
  const envelopeIdx = beforeFloodCap.search(/applyWhisperEnvelope/);
  assert.ok(suppressIdx >= 0, "suppressNudges check must appear before flood cap");
  assert.ok(envelopeIdx >= 0, "applyWhisperEnvelope must appear before flood cap");
  assert.ok(
    envelopeIdx > suppressIdx,
    "applyWhisperEnvelope must appear AFTER the suppressNudges check " +
      "(so the off-switch still short-circuits before any work)",
  );
});

// ── Source tests: redundant [enforcement] prefixes removed ──────────────────

test("sendEnforcementWhisper wrapper does not add the inline [enforcement] prefix", () => {
  // The wrapper used to add `[enforcement] ${message}`. After the fix, the
  // trunk adds the universal envelope, so the wrapper just passes the raw
  // message through. Backward compat: the new envelope contains
  // '[enforcement]' as a substring, so any existing filter still matches.
  assert.ok(
    !/text:\s*`\[enforcement\]\s*\$\{message\}`/.test(wrapperSrc),
    "sendEnforcementWhisper must not inline `[enforcement] ${message}` " +
      "(the trunk applies the universal envelope now)",
  );
});

test("dreamer-handler does not add the inline [enforcement] prefix", () => {
  assert.ok(
    !/text:\s*`\[enforcement\]\s*\$\{dreamAdvice\.message\}`/.test(dreamerSrc),
    "dreamer-handler must not inline `[enforcement] ${dreamAdvice.message}` " +
      "(the trunk applies the universal envelope now)",
  );
});

test("mars-handler does not add the inline [enforcement] prefix", () => {
  assert.ok(
    !/text:\s*`\[enforcement\]\s*\$\{marsAdvice\.message\}`/.test(marsSrc),
    "mars-handler must not inline `[enforcement] ${marsAdvice.message}` " +
      "(the trunk applies the universal envelope now)",
  );
});

test("drift-handler does not add the inline [enforcement] prefix", () => {
  assert.ok(
    !/text:\s*`\[enforcement\]\s*\$\{whisper\}`/.test(driftSrc),
    "drift-handler must not inline `[enforcement] ${whisper}` " +
      "(the trunk applies the universal envelope now)",
  );
});

test("register-session-start does not add the inline [enforcement] prefix on context_full", () => {
  assert.ok(
    !/text:\s*`\[enforcement\]\s*Context at \$\{/.test(sessionStartSrc),
    "register-session-start must not inline `[enforcement] Context at...` " +
      "(the trunk applies the universal envelope now)",
  );
});

// ── Source tests: helper file structure ─────────────────────────────────────

test("whisper-format.ts exports formatWhisperEnvelope and applyWhisperEnvelope", () => {
  assert.match(
    formatSrc,
    /export\s+function\s+formatWhisperEnvelope\s*\(\s*source:\s*string\s*\)/,
    "formatWhisperEnvelope(source: string) must be exported",
  );
  // Signature is multiline; the type annotation has parens. Match just up
  // to the `source: string` parameter (skip the closing paren - there's a
  // trailing comma in the multiline form).
  assert.match(
    formatSrc,
    /export\s+function\s+applyWhisperEnvelope\s*\([\s\S]*?source:\s*string/,
    "applyWhisperEnvelope(content, source: string) must be exported",
  );
});

test("whisper-format.ts is documented with the audit's §6.12 rationale", () => {
  assert.ok(
    /EW-7\.12|6\.12|whisper-content-audit/i.test(formatSrc),
    "whisper-format.ts must reference the audit that motivated it",
  );
});

// ── Backward-compatibility test ────────────────────────────────────────────

test("the new envelope still contains the bare subsystem name as a substring", () => {
  // User filters that match the bare subsystem name (e.g. `grep enforcement`,
  // `grep memory`) keep working. Filters that matched the old bracket-wrapped
  // prefix (`grep '\[enforcement\]'`) need to be updated to the new canonical
  // form. See the migration story in `whisper-format.ts` and audit §6.12.
  const envelope = formatWhisperEnvelope("enforcement/whisper");
  assert.ok(
    envelope.includes("enforcement"),
    `envelope '${envelope}' must contain 'enforcement' as a substring`,
  );
  // Sanity: the canonical new filter pattern is also a substring.
  assert.ok(
    envelope.includes("[braid-whisper - enforcement]"),
    `envelope '${envelope}' must contain the canonical new pattern`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
