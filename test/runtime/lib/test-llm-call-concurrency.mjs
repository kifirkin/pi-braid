/**
 * Test: LLM call per-model concurrency limiter.
 *
 * HISTORY (2026-06-15):
 *   User reported input-critic firing 3+ TIER 2 failures within 1 second.
 *   Root cause: critiqueInput() runs 4 classify() calls in parallel via
 *   Promise.allSettled. All four hit the same utility model concurrently.
 *   When the utility model is rate-limited or has a per-connection limit
 *   (e.g., Venice "minimax-m3 a0-venice"), the burst triggers 429s and
 *   the global cooldown locks out subsequent calls for 60s.
 *
 * FIX: A per-model concurrency limiter in llm-call.ts. When callLlm is
 * invoked for a model, it acquires a slot. If the model already has
 * MAX_CONCURRENT_PER_MODEL=2 calls in flight, the call waits. This
 * turns bursts into a small queue, eliminating rate-limit triggers.
 *
 * This test pins the limiter contract at the source level (we can't
 * easily test the actual LLM call without mocking completeSimple).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src/lib/ai/llm-call.ts");

assert.ok(existsSync(SRC), "llm-call.ts must exist");
const src = readFileSync(SRC, "utf-8");

console.log("=== LLM call per-model concurrency limiter ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

test("MAX_CONCURRENT_PER_MODEL constant exists and is small (1-4)", () => {
  const m = src.match(/MAX_CONCURRENT_PER_MODEL\s*=\s*(\d+)/);
  assert.ok(m, "MAX_CONCURRENT_PER_MODEL must be defined");
  const n = parseInt(m[1], 10);
  assert.ok(
    n >= 1 && n <= 4,
    `MAX_CONCURRENT_PER_MODEL should be a small positive number (1-4). Got: ${n}. ` +
      `Higher values defeat the rate-limit protection; lower values serialize too aggressively.`,
  );
});

test("acquireModelSlot function exists", () => {
  assert.match(
    src,
    /async function acquireModelSlot\(modelId: string\): Promise<void>/,
    "acquireModelSlot must be a function returning Promise<void>",
  );
});

test("releaseModelSlot function exists", () => {
  assert.match(
    src,
    /function releaseModelSlot\(modelId: string\)/,
    "releaseModelSlot must be a function (not async, just unblocks waiters)",
  );
});

test("Per-model lock map keyed by modelId", () => {
  assert.match(
    src,
    /const _modelLocks = new Map<string,\s*ModelLock>/,
    "Per-model lock must be keyed by modelId so different models don't block each other",
  );
});

test("acquireModelSlot returns immediately when slot available", () => {
  const fnBody = src.match(/async function acquireModelSlot[\s\S]*?\n\}/);
  assert.ok(fnBody, "acquireModelSlot body not found");
  assert.ok(
    /if \(lock\.active < MAX_CONCURRENT_PER_MODEL\) \{[\s\S]*?lock\.active\+\+/.test(fnBody[0]),
    "When slot is available, increment active and return immediately (no Promise allocation)",
  );
});

test("acquireModelSlot queues when at capacity (no spinning)", () => {
  const fnBody = src.match(/async function acquireModelSlot[\s\S]*?\n\}/);
  assert.ok(fnBody, "acquireModelSlot body not found");
  // Must use a Promise queue, not busy-wait. The pattern: push a resolver
  // to waiters; releaseModelSlot pops and calls the resolver.
  assert.ok(
    /new Promise<void>\s*\(/.test(fnBody[0]) && /lock!?\.waiters\.push\(/.test(fnBody[0]),
    "When at capacity, push a resolver to waiters and return a Promise (no busy-wait)",
  );
});

test("releaseModelSlot pops the FIFO waiter and unblocks", () => {
  const fnBody = src.match(/function releaseModelSlot[\s\S]*?\n\}/);
  assert.ok(fnBody, "releaseModelSlot body not found");
  // shift() is FIFO. Calling the resolver increments active (so the
  // released slot is consumed by the next waiter, not returned to pool).
  assert.ok(
    /lock\.waiters\.shift\(\)/.test(fnBody[0]) && /next\(\)/.test(fnBody[0]),
    "releaseModelSlot must use FIFO shift() and call the resolver (which increments active)",
  );
});

test("Slot is acquired ONCE per callLlm invocation (not per retry)", () => {
  // Critical: if we acquired per retry, MAX_CONCURRENT_PER_MODEL would be
  // per-attempt (not per-call), and a 5-attempt retry sequence would
  // hold a slot for ~5*timeoutMs. We want one slot per logical call.
  const callLlmBody = src.match(/export async function callLlm[\s\S]*?\n\}/);
  assert.ok(callLlmBody, "callLlm body not found");
  // acquireModelSlot should appear once at the top, not inside the loop
  const acquireCount = (callLlmBody[0].match(/acquireModelSlot\(/g) || []).length;
  assert.ok(
    acquireCount === 1,
    `acquireModelSlot must be called exactly once per callLlm. Found: ${acquireCount}`,
  );
});

test("Slot is released in a finally block (always released)", () => {
  // The slot must be released on every return path: success, error,
  // circuit-breaker early return. try/finally is the only safe pattern.
  const callLlmBody = src.match(/export async function callLlm[\s\S]*?\n\}/);
  assert.ok(callLlmBody, "callLlm body not found");
  assert.ok(
    /try \{[\s\S]*?finally \{[\s\S]*?releaseModelSlot\(/m.test(callLlmBody[0]),
    "releaseModelSlot must be in a finally block to ensure it runs on every return path",
  );
});

test("acquireModelSlot is awaited (not fire-and-forget)", () => {
  const callLlmBody = src.match(/export async function callLlm[\s\S]*?\n\}/);
  assert.ok(callLlmBody, "callLlm body not found");
  assert.ok(
    /await acquireModelSlot\(/.test(callLlmBody[0]),
    "Must await acquireModelSlot so the call waits in the queue",
  );
});

test("Limiter is not the same as rate-limit cooldown (coexisting safety nets)", () => {
  // The concurrency limiter and the rate-limit cooldown solve different
  // problems:
  //   - Limiter: prevents bursts from triggering rate limits in the first place
  //   - Cooldown: when a rate limit IS hit, skip calls for 60s to let it recover
  // Both should remain. Removing one would regress the protection.
  assert.match(
    src,
    /RATE_LIMIT_COOLDOWN_MS/,
    "RATE_LIMIT_COOLDOWN_MS must still exist (coexisting safety net)",
  );
  assert.match(
    src,
    /MAX_CONCURRENT_PER_MODEL/,
    "MAX_CONCURRENT_PER_MODEL must also exist (concurrency limiter)",
  );
});

test("Limiter scope is per-model (different models don't block each other)", () => {
  // If the lock were global, the utility model being busy would also
  // block the session model. The map is keyed by model.id so different
  // models have independent pools.
  assert.match(
    src,
    /acquireModelSlot\(model\.id\)/,
    "acquireModelSlot must be called with model.id (per-model scope, not global)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== LLM concurrency limiter regression tests passed ===");
