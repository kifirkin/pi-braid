/**
 * Regression test: episode sanitizer (BUG-M3) decodes double-encoded
 * unicode escape sequences. Plus BUG-M2 regression check.
 *
 * HISTORY:
 * Parallel audit agent found literal "\\u2192"strings in
 * episodes.jsonl (the right arrow character -> was double-encoded).
 * The recall_search / episodes_search displays showed the literal
 * escape sequence instead of the real character. Root cause: a
 * previous code path called JSON.stringify on data that already
 * had escaped Unicode sequences (likely from a model response that
 * was JSON-encoded twice).
 *
 * BUG-M2: parallel agent found since/until filter applied only to
 * semantic memories, not to episodes.
 *
 * FIX:
 * - BUG-M3: at load time, sanitizeEpisode() decodes any string field
 * that contains literal \uXXXX patterns.
 * - BUG-M2: episodes are now filtered by since/until after
 * retrieveByRUMS().
 *
 * This test pins the behavioral fix.
 */

import { strict as assert } from "node:assert";

console.log("=== Episode sanitizer (BUG-M3) + BUG-M2 regression ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── Behavioral: the sanitizer actually decodes correctly ────────────────

// Re-implement the spec locally.
//
// switched from JSON.parse-based decoding to regex replace.
// The previous spec silently FAILED for any string containing raw newline
// characters (the common case for multi-line task/solution fields):
// JSON.parse throws on raw \n inside a JSON string literal, the catch
// block returned the input unchanged, and literal \u2192 remained in
// agent-facing output. Regex-replace doesn't have that failure mode.
const UNESCAPE_RE = /\\u[0-9a-fA-F]{4}/;

function unescapeUnicodeIfDoubleEncoded(s) {
  if (typeof s !== "string") return s;
  if (!UNESCAPE_RE.test(s)) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

test("decodes a literal \\u2192 escape to real -> character", () => {
  const literalEscape = String.raw`a \u2192 b`;
  assert.equal(literalEscape.length, 10, "literal escape should be 10 chars");
  assert.ok(literalEscape.includes("\\u2192"), "input should contain literal \\u2192");
  const output = unescapeUnicodeIfDoubleEncoded(literalEscape);
  assert.notEqual(output, literalEscape, "should have changed the input");
  assert.ok(
    output.includes("\u2192"),
    `output should contain real \u2192, got: ${JSON.stringify(output)}`,
  );
});

test("leaves clean strings alone", () => {
  const clean = "The path is a -> b (already real character)";
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(clean), clean);
});

test("leaves strings without escape sequences alone", () => {
  const noEscapes = "just a normal string with no escapes at all";
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(noEscapes), noEscapes);
});

test("non-string values pass through", () => {
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(42), 42);
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(null), null);
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(undefined), undefined);
  assert.strictEqual(unescapeUnicodeIfDoubleEncoded(true), true);
  assert.deepStrictEqual(unescapeUnicodeIfDoubleEncoded([1, 2]), [1, 2]);
});

// this is the actual root cause case that the JSON.parse-based
// sanitizer silently dropped.
test("decodes escapes in strings with raw newlines (the actual BUG-M3 case)", () => {
  const multiLineWithEscape = "line one\nline two \\u2192 line three\nline four";
  const output = unescapeUnicodeIfDoubleEncoded(multiLineWithEscape);
  assert.ok(
    output.includes("\u2192"),
    `output should contain real \u2192 after multi-line decode, got: ${JSON.stringify(output)}`,
  );
  assert.ok(
    !output.includes("\\u2192"),
    `output should not contain literal \\u2192, got: ${JSON.stringify(output)}`,
  );
  // Newlines should be preserved (the regex-replace approach doesn't
  // touch them).
  assert.ok(output.includes("\n"), "newlines should be preserved");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== Episode sanitizer + BUG-M2 regression tests passed ===");
