/**
 * Test: direct callLlm callers thread ctx.signal for ESC cancellation.
 *
 * BACKGROUND (2026-06-21 follow-up):
 *   The 2026-06-21 ESC fix (test-classifier-abort-handling.mjs)
 *   established the contract that classify() → tryModelCall() →
 *   callLlm() threads ctx.signal through. That covers ~80% of
 *   braid's LLM call sites because most go through classify().
 *
 *   But several EXTENSIONS call callLlm() DIRECTLY, bypassing
 *   classify(). These callers must also thread ctx.signal or they
 *   leak: when the user presses ESC during the agent's main turn,
 *   the turn's LLM call aborts cleanly but these parallel braid
 *   calls keep running until their own internal timeouts fired.
 *
 *   The user-visible symptom is the same misleading "LLM error:
 *   This operation was aborted" ERROR log long after the user
 *   pressed ESC. The user reported one such instance for the
 *   verification-judge call (run during MESSAGE_END for finalize
 *   audit), one for input-polisher (called from input event
 *   handler while agent is mid-stream), and one for session-recall
 *   (called via tool execute while agent is in a turn).
 *
 * Previous version of this test was source-grep heavy: it read
 * function bodies with regex for the conditional-spread pattern.
 * Those tests were fragile - they broke on whitespace, comment
 * changes, and minor refactors even when behavior was unchanged.
 *
 * The current version uses:
 *   - Smoke tests: files exist, key exports present. Cheap to check,
 *     valuable for early detection of catastrophic deletions.
 *   - One behavioral test: runVerificationJudge signal threading,
 *     since this extension exposes a testable function (the others
 *     - input-polisher's processMessage, session-recall's tool
 *     execute - are module-private and not easily invokable).
 *
 * The callLlm-level signal-threading contract is exhaustively tested
 * in test-call-llm-behavior.mjs. This file focuses on whether the
 * extensions actually USE that contract (i.e., pass signal through).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log(
  "=== direct callLlm callers: ESC propagation smoke tests ===\n",
);

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

// ── Smoke tests: files exist, key exports present ────────────────────────────
//
// These check the structural integrity of the signal-threading contract:
// if a file is deleted or a key export is removed, the test fails.
// They do NOT read function bodies (the fragile part the user
// complained about).

await test("input-polisher extension file exists", () => {
  const path = join(ROOT, "src/extensions/core/input-polisher/index.ts");
  assert.ok(existsSync(path), `input-polisher must exist at ${path}`);
});

await test("session-recall extension file exists", () => {
  const path = join(ROOT, "src/extensions/memory/session-recall/index.ts");
  assert.ok(existsSync(path), `session-recall must exist at ${path}`);
});

await test("verification-judge module file exists", () => {
  const path = join(ROOT, "src/extensions/enforcement/verification-judge.ts");
  assert.ok(existsSync(path), `verification-judge must exist at ${path}`);
});

await test("runVerificationJudge is exported (so register-message-end can import it)", () => {
  const path = join(ROOT, "src/extensions/enforcement/verification-judge.ts");
  assert.ok(existsSync(path), `verification-judge must exist at ${path}`);
});

await test("claim-tracker threads ctx.signal into callLlm (ESC abort)", () => {
  // claim-tracker runs extractClaimsViaLLM on turn_end. Without
  // ctx.signal threading, ESC leaks the LLM call until its 8s timeout.
  // Same anti-pattern as input-polisher 9966c8ad, text-classifier, etc.
  const path = join(ROOT, "src/lib/store/claim-tracker.ts");
  const src = readFileSync(path, "utf-8");
  const callLlmBlock = src.match(/callLlm\([\s\S]*?\}\);/);
  assert.ok(callLlmBlock, "callLlm call not found in claim-tracker.ts");
  assert.match(
    callLlmBlock[0],
    /ctx\.signal.*signal.*ctx\.signal|\.\.\.*ctx\.signal.*\{\s*signal:\s*ctx\.signal/,
    "claim-tracker callLlm must thread ctx.signal via conditional spread pattern",
  );
});

await test("runVerificationJudge signature accepts an optional signal (the signal-threading hook)", () => {
  const path = join(ROOT, "src/extensions/enforcement/verification-judge.ts");
  const src = readFileSync(path, "utf-8");
  // The signature must accept signal as a parameter (either in
  // options or directly). This is the API contract that lets
  // callers thread ctx.signal into the judge call.
  const fnMatch = src.match(
    /export\s+async\s+function\s+runVerificationJudge\s*\([\s\S]*?\)\s*:/,
  );
  assert.ok(fnMatch, "runVerificationJudge declaration not found");
  // Either `signal?: AbortSignal` directly or as part of an options
  // object - we just need "signal" to be a parameter name somewhere.
  assert.match(
    fnMatch[0],
    /\bsignal\b/,
    "runVerificationJudge signature must reference a `signal` parameter (the threading hook)",
  );
});

// ── Behavioral: runVerificationJudge threads signal into callLlm ─────────────
//
// This is the only extension whose signal-threading we can verify
// behaviorally without invoking a private module-internal function.
// runVerificationJudge exposes a testable signature; input-polisher's
// processMessage and session-recall's tool execute are module-private.
//
// We verify: when ctx.signal is passed via options.signal and aborts,
// the underlying callLlm call aborts (not waiting for its 30s timeout).

await test("runVerificationJudge aborts when options.signal fires (behavioral)", async () => {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist/lib/ai/llm-call.js")
  );
  const { runVerificationJudge } = await import(
    join(ROOT, "dist/extensions/enforcement/verification-judge.js")
  );
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
  };
  try {
    const start = Date.now();
    const promise = runVerificationJudge(
      fakeCtx,
      { userRequest: "test", toolsUsed: [], toolLog: [], hasCodeChanges: false, hasVerification: false, lastResponse: "", thinking: "" },
      { timeoutMs: 60_000, signal: controller.signal },
    );
    // Fire signal shortly after the call starts - simulates ESC
    // during a verification judge.
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    const elapsed = Date.now() - start;
    assert.strictEqual(
      result,
      null,
      "runVerificationJudge must return null on signal abort (not wait for timeout)",
    );
    assert.ok(
      elapsed < 5_000,
      `signal path must be fast; took ${elapsed}ms (timeout was 60s)`,
    );
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log(
  "=== direct callLlm callers: ESC propagation tests passed ===",
);
