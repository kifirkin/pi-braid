/**
 * Test: postLoopClassify wrapper contract (behavioral + structural).
 *
 * BACKGROUND (2026-06-21 + follow-ups):
 *   detectPatternWithLLM had four hand-rolled guarantees that are
 *   needed by every post-loop LLM call site:
 *     1. ctx.signal threads through to callLlm (ESC propagation)
 *     2. abort log demoted to debug when external signal aborted
 *     3. tier === "failed" → caller-supplied fallback (NOT "unknown")
 *     4. 30s default timeout (was 3s → 5s → 8s → 30s through four
 *        rounds of tuning; 30s is at the upper end of "a minute or
 *        more" the user reported being OK with).
 *
 *   The fix refactored detectPatternWithLLM onto a shared wrapper
 *   `postLoopClassify` (in src/lib/ai/post-loop-classify.ts) so the
 *   next post-loop call site can't get any of these wrong.
 *
 * Previous version of this test was source-grep heavy: it read
 * function bodies with regex (`signal?.aborted === true`, the spread
 * pattern, etc.). Those tests were fragile - they break on whitespace,
 * comment changes, and minor refactors even when behavior is
 * unchanged. The current version uses:
 *   - Behavioral tests for the runtime contracts (timeout actually
 *     fires, signal actually aborts, onFailure actually invoked)
 *     via the callLlm test injection (__setCompleteSimpleForTest).
 *   - Light structural tests for "function exists" / "interface
 *     shape" / "constant value" - cheap to check, valuable for
 *     early detection of catastrophic deletions or wrong values.
 *
 *   Deep callLlm behavior (timeout, signal demotion) is covered in
 *   test-call-llm-behavior.mjs. This file focuses on the wrapper's
 *   own behavior: what it adds on top of classify() and callLlm.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Source-level structural checks (kept minimal) ───────────────────────────
//
// We only check: file exists, function/interface exported, constant
// defined with the right value. These don't break on whitespace or
// comment changes (the previous version's body-grep regex did).

const WRAPPER_PATH = join(ROOT, "src/lib/ai/post-loop-classify.ts");
assert.ok(existsSync(WRAPPER_PATH), "wrapper source must exist");
const wrapperSrc = readFileSync(WRAPPER_PATH, "utf-8");

console.log("=== postLoopClassify wrapper contract tests ===\n");

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

// ── Structural: function and interface exist ─────────────────────────────────

await test("postLoopClassify is exported as an async function", () => {
  assert.match(
    wrapperSrc,
    /export\s+async\s+function\s+postLoopClassify/,
    "postLoopClassify must be an exported async function",
  );
});

await test("PostLoopClassifyOptions interface is exported with onFailure", () => {
  assert.match(
    wrapperSrc,
    /export\s+interface\s+PostLoopClassifyOptions/,
    "PostLoopClassifyOptions must be exported",
  );
  assert.match(
    wrapperSrc,
    /onFailure:\s*\(\s*reason:/,
    "PostLoopClassifyOptions must have an onFailure callback",
  );
});

// ── Structural: default lives in global-state.ts and is wired in ───────────
//
// The default timeout was moved from a local const in this wrapper to a
// process-global slot in `lib/state/global-state.ts` so it can be tuned
// at runtime via `setPostLoopTimeoutMs()` (e.g. from a /command). The
// contract is now: (a) the default is 30000 in global-state, (b) the
// wrapper imports `getPostLoopTimeoutMs`, (c) the wrapper uses it as
// the fallback when `options.timeoutMs` is unset.

const GS_PATH = join(ROOT, "src/lib/state/global-state.ts");
assert.ok(existsSync(GS_PATH), "global-state source must exist");
const gsSrc = readFileSync(GS_PATH, "utf-8");

await test("DEFAULT_POST_LOOP_TIMEOUT_MS is 600000 in global-state.ts (latest tuning)", () => {
  const m = gsSrc.match(
    /export\s+const\s+DEFAULT_POST_LOOP_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/,
  );
  assert.ok(m, "DEFAULT_POST_LOOP_TIMEOUT_MS must be exported from global-state.ts");
  const value = parseInt(m[1].replace(/_/g, ""), 10);
  // History: 3000 → 5000 → 8000 → 30000 → 600000. The current value
  // (600_000 = 10min) reflects the user's 2026-06-23 request: "make
  // huge one like 10 minutes but keep proper esc key handling".
  // Aborts are signal-driven; the timeout is a fallback for orphaned
  // calls. Bump the test constant when bumping the source value.
  assert.strictEqual(
    value,
    600000,
    `DEFAULT_POST_LOOP_TIMEOUT_MS must be 600000 (was 3s→5s→8s→30s→600s). Got: ${value}`,
  );
});

await test("getPostLoopTimeoutMs() returns 600000 by default", () => {
  assert.match(
    gsSrc,
    /export\s+function\s+getPostLoopTimeoutMs/,
    "getPostLoopTimeoutMs must be exported from global-state.ts",
  );
  // Light structural check: the default path must reference the const.
  assert.match(
    gsSrc,
    /getPostLoopTimeoutMs[\s\S]*?DEFAULT_POST_LOOP_TIMEOUT_MS/,
    "getPostLoopTimeoutMs must reference DEFAULT_POST_LOOP_TIMEOUT_MS as its default",
  );
});

await test("post-loop-classify imports getPostLoopTimeoutMs and uses it as fallback", () => {
  assert.match(
    wrapperSrc,
    /import\s*\{[^}]*getPostLoopTimeoutMs[^}]*\}\s*from\s*["'][^"']*global-state/,
    "wrapper must import getPostLoopTimeoutMs from global-state",
  );
  // The fallback expression: `options.timeoutMs ?? getPostLoopTimeoutMs()`.
  assert.match(
    wrapperSrc,
    /options\.timeoutMs\s*\?\?\s*getPostLoopTimeoutMs\s*\(\s*\)/,
    "wrapper must use getPostLoopTimeoutMs() as the options.timeoutMs fallback",
  );
});

await test("post-loop-classify has no local DEFAULT_POST_LOOP_TIMEOUT_MS const", () => {
  // The constant moved to global-state.ts. A leftover local copy would
  // mean the wrapper is reading a stale default and not respecting
  // setPostLoopTimeoutMs().
  assert.doesNotMatch(
    wrapperSrc,
    /const\s+DEFAULT_POST_LOOP_TIMEOUT_MS\b/,
    "post-loop-classify must not redeclare DEFAULT_POST_LOOP_TIMEOUT_MS (moved to global-state.ts)",
  );
});

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
  // The wrapper forces bestEffort: true so post-loop TIER failure
  // warns go to log.debug, not log.warn. We verify by checking the
  // log buffer after a forced failure.
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
  // If ctx.signal is provided and aborts, the underlying callLlm
  // call must abort. We verify by firing ctx.signal mid-call and
  // checking the call returns quickly (not waiting for the timeout).
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
