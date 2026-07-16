/**
 * Test: postLoopClassify wrapper contract (behavioral only).
 *
 * BACKGROUND (2026-06-21 + follow-ups):
 *   detectPatternWithLLM had four hand-rolled guarantees that are
 *   needed by every post-loop LLM call site:
 *     1. ctx.signal threads through to callLlm (ESC propagation)
 *     2. abort log demoted to debug when external signal aborted
 *     3. tier === "failed" -> caller-supplied fallback (NOT "unknown")
 *     4. 30s default timeout (was 3s -> 5s -> 8s -> 30s through four
 *        rounds of tuning; 30s is at the upper end of "a minute or
 *        more" the user reported being OK with).
 *
 *   The fix refactored detectPatternWithLLM onto a shared wrapper
 *   `postLoopClassify` (in src/lib/ai/post-loop-classify.ts).
 *
 * This test uses behavioral tests for the runtime contracts (timeout
 * actually fires, signal actually aborts, onFailure actually invoked)
 * via the callLlm test injection (__setCompleteSimpleForTest).
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== postLoopClassify wrapper contract tests ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
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

// ── Behavioral: onFailure fallback when tier === "failed" ────────────────────

await test("postLoopClassify calls onFailure when ALL LLM tiers time out", async () => {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist/lib/ai/llm-call.js")
  );
  __setCompleteSimpleForTest(async (_m, _c, options) => {
    return new Promise((resolve) => {
      options.signal.addEventListener(
        "abort",
        () =>
          resolve({
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "stub",
            usage: { input: 0, output: 0, totalTokens: 0 },
            stopReason: "aborted",
            errorMessage: "aborted",
            timestamp: Date.now(),
          }),
        { once: true },
      );
    });
  });
  const fakeCtx = {
    model: { id: "stub/test", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
  };
  let onFailureCalled = false;
  let onFailureReason = null;
  try {
    const result = await (
      await import(join(ROOT, "dist/lib/ai/post-loop-classify.js"))
    ).postLoopClassify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "u" },
      {},
      {
        onFailure: (reason) => {
          onFailureCalled = true;
          onFailureReason = reason;
          return "fallback";
        },
        timeoutMs: 100, // short timeout so the test runs fast
      },
    );
    assert.strictEqual(onFailureCalled, true, "onFailure must be invoked on tier=failed");
    assert.ok(
      onFailureReason && typeof onFailureReason.latencyMs === "number",
      "onFailure must receive { latencyMs } in reason",
    );
    assert.strictEqual(result.label, "fallback");
    assert.strictEqual(result.tier, "failed");
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Behavioral: bestEffort demotion ──────────────────────────────────────────

await test("postLoopClassify demotes TIER failure warns (bestEffort always true)", async () => {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist/lib/ai/llm-call.js")
  );
  const { clearLogBuffer, getLogBuffer, setGlobalLogLevel } = await import(
    join(ROOT, "dist/lib/core/logger.js")
  );
  __setCompleteSimpleForTest(async (_m, _c, options) => {
    return new Promise((resolve) => {
      options.signal.addEventListener(
        "abort",
        () =>
          resolve({
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "stub",
            usage: { input: 0, output: 0, totalTokens: 0 },
            stopReason: "aborted",
            errorMessage: "aborted",
            timestamp: Date.now(),
          }),
        { once: true },
      );
    });
  });
  const fakeCtx = {
    model: { id: "stub/test", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
  };
  try {
    clearLogBuffer();
    setGlobalLogLevel("debug");
    await (
      await import(join(ROOT, "dist/lib/ai/post-loop-classify.js"))
    ).postLoopClassify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "u" },
      {},
      { onFailure: () => "fallback", timeoutMs: 80 },
    );
    const logs = getLogBuffer();
    // Find any warn logs from text-classifier (the TIER-failure warns
    // come from there). They must NOT exist at warn level - they
    // should be at debug level due to bestEffort.
    const classifierWarns = logs.filter(
      (l) => l.source === "text-classifier" && l.level === "warn",
    );
    assert.strictEqual(
      classifierWarns.length,
      0,
      `bestEffort must demote TIER failure warns to debug; got ${classifierWarns.length} warns: ${JSON.stringify(classifierWarns)}`,
    );
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Behavioral: signal propagation through ctx.signal ────────────────────────

await test("postLoopClassify aborts when ctx.signal fires (ESC during post-loop)", async () => {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist/lib/ai/llm-call.js")
  );
  __setCompleteSimpleForTest(async (_m, _c, options) => {
    return new Promise((resolve) => {
      options.signal.addEventListener(
        "abort",
        () =>
          resolve({
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "stub",
            usage: { input: 0, output: 0, totalTokens: 0 },
            stopReason: "aborted",
            errorMessage: "aborted",
            timestamp: Date.now(),
          }),
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const fakeCtx = {
    model: { id: "stub/test", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
    signal: controller.signal,
  };
  try {
    const start = Date.now();
    const promise = (
      await import(join(ROOT, "dist/lib/ai/post-loop-classify.js"))
    ).postLoopClassify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "u" },
      {},
      {
        onFailure: (reason) => `aborted-at-${reason.latencyMs}ms`,
        timeoutMs: 60_000, // long timeout so signal path is faster
      },
    );
    // Fire signal after a short delay - simulates user pressing ESC
    // during the post-loop work.
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    const elapsed = Date.now() - start;
    // Should complete within ~1s (signal path), not 60s (timeout path).
    assert.ok(
      elapsed < 5_000,
      `signal path must be faster than timeout; took ${elapsed}ms`,
    );
    assert.strictEqual(
      result.tier,
      "failed",
      "tier must be 'failed' when signal aborts the LLM",
    );
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Behavioral: success path returns the LLM's label ────────────────────────

await test("postLoopClassify returns LLM label on success (tier=utility or session)", async () => {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist/lib/ai/llm-call.js")
  );
  __setCompleteSimpleForTest(async () => ({
    role: "assistant",
    content: [{ type: "text", text: "yes" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "stub",
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  }));
  const fakeCtx = {
    model: { id: "stub/test", provider: "anthropic", api: "anthropic-messages" },
    modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
  };
  try {
    const result = await (
      await import(join(ROOT, "dist/lib/ai/post-loop-classify.js"))
    ).postLoopClassify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "u" },
      {},
      { onFailure: () => "fallback" },
    );
    assert.strictEqual(result.label, "yes");
    assert.notStrictEqual(result.tier, "failed");
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== postLoopClassify wrapper tests passed ===");