/**
 * Test: hypothesize empty-model-response retry (2026-09 empty-response fix).
 *
 * Root cause: reasoning tokens count against max_tokens for most providers
 * (llm-call.ts docs), and hypothesize's tryModelChain call passed neither
 * maxTokens nor a reasoning cap — at default reasoning the budget could be
 * fully consumed by thinking, producing 0 output tokens. tryModelChain
 * treats empty text as failure, falls through every resolver, and returns
 * { error: "Empty response from model" } — the owner-visible failure. The
 * empty-text branch in hypothesize is dead code; the live failure path is
 * the "error" in llmResult branch.
 *
 * Fix contract pinned here:
 *   1. emptyResponseRetryOptions(lastError) is a pure exported helper:
 *      /empty response/i errors -> retry options with reasoning "off";
 *      anything else (HTTP 429, "All models failed", aborts) -> null.
 *   2. The primary tryModelChain call site passes maxTokens: 4000 and
 *      reasoning: "low" (source-grep fragment match, the technique
 *      documented at the header of test-call-llm-behavior.mjs).
 *
 * Style: unit-test the pure helper behaviorally from dist/; source-grep
 * the call-site options (a full behavioral drive of hypothesize.execute
 * would need a complete ExtensionContext + modelRegistry stub, out of
 * scope for this contract).
 *
 * Extended: `maxHypotheses` is a blank-selector read. Argument validation
 * converts a blank ("") to 0 before the handler runs, and the prompt then
 * asked the model for zero hypotheses. The read now goes through the pure
 * resolver `resolveMaxHypotheses` (exported for the same reason
 * `emptyResponseRetryOptions` is), so the conversion and the default are
 * both pinned without a model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { emptyResponseRetryOptions, resolveMaxHypotheses, createHypothesizeTool } = await import(
  join(ROOT, "dist", "extensions", "cognitive", "metacognition", "handlers", "hypothesize.js")
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

test("emptyResponseRetryOptions: empty-class error returns retry options with reasoning off", () => {
  const opts = emptyResponseRetryOptions("Empty response from model");
  assert.ok(opts, "empty-class error must produce retry options");
  assert.equal(opts.reasoning, "off");
  assert.equal(opts.maxTokens, 4000);
  assert.equal(opts.temperature, 0.3);
});

test("emptyResponseRetryOptions: matches the empty-response class case-insensitively", () => {
  assert.ok(emptyResponseRetryOptions("EMPTY RESPONSE from model"));
  assert.ok(emptyResponseRetryOptions("Chain failed: Empty response from model"));
});

test("emptyResponseRetryOptions: non-empty-class errors return null (no retry)", () => {
  assert.equal(emptyResponseRetryOptions("HTTP 429"), null);
  assert.equal(emptyResponseRetryOptions("All models failed"), null);
  assert.equal(emptyResponseRetryOptions("Request was aborted"), null);
  assert.equal(emptyResponseRetryOptions("Rate-limit cooldown active"), null);
  assert.equal(emptyResponseRetryOptions(""), null);
});

test("hypothesize.ts: primary tryModelChain call site passes maxTokens 4000 + reasoning low", () => {
  // Source-grep (fragment match) on the call site — the same technique
  // test-call-llm-behavior.mjs documents for pinning call-site options.
  const src = readFileSync(
    join(ROOT, "src", "extensions", "cognitive", "metacognition", "handlers", "hypothesize.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes('maxTokens: 4000, reasoning: "low"'),
    "primary tryModelChain options must cap tokens and reasoning",
  );
  assert.ok(
    src.includes("emptyResponseRetryOptions(llmResult.error)"),
    "live error branch must consult the retry helper",
  );
  // The retry is reasoning "off" — mechanical regeneration per llm-call docs.
  assert.ok(
    /emptyResponseRetryOptions[\s\S]*?reasoning: "off"/.test(src),
    "retry helper must request reasoning off",
  );
});

test("hypothesize: a blank maxHypotheses becomes 0 and resolves to the documented 3", () => {
  const tool = createHypothesizeTool();
  const args = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    {
      name: tool.name,
      arguments: { problem: "a problem", evidence: "an error line", maxHypotheses: "" },
    },
  );
  assert.equal(args.maxHypotheses, 0, "the framework converts the blank count to 0 (tested path)");
  assert.equal(resolveMaxHypotheses(args.maxHypotheses), 3, "the documented default applies");
});

test("hypothesize: the resolver keeps the documented default and a real count", () => {
  assert.equal(resolveMaxHypotheses(undefined), 3);
  assert.equal(resolveMaxHypotheses(0), 3);
  assert.equal(resolveMaxHypotheses(-2), 3);
  assert.equal(resolveMaxHypotheses(Number.NaN), 3);
  assert.equal(resolveMaxHypotheses("5"), 3, "a string is not a count");
  assert.equal(resolveMaxHypotheses(7), 7, "a real count passes through");
});

test("hypothesize: the handler reads params.maxHypotheses through the resolver", () => {
  const dist = readFileSync(
    join(ROOT, "dist", "extensions", "cognitive", "metacognition", "handlers", "hypothesize.js"),
    "utf-8",
  );
  assert.match(dist, /resolveMaxHypotheses\(params\.maxHypotheses\)/);
});
