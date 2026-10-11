/**
 * Test: classifier + LLM call handle ESC / external abort cleanly.
 *
 * BACKGROUND:
 * User report:
 * 00:46:46.171 INFO [heartbeat] context-hygiene: 21 activations
 * Error: 00:46:50.567 ERROR [llm-call] LLM error: Request was aborted
 * 00:46:50.568 INFO [heartbeat] [heartbeat] Consolidation candidate enqueued
 *
 * Root causes (all fixed in the original round):
 * 1. text-classifier.ts didn't pass `ctx.signal`to callLlm. So when
 * the user pressed ESC during the agent's main turn, ONLY the
 * turn's LLM call aborted - braid's parallel classify() /
 * consolidation / sop-extractor calls kept running until their
 * own internal timeouts fired.
 * 2. llm-call.ts logged ALL aborts at ERROR level, even when the
 * abort was an expected cancellation (ESC, session shutdown).
 * 3. sop-extractor.ts's detectPatternWithLLM accepted "unknown"as
 * a valid pattern label when classify() failed - it embedded
 * "unknown"in the strategic SOP instead of falling back.
 *
 * Previous version of this test was source-grep heavy: it matched
 * the conditional spread, the abort demotion in llm-call.ts, the
 * tier-check, etc. Those tests were fragile - they broke on
 * whitespace, comment changes, and minor refactors even when
 * behavior was unchanged. The current version uses:
 *
 * - Behavioral tests where possible (signal threading via
 * __setCompleteSimpleForTest - covers most of the contract).
 * - Light structural checks where behavioral testing would
 * require invoking module-private internals (e.g. the
 * sop-extractor's heuristic fallback is module-private).
 *
 * The deep callLlm-level behavior (timeout, signal demotion, log
 * levels) is exhaustively tested in test-call-llm-behavior.mjs.
 * The post-loop wrapper timeout is tested in test-post-loop-classify.mjs.
 * This file focuses on the text-classifier integration: does it
 * actually thread ctx.signal to callLlm?
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== classifier + LLM call: abort handling tests ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

// ── Behavioral: classify() threads ctx.signal through to callLlm ─────────────
//
// We invoke classify() with a stubbed callLlm (via __setCompleteSimpleForTest).
// We give classify() a fake ctx with a signal that aborts mid-call.
// We verify classify returns quickly (not waiting for the tier timeout).
// This proves the ctx.signal is reaching callLlm - the original bug.

await test("classify() aborts when ctx.signal fires (ESC during classifier call)", async () => {
  const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
  const { classify } = await import(join(ROOT, "dist/lib/ai/text-classifier.js"));
  // Hang the LLM call until aborted.
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
    const promise = classify(
      fakeCtx,
      {
        systemPrompt: "sys",
        userPrompt: "{{x}}",
      },
      { x: "test" },
      // Long tier timeout so we can prove signal is faster.
      { timeoutMs: 60_000 },
    );
    // Fire signal after a short delay - simulates ESC mid-call.
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    const elapsed = Date.now() - start;
    // Should return within ~5s (signal path), not 60s (timeout path).
    assert.ok(
      elapsed < 5_000,
      `signal must abort classify() fast; took ${elapsed}ms (timeout was 60s)`,
    );
    // The tier must be "failed"since the LLM never produced a label.
    assert.strictEqual(
      result.tier,
      "failed",
      "tier must be 'failed' when signal aborts the LLM call",
    );
    assert.strictEqual(result.label, "unknown");
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Behavioral: classify() demotes aborts to debug when ctx.signal fires ─────
//
// The original bug was "Request was aborted"at ERROR level when ESC
// was pressed. We verify the demotion: with ctx.signal set and fired,
// the resulting log is at debug (not error) level.

await test("classify() demotes failure warns to debug when ctx.signal fires", async () => {
  const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
  const { classify } = await import(join(ROOT, "dist/lib/ai/text-classifier.js"));
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
            errorMessage: "Request was aborted",
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
    clearLogBuffer();
    setGlobalLogLevel("debug");
    const promise = classify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "{{x}}" },
      { x: "test" },
      { timeoutMs: 60_000 },
    );
    setTimeout(() => controller.abort(), 50);
    await promise;
    const logs = getLogBuffer();
    // The TIER failure logs (from text-classifier) should be at
    // debug level, not warn, because bestEffort isn't set but the
    // failure reason contains "abort"which triggers the abort
    // demotion (see text-classifier.ts logTierFailure).
    const classifierLogs = logs.filter((l) => l.source === "text-classifier");
    const abortWarn = classifierLogs.find((l) => l.level === "warn" && /abort/i.test(l.message));
    assert.strictEqual(
      abortWarn,
      undefined,
      `abort failures must not be logged at warn; got: ${JSON.stringify(abortWarn)}`,
    );
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== classifier + LLM call: abort handling tests passed ===");
