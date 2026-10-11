/**
 * Test: canonical RATE_LIMIT_PATTERNS parity (lib/errors/llm-error.ts) — dedupe.
 *
 * Two drifted implementations existed:
 * - llm-error.ts regexes: /429/, /rate[_ ]limit/i, /too[_ ]many[_ ]requests/i
 * - llm-call.ts substring list: startsWith("429") || includes
 * ("rate limit" | "too many requests" | "throttled")
 *
 * They disagreed: "throttled"matched in one only; llm-error matched "429"
 * anywhere (and the underscore forms) while llm-call only matched at the
 * start. The merge contract: ONE canonical list in llm-error.ts whose
 * semantics are a documented SUPERSET of both. This test pins the superset:
 *
 * 1. Parity table: every documented input matches (429 / "rate limit" /
 * "too many requests" / "throttled" / "throttle" / underscore forms) and
 * every non-rate-limit input does not.
 * 2. Superset proof: for each documented input, BOTH legacy matchers (the
 * pre-merge semantics, reimplemented below) that matched must still
 * match the canonical matcher. Where only one matched, the canonical
 * still matches (union semantics).
 * 3. Source check: llm-call.ts delegates to isRateLimitText and defines no
 * local RATE_LIMIT_PATTERNS — a reintroduced copy fails this test.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Import the COMPILED module from dist/ ───────────────────────────────────
const { isRateLimitText } = await import(
  join(ROOT, "dist", "lib", "errors", "llm-error.js")
);

// ── 1. Parity table ─────────────────────────────────────────────────────────
// [input, expected] — expected true = rate-limit condition.
const TABLE = [
  // Numeric status forms ("429"anywhere — legacy llm-error semantics).
  ["429", true],
  ["429 Too Many Requests", true],
  ["Error 429: quota exceeded", true],
  ["429 rate limit exceeded", true],
  // Accepted widening note: "1429"contains "429"and matches, exactly as the
  // pre-merge llm-error /429/ did. Documented, not new.
  ["1429 requests buffered", true],
  // Space forms (both old lists matched these).
  ["rate limit exceeded", true],
  ["too many requests", true],
  ["Too Many Requests", true],
  // Underscore forms (legacy llm-error /[_ ]/ semantics).
  ["rate_limit exceeded", true],
  ["too_many_requests", true],
  // Throttle family — canonical matches all three spellings.
  ["throttled", true],
  ["Request throttled", true],
  ["throttle engaged", true],
  ["throttling detected", true],
  // Non-rate-limit inputs must NOT match.
  ["402 insufficient balance", false],
  ["billing error", false],
  ["401 unauthorized invalid api key", false],
  ["413 context length exceeded", false],
  ["503 service unavailable", false],
  ["socket hang up", false],
  ["500 internal server error", false],
];
for (const [input, expected] of TABLE) {
  assert.equal(
    isRateLimitText(input),
    expected,
    `isRateLimitText(${JSON.stringify(input)}) should be ${expected}`,
  );
}

// ── 2. Superset proof vs both pre-merge implementations ─────────────────────
// Old llm-call.ts semantics (verbatim from the pre- copy).
const OLD_LLM_CALL_PATTERNS = ["rate limit", "too many requests", "throttled"];
function oldLlmCallMatches(message) {
  if (message.startsWith("429")) return true;
  const lower = message.toLowerCase();
  return OLD_LLM_CALL_PATTERNS.some((p) => lower.includes(p));
}
// Old llm-error.ts semantics (verbatim from the pre- list).
const OLD_LLM_ERROR_PATTERNS = [/429/, /rate[_ ]limit/i, /too[_ ]many[_ ]requests/i];
function oldLlmErrorMatches(text) {
  return OLD_LLM_ERROR_PATTERNS.some((p) => p.test(text));
}
for (const [input] of TABLE) {
  // Superset invariant: every input accepted by EITHER legacy matcher must
  // still be accepted by the canonical matcher. (The canonical may also
  // accept inputs neither legacy matcher accepted — that is the documented
  // widening: "throttle/-ing", underscore forms in llm-call, "429"-anywhere
  // in llm-call — and the exact-match table above pins those.)
  assert.ok(
    !(oldLlmCallMatches(input) || oldLlmErrorMatches(input)) || isRateLimitText(input),
    `canonical must cover every input either legacy matcher accepted: ${JSON.stringify(input)}`,
  );
}

// ── 3. Source check: canonical lives in llm-error.ts, llm-call.ts delegates ─
const llmErrorSrc = await readFile(join(ROOT, "src", "lib", "errors", "llm-error.ts"), "utf-8");
assert.ok(
  llmErrorSrc.includes("export const RATE_LIMIT_PATTERNS"),
  "RATE_LIMIT_PATTERNS must be exported from lib/errors/llm-error.ts",
);
const llmCallSrc = await readFile(join(ROOT, "src", "lib", "ai", "llm-call.ts"), "utf-8");
assert.ok(
  !llmCallSrc.includes("RATE_LIMIT_PATTERNS"),
  "llm-call.ts must not define its own RATE_LIMIT_PATTERNS (single source)",
);
assert.ok(
  llmCallSrc.includes("isRateLimitText"),
  "llm-call.ts must delegate to the canonical isRateLimitText",
);

console.log("PASS test-rate-limit-patterns: parity table + superset proof + delegation");
