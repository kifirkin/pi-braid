/**
 * Test: extractJson canonical extractor (lib/utils/extract-json.ts) — dedupe.
 *
 * Census finding: consolidated-claim-critic.ts and
 * consolidated-topic-critic.ts each carried a local regex copy
 * (fence regex + `\{[\s\S]*?\}`) that truncates at the FIRST `}` — including
 * one inside a string value. JSON.parse then always failed and the critic
 * silently fell back to heuristics. The canonical extractor walks the string
 * with string-context + depth tracking and returns the balanced payload.
 *
 * Layers:
 * 1. Behavioral fixtures on the canonical function, including the
 * `}`-inside-a-string payload that the local copies mis-parsed.
 * 2. Source check: the critic files import the canonical extractor
 * and no longer define a local extractJson. If a copy is ever
 * reintroduced, this fails.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Import the COMPILED module from dist/ ───────────────────────────────────
const { extractJson } = await import(join(ROOT, "dist", "lib", "utils", "extract-json.js"));

function roundTrip(text) {
  const json = extractJson(text);
  return json ? JSON.parse(json) : null;
}

// ── 1. Behavioral fixtures ──────────────────────────────────────────────────

// Plain object, no prose.
assert.deepEqual(roundTrip('{"a": 1}'), { a: 1 });

// The bug: `}`inside a string value. The local copies truncated at the
// first `}`and produced invalid JSON (`{"key": "a}`); the canonical returns
// the full balanced payload.
assert.deepEqual(roundTrip('{"key": "a}b", "n": 1}'), { key: "a}b", n: 1 });

// Escaped quote inside a string, followed by a closing brace.
assert.deepEqual(roundTrip('{"key": "a\\"b}c"}'), { key: 'a"b}c' });

// Markdown-fenced payload (the fence form the local copies optimized for).
assert.deepEqual(roundTrip('```json\n{"verdict": true}\n```'), { verdict: true });

// Fenced payload whose string value contains a `}` — combined form of both.
assert.deepEqual(roundTrip('```json\n{"code": "if (x) { return }"}\n```'), {
  code: "if (x) { return }",
});

// Leading prose + trailing prose.
assert.deepEqual(roundTrip('Sure! Here is the JSON:\n{"ok": true}\nHope that helps.'), {
  ok: true,
});

// Nested objects and arrays, trailing prose after the JSON ends.
assert.deepEqual(roundTrip('prefix {"a": {"b": [1, {"c": 2}]}} suffix'), {
  a: { b: [1, { c: 2 }] },
});

// Top-level array.
assert.deepEqual(roundTrip('[1, 2, {"x": "}"}]'), [1, 2, { x: "}" }]);

// No JSON at all.
assert.equal(extractJson("no json here"), null);
assert.equal(extractJson(""), null);
assert.equal(extractJson(null), null);

// ── 2. Source check: no local copies, all consolidated critics use the canonical ───

const CANONICAL_IMPORT = /from "[./]+(?:lib\/)?utils\/extract-json\.js"/;
const CRITIC_FILES = [
  "src/lib/ai/consolidated-claim-critic.ts",
  "src/lib/detection/consolidated-topic-critic.ts",
];
for (const rel of CRITIC_FILES) {
  const src = await readFile(join(ROOT, rel), "utf-8");
  assert.ok(
    !src.includes("function extractJson"),
    `${rel} must not define a local extractJson (single source)`,
  );
  assert.ok(
    CANONICAL_IMPORT.test(src),
    `${rel} must import the canonical extract-json (lib/utils/extract-json.ts)`,
  );
}

console.log("PASS test-extract-json: canonical extractor behavior + no local copies");
