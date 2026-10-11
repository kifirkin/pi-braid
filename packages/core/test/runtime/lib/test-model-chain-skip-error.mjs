/**
 * Test: tryModelChain's returned error when the seam skips tiers.
 *
 * tryModelChain skips a (provider, model) pair the providers seam reports
 * unusable. When every tier is skipped no provider call is attempted, so the
 * loop returned the generic "All models in chain failed" and the once-per-pair
 * skip notice in the log was the only trace. The contract pinned here:
 *
 *   1. All tiers skipped: the returned error names the pair the seam refused,
 *      so a caller can tell a skip from an ordinary exhausted chain.
 *   2. A real provider error from a tier that was attempted still survives
 *      later skips, rather than being replaced by the skip note.
 *
 * Driven through the process-global ring-feedback slot with a stubbed
 * completion call (__setCompleteSimpleForTest), so no provider is contacted
 * and the attempt count is observable.
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { tryModelChain } = await import(join(ROOT, "dist", "lib", "ai", "model-resolver.js"));
const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));
const { setKeyRingFeedbackHandler, resetKeyRingFeedbackHandler } = await import(
  join(ROOT, "dist", "lib", "state", "global-state.js"),
);

const modelA = { id: "chain-a", provider: "route-a", api: "anthropic-messages" };
const modelB = { id: "chain-b", provider: "route-b", api: "anthropic-messages" };

const ctx = {
  modelRegistry: {
    getApiKeyForProvider: async () => "test-key",
  },
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  } finally {
    __setCompleteSimpleForTest(null);
    resetKeyRingFeedbackHandler();
  }
}

/** A ring-feedback handler whose routeUsable decision is supplied per test. */
function handlerWith(decide) {
  return {
    reportFailure() {},
    reportSuccess() {},
    routeUsable: (modelId, providerId) => decide(modelId, providerId),
  };
}

console.log("=== tryModelChain skip-error tests ===\n");

await test("every tier skipped: the error names the refused pair, not the generic string", async () => {
  let completions = 0;
  __setCompleteSimpleForTest(async () => {
    completions++;
    return { errorMessage: "unreachable" };
  });
  setKeyRingFeedbackHandler(handlerWith(() => false));

  const result = await tryModelChain(ctx, [() => modelA, () => modelB], "sys", "user", {
    maxRetries: 0,
    sdkRetries: 0,
  });

  assert.ok("error" in result, `expected { error }; got ${JSON.stringify(result)}`);
  assert.notStrictEqual(
    result.error,
    "All models in chain failed",
    "an all-skipped chain must not collapse to the generic string",
  );
  assert.match(result.error, /route-b\/chain-b/, "the error must name the last refused pair");
  assert.strictEqual(completions, 0, "no tier may be attempted when every tier is skipped");
});

await test("a provider error from an attempted tier survives later skips", async () => {
  const providerError = "upstream refused the request";
  let completions = 0;
  __setCompleteSimpleForTest(async () => {
    completions++;
    return { errorMessage: providerError };
  });
  setKeyRingFeedbackHandler(handlerWith((modelId) => modelId !== modelB.id));

  const result = await tryModelChain(ctx, [() => modelA, () => modelB], "sys", "user", {
    maxRetries: 0,
    sdkRetries: 0,
  });

  assert.ok("error" in result, `expected { error }; got ${JSON.stringify(result)}`);
  assert.strictEqual(result.error, providerError, "the last provider error must be preserved");
  assert.strictEqual(completions, 1, "only the usable tier may be attempted");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== tryModelChain skip-error tests passed ===");
