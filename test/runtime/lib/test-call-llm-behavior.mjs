/**
 * Test: callLlm timeout + signal abort behavior (behavioral).
 *
 * BACKGROUND:
 *   The previous tests for ESC / timeout behavior used regex
 *   source-grep (matching callLlm body fragments for the
 *   `signal?.aborted === true` check, the conditional spread, etc.).
 *   Those tests were fragile - they break on whitespace, comment
 *   changes, and minor refactors even when behavior is unchanged.
 *
 *   This test exercises the ACTUAL behavior of callLlm by:
 *     1. Stubbing completeSimple via __setCompleteSimpleForTest
 *        so we don't need a real LLM provider.
 *     2. Driving the call with various signal/timeout combinations.
 *     3. Asserting on observable outcomes (return value, elapsed
 *        time, log buffer contents).
 *
 *   The contract being tested:
 *     - timeoutMs causes the call to abort within ~timeoutMs even
 *       when the underlying LLM is hung.
 *     - An external signal aborts the call within ~50ms even when
 *       the underlying LLM is hung.
 *     - External aborts are demoted to log.debug; timeouts are
 *       logged at log.error (the user-visible difference between
 *       "user pressed ESC" and "the model timed out").
 *
 * Why this is more robust than regex:
 *   - Refactoring llm-call.ts (e.g. renaming combineSignals, moving
 *     the timeout logic into a helper) does not break these tests.
 *   - The tests assert on behavior that callers actually depend on.
 *   - Failures point at the real problem (timeout didn't fire,
 *     abort didn't propagate) instead of a regex mismatch.
 */

import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Import the COMPILED module from dist/ ───────────────────────────────────
//
// Tests run after `npm run build` (see scripts/run-tests.mjs), so
// importing from dist/ is safe and reflects the actual built code
// that gets shipped - no TypeScript-vs-runtime drift between test
// and production.
const distPath = join(ROOT, "dist", "lib", "ai", "llm-call.js");
const {
  callLlm,
  combineSignals,
  __setCompleteSimpleForTest,
} = await import(distPath);

const { clearLogBuffer, getLogBuffer, setGlobalLogLevel } = await import(
  join(ROOT, "dist", "lib", "core", "logger.js")
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a hanging stub: returns a Promise that resolves with an
 * "aborted" AssistantMessage only when the supplied signal fires.
 * Without the signal, it never resolves. This mimics a stuck LLM
 * call that respects cancellation.
 */
function hangingStub() {
  return async (_model, _context, options) => {
    return new Promise((resolve) => {
      const signal = options?.signal;
      if (!signal) {
        // No signal - hang forever (simulates a call that ignores
        // cancellation). Tests using this stub are expected to
        // assert on the timeout path, not the abort path.
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
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
          });
        },
        { once: true },
      );
    });
  };
}

/**
 * Stub that resolves immediately with a successful response.
 */
function successStub(text = "ok") {
  return async (_model, _context, _options) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "stub",
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

/**
 * A minimal valid Model object - the stub doesn't read any of its
 * fields, so we just need the shape to satisfy callLlm's signature.
 */
const stubModel = {
  id: "stub/test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "stub",
  contextWindow: 100_000,
  maxTokens: 4096,
  reasoning: false,
};

async function withStub(fn, stubFn) {
  __setCompleteSimpleForTest(stubFn);
  // Reset global log buffer + set level so we capture all severities
  // including debug.
  clearLogBuffer();
  setGlobalLogLevel("debug");
  try {
    return await fn();
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    });
}

console.log("=== callLlm behavioral tests (timeout + signal + demotion) ===\n");

// ── combineSignals: pure-function behavior ──────────────────────────────────

await test("combineSignals: when neither signal aborted, combined is not aborted", () => {
  const s1 = new AbortController().signal;
  const s2 = new AbortController().signal;
  const combined = combineSignals(s1, s2);
  assert.strictEqual(combined.aborted, false, "combined signal must not be aborted initially");
});

await test("combineSignals: when s1 aborts, combined aborts", async () => {
  const c1 = new AbortController();
  const c2 = new AbortController();
  const combined = combineSignals(c1.signal, c2.signal);
  c1.abort();
  // Event listener is synchronous, but a microtask boundary makes
  // the test more robust against refactors that defer the dispatch.
  await sleep(0);
  assert.strictEqual(combined.aborted, true, "combined must abort when s1 aborts");
  assert.strictEqual(c2.signal.aborted, false, "s2 must remain live (no spurious abort)");
});

await test("combineSignals: when s2 aborts, combined aborts", async () => {
  const c1 = new AbortController();
  const c2 = new AbortController();
  const combined = combineSignals(c1.signal, c2.signal);
  c2.abort();
  await sleep(0);
  assert.strictEqual(combined.aborted, true, "combined must abort when s2 aborts");
});

await test("combineSignals: when s1 is already aborted, returns s2 (no instant kill)", () => {
  const c1 = new AbortController();
  c1.abort();
  const c2 = new AbortController();
  const result = combineSignals(c1.signal, c2.signal);
  // The contract: if s1 is already aborted, return s2 unmodified
  // (rather than building an instantly-aborted combined signal).
  // This matters because the combined signal is fed to completeSimple,
  // and a pre-aborted signal would instant-kill the call on retry.
  assert.strictEqual(result, c2.signal, "should return s2 unchanged when s1 already aborted");
  assert.strictEqual(result.aborted, false, "returned s2 must not be aborted");
});

// ── callLlm: timeout behavior ────────────────────────────────────────────────

await test("callLlm: timeoutMs fires the abort within the configured window", async () => {
  await withStub(async () => {
    __setCompleteSimpleForTest(hangingStub());
    const start = Date.now();
    const result = await callLlm(
      stubModel,
      "fake-key",
      "system",
      "user",
      { timeoutMs: 100, sdkRetries: 0, maxRetries: 0 },
    );
    const elapsed = Date.now() - start;
    assert.ok("error" in result, `expected { error }, got: ${JSON.stringify(result)}`);
    // Should fire within ~timeoutMs + small slack. Allow up to 500ms
    // for setTimeout drift and microtask scheduling.
    assert.ok(
      elapsed < 500,
      `call should abort within ~100ms; took ${elapsed}ms`,
    );
    assert.ok(
      elapsed >= 80,
      `call should not abort BEFORE the timeout (would indicate early abort); took ${elapsed}ms`,
    );
  }, null);
});

await test("callLlm: timeout error is logged at DEBUG level (universal abort demotion)", async () => {
  // 2026-06-23 behavior change: aborts of any kind (timeout, signal,
  // session-end backpressure) are demoted to debug. The user wants
  // aborts to be quiet so end-of-loop / session-shutdown errors don't
  // flood the TUI. The 10-minute default timeout means a real
  // provider timeout is unlikely; if it does happen, debug logs
  // preserve the signal for diagnostic purposes.
  await withStub(async () => {
    clearLogBuffer();
    __setCompleteSimpleForTest(hangingStub());
    await callLlm(
      stubModel,
      "fake-key",
      "system",
      "user",
      { timeoutMs: 80, sdkRetries: 0, maxRetries: 0 },
    );
    const logs = getLogBuffer();
    const llmCallLogs = logs.filter((l) => l.source === "llm-call");
    const errorLogs = llmCallLogs.filter((l) => l.level === "error");
    const debugAbortLogs = llmCallLogs.filter(
      (l) => l.level === "debug" && /aborted|external signal/i.test(l.message),
    );
    assert.strictEqual(
      errorLogs.length,
      0,
      `timeout must NOT be logged at ERROR (universal abort demotion); got: ${JSON.stringify(errorLogs)}`,
    );
    assert.ok(
      debugAbortLogs.length >= 1,
      `expected ≥1 debug abort log; got ${debugAbortLogs.length}. All logs: ${JSON.stringify(logs)}`,
    );
  }, null);
});

// ── callLlm: external signal behavior ────────────────────────────────────────

await test("callLlm: external signal aborts the call quickly (not at timeoutMs)", async () => {
  await withStub(async () => {
    __setCompleteSimpleForTest(hangingStub());
    const controller = new AbortController();
    // Set timeoutMs much higher than the signal-fire time so we
    // can prove the signal path is faster than the timeout path.
    const start = Date.now();
    const promise = callLlm(
      stubModel,
      "fake-key",
      "system",
      "user",
      { timeoutMs: 60_000, signal: controller.signal, sdkRetries: 0, maxRetries: 0 },
    );
    // Fire the signal after a short delay.
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    const elapsed = Date.now() - start;
    assert.ok("error" in result, `expected { error } on signal abort`);
    // Should abort well before the 60s timeout - within ~500ms.
    assert.ok(
      elapsed < 500,
      `signal should abort call quickly; took ${elapsed}ms (timeout was 60s)`,
    );
  }, null);
});

await test("callLlm: external-signal abort is demoted to DEBUG (not ERROR)", async () => {
  await withStub(async () => {
    clearLogBuffer();
    __setCompleteSimpleForTest(hangingStub());
    const controller = new AbortController();
    const promise = callLlm(
      stubModel,
      "fake-key",
      "system",
      "user",
      { timeoutMs: 60_000, signal: controller.signal, sdkRetries: 0, maxRetries: 0 },
    );
    setTimeout(() => controller.abort(), 30);
    await promise;
    const logs = getLogBuffer();
    const llmCallLogs = logs.filter((l) => l.source === "llm-call");
    const errorLogs = llmCallLogs.filter((l) => l.level === "error");
    const debugLogs = llmCallLogs.filter(
      (l) => l.level === "debug" && /aborted|external signal/i.test(l.message),
    );
    assert.strictEqual(
      errorLogs.length,
      0,
      `external abort must NOT log at ERROR; got: ${JSON.stringify(errorLogs)}`,
    );
    assert.ok(
      debugLogs.length >= 1,
      `external abort must produce ≥1 DEBUG log mentioning the abort; got: ${JSON.stringify(llmCallLogs)}`,
    );
  }, null);
});

// ── callLlm: combined timeout + signal ───────────────────────────────────────

await test("callLlm: timeout OR signal - whichever fires first wins", async () => {
  // Two cases: signal-fires-first and timeout-fires-first.
  // Each must abort the call within their respective window.
  await withStub(async () => {
    __setCompleteSimpleForTest(hangingStub());

    // Case A: signal fires first.
    const c1 = new AbortController();
    const pA = callLlm(stubModel, "fake-key", "sys", "u", {
      timeoutMs: 60_000,
      signal: c1.signal,
      sdkRetries: 0,
      maxRetries: 0,
    });
    setTimeout(() => c1.abort(), 30);
    const startA = Date.now();
    const resA = await pA;
    const elapsedA = Date.now() - startA;
    assert.ok("error" in resA, "Case A must produce error");
    assert.ok(elapsedA < 500, `Case A should be fast; was ${elapsedA}ms`);

    // Case B: timeout fires first (no signal).
    const startB = Date.now();
    const resB = await callLlm(stubModel, "fake-key", "sys", "u", {
      timeoutMs: 80,
      sdkRetries: 0,
      maxRetries: 0,
    });
    const elapsedB = Date.now() - startB;
    assert.ok("error" in resB, "Case B must produce error");
    assert.ok(elapsedB < 500, `Case B should fire at timeout; was ${elapsedB}ms`);
  }, null);
});

// ── callLlm: success path is unaffected by the injection ─────────────────────

await test("callLlm: successful stub returns { text } (sanity check injection wiring)", async () => {
  await withStub(async () => {
    __setCompleteSimpleForTest(successStub("hello"));
    const result = await callLlm(
      stubModel,
      "fake-key",
      "system",
      "user",
      { timeoutMs: 5_000 },
    );
    assert.ok("text" in result, `expected { text }; got ${JSON.stringify(result)}`);
    assert.strictEqual(result.text, "hello");
  }, null);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== callLlm behavioral tests passed ===");
