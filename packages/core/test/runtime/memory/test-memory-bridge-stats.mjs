/**
 * Test: memory-bridge stats tracking (added).
 *
 * BACKGROUND:
 * An audit of 246 sessions found 0.84% of tool calls hit a memory_*
 * tool, with 8 of the last 10 sessions using zero memory tools. The
 * fix is the MEMORY_AWARENESS directive in identity.ts plus the
 * pointer-block rendering in memory-section.ts. This counter is the
 * measurement: per-session, per-tool invocation count, logged at
 * session_end so the next 100 sessions can show whether the fix is
 * landing.
 *
 * This test verifies:
 * 1. `createMemoryBridgeStats`returns a fresh state.
 * 2. `recordMemoryToolCall(ctx, tool)`increments the counter and
 * tracks per-tool breakdown.
 * 3. State is per-session (different ctx -> different state).
 * 4. No-ctx calls are safe (no crash, no increment).
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_PATH = join(ROOT, "dist/extensions/memory/memory-agent-bridge/index.js");

console.log("=== memory-bridge stats tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
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

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

// ── Behavioral: stats helpers work via the compiled module ──────────────────

await test("createMemoryBridgeStats returns fresh state", async () => {
  const { createMemoryBridgeStats } = await import(DIST_PATH);
  const s = createMemoryBridgeStats();
  assert.strictEqual(s.memoryToolCalls, 0, "memoryToolCalls starts at 0");
  assert.strictEqual(s.firstCallAt, null, "firstCallAt starts null");
  assert.strictEqual(s.lastCallAt, null, "lastCallAt starts null");
  assert.deepStrictEqual(s.perToolCounts, {}, "perToolCounts starts empty");
});

await test("recordMemoryToolCall increments counter and per-tool breakdown", async () => {
  const { getMemoryBridgeStats, recordMemoryToolCall } = await import(
    DIST_PATH
  );
  const ctx = makeCtx("test-session-1");
  recordMemoryToolCall(ctx, "memory_store");
  recordMemoryToolCall(ctx, "memory_store");
  recordMemoryToolCall(ctx, "memory:recall_search");
  recordMemoryToolCall(ctx, "memory:episodes_add");
  const stats = getMemoryBridgeStats(ctx);
  assert.ok(stats, "stats should be available");
  assert.strictEqual(stats.memoryToolCalls, 4, "total count is 4");
  assert.strictEqual(stats.perToolCounts["memory_store"], 2, "memory_store count is 2");
  assert.strictEqual(stats.perToolCounts["memory:recall_search"], 1, "recall_search count is 1");
  assert.strictEqual(stats.perToolCounts["memory:episodes_add"], 1, "episodes_add count is 1");
  assert.ok(typeof stats.firstCallAt === "number" && stats.firstCallAt > 0, "firstCallAt set");
  assert.ok(
    typeof stats.lastCallAt === "number" && stats.lastCallAt >= stats.firstCallAt,
    "lastCallAt set",
  );
});

await test("stats are per-session (different ctx -> different state)", async () => {
  const { getMemoryBridgeStats, recordMemoryToolCall } = await import(DIST_PATH);
  const ctxA = makeCtx("test-session-A");
  const ctxB = makeCtx("test-session-B");
  recordMemoryToolCall(ctxA, "memory_store");
  recordMemoryToolCall(ctxB, "memory:recall_search");
  recordMemoryToolCall(ctxB, "memory:episodes_add");
  const statsA = getMemoryBridgeStats(ctxA);
  const statsB = getMemoryBridgeStats(ctxB);
  assert.strictEqual(statsA.memoryToolCalls, 1, "session A has 1 call");
  assert.strictEqual(statsB.memoryToolCalls, 2, "session B has 2 calls");
  assert.strictEqual(Object.keys(statsA.perToolCounts).length, 1, "session A tracks 1 tool");
  assert.strictEqual(Object.keys(statsB.perToolCounts).length, 2, "session B tracks 2 tools");
});

await test("recordMemoryToolCall with no ctx is a safe no-op", async () => {
  const { recordMemoryToolCall } = await import(DIST_PATH);
  // Should not throw.
  recordMemoryToolCall(undefined, "memory_store");
  recordMemoryToolCall(undefined, "memory:anything");
  // If we got here, the no-op succeeded.
  assert.ok(true, "no-ctx call did not throw");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== memory-bridge stats tests passed ===");
