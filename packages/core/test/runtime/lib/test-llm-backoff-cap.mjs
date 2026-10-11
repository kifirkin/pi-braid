/**
 * Test: callLlm retry backoff ceiling (MAX_RETRY_BACKOFF_MS = 120_000).
 *
 * BACKGROUND (outage):
 * During a network outage a retry ladder was observed live sleeping
 * ~9.2 HOURS on one attempt ("Retrying (14/15) in 33033s") — the agent sat
 * wedged silently. The fix contract: a module constant MAX_RETRY_BACKOFF_MS
 * = 120_000 and both retry sites clamp the computed delay with
 * Math.min(computed, MAX_RETRY_BACKOFF_MS). Attempt counts, SDK retries,
 * circuit-breaker logic, and abort handling are unchanged.
 *
 * Two layers of coverage:
 * 1. Behavioral: drive callLlm through a full 15-attempt transient-error
 * ladder (mirrors the live incident's 14/15) with global setTimeout
 * wrapped so backoff sleeps are captured and fired immediately. Assert
 * every recorded backoff delay is <= 120_000 — the loop never sleeps
 * longer than the ceiling between attempts.
 * 2. Source check on the COMPILED dist module: the ceiling constant is
 * declared and both retry sites clamp with
 * Math.min(backoffDelay(attempt), MAX_RETRY_BACKOFF_MS). A pure
 * behavioral probe cannot push today's ladder above 120s through the
 * public API (the ladder tops out at 60s), so this seam check is the
 * regression guard: if the clamp is ever removed, the ceiling no longer
 * holds by construction and this test fails.
 *
 * Follows test-call-llm-behavior.mjs stub style (completeSimple injection via
 * __setCompleteSimpleForTest, imports from dist/ after npm run build).
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Import the COMPILED module from dist/ ───────────────────────────────────
const distPath = join(ROOT, "dist", "lib", "ai", "llm-call.js");
const { callLlm, __setCompleteSimpleForTest } = await import(distPath);
const { clearLogBuffer, getLogBuffer } = await import(
  join(ROOT, "dist", "lib", "core", "logger.js")
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal valid Model object - the stub doesn't read any of its fields. */
const stubModel = {
  id: "stub/test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "stub",
  contextWindow: 100_000,
  maxTokens: 4096,
  reasoning: false,
};

/** Stub that always fails with a transient (non-rate-limit) error. */
function transientErrorStub(callLog) {
  return async (_model, _context, _options) => {
    callLog.push(1);
    return {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "stub",
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: "error",
      // Transient-only (NOT rate-limit): retries the ladder without tripping
      // the 60s rate-limit circuit breaker.
      errorMessage: "503 service unavailable",
      timestamp: Date.now(),
    };
  };
}

// ── Test runner (same minimal style as test-call-llm-behavior.mjs) ───────────

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

console.log("=== callLlm retry backoff ceiling (MAX_RETRY_BACKOFF_MS) ===\n");

await test("retry ladder: every backoff sleep across a 15-attempt ladder stays <= 120_000ms", async () => {
  const callCount = [];
  __setCompleteSimpleForTest(transientErrorStub(callCount));
  clearLogBuffer();

  // Intercept setTimeout: the per-attempt timeout uses timeoutMs (500ms,
  // below the 1000ms interception threshold and cleared after each stub
  // return), while backoff sleeps are >= 4s. Captured backoff sleeps fire
  // immediately so the full 15-attempt ladder completes in milliseconds
  // instead of hours.
  const realSetTimeout = globalThis.setTimeout;
  const backoffDelays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === "number" && ms >= 1000) {
      backoffDelays.push(ms);
      return realSetTimeout(fn, 0);
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    const result = await callLlm(stubModel, "fake-key", "system", "user", {
      maxRetries: 14, // 15 attempts total, mirroring the live "Retrying (14/15)" ladder
      sdkRetries: 0,
      timeoutMs: 500,
    });
    assert.ok(
      "error" in result,
      `expected { error } after ladder exhaustion; got ${JSON.stringify(result)}`,
    );
    // Exhaustion returns the last underlying error (the retry loop returns
    // the final transient message, not a synthetic post-loop string).
    assert.match(
      result.error,
      /503 service unavailable/,
      "exhaustion returns the last transient error",
    );
    assert.strictEqual(
      callCount.length,
      15,
      `ladder must run all 15 attempts (14/15 retries, mirroring the incident); made ${callCount.length}`,
    );
    assert.strictEqual(
      backoffDelays.length,
      14,
      `expected one captured backoff per retry (14), got ${backoffDelays.length}: ${JSON.stringify(backoffDelays)}`,
    );
    for (const d of backoffDelays) {
      assert.ok(
        d <= 120_000,
        `backoff delay ${d}ms exceeds MAX_RETRY_BACKOFF_MS (120_000) — an unbounded ladder regressed`,
      );
    }
    // The log's retry line prints the honest (capped) delay the agent waits,
    // and it is the delay actually slept.
    const loggedDelays = [];
    for (const l of getLogBuffer()) {
      const m = /retrying in (\d+)ms/.exec(l.message);
      if (m) loggedDelays.push(Number(m[1]));
    }
    assert.strictEqual(loggedDelays.length, 14, "one retry log per backoff sleep");
    for (const logged of loggedDelays) {
      assert.ok(
        logged <= 120_000,
        `retry log must print the capped delay; saw ${logged}ms > 120000`,
      );
      assert.ok(
        backoffDelays.includes(logged),
        `logged delay ${logged}ms must be the delay actually slept`,
      );
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    __setCompleteSimpleForTest(null);
  }
});

await test("source check: the compiled retry sites clamp the computed delay to MAX_RETRY_BACKOFF_MS", async () => {
  const src = await readFile(distPath, "utf8");
  assert.match(
    src,
    /MAX_RETRY_BACKOFF_MS\s*=\s*120_?000/,
    "MAX_RETRY_BACKOFF_MS = 120_000 must be declared in the compiled module",
  );
  const clamps = [...src.matchAll(/Math\.min\(backoffDelay\(attempt\),\s*MAX_RETRY_BACKOFF_MS\)/g)];
  assert.ok(
    clamps.length >= 2,
    `both retry sites must clamp the computed delay with Math.min(..., MAX_RETRY_BACKOFF_MS); found ${clamps.length}`,
  );
  // The honest-number contract: the retry logs print the clamped `delay`.
  assert.match(src, /retrying in \$\{delay\}ms/);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== LLM backoff cap tests passed ===");
