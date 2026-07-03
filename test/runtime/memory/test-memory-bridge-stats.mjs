/**
 * Test: memory-bridge stats tracking (added 2026-06-22).
 *
 * BACKGROUND:
 *   An audit of 246 sessions found 0.84% of tool calls hit a memory_*
 *   tool, with 8 of the last 10 sessions using zero memory tools. The
 *   fix is the MEMORY_AWARENESS directive in identity.ts plus the
 *   pointer-block rendering in memory-section.ts. This counter is the
 *   measurement: per-session, per-tool invocation count, logged at
 *   session_end so the next 100 sessions can show whether the fix is
 *   landing.
 *
 * This test verifies:
 *   1. `createMemoryBridgeStats` returns a fresh state.
 *   2. `recordMemoryToolCall(ctx, tool)` increments the counter and
 *      tracks per-tool breakdown.
 *   3. State is per-session (different ctx -> different state).
 *   4. Source-level: each memory_* tool's execute calls
 *      `recordMemoryToolCall` and the session_end hook is registered.
 *   5. No-ctx calls are safe (no crash, no increment).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BRIDGE_PATH = join(ROOT, "src/extensions/memory/memory-agent-bridge/index.ts");
const DIST_PATH = join(ROOT, "dist/extensions/memory/memory-agent-bridge/index.js");
const STORE_TOOL_PATH = join(ROOT, "src/extensions/memory/memory-agent-bridge/memory-store-tool.ts");
const MEMORY_TOOL_PATH = join(ROOT, "src/extensions/memory/memory-agent-bridge/memory-tool.ts");

assert.ok(existsSync(BRIDGE_PATH), "memory-agent-bridge source must exist");
const bridgeSrc = readFileSync(BRIDGE_PATH, "utf-8");
const storeToolSrc = readFileSync(STORE_TOOL_PATH, "utf-8");
const memoryToolSrc = readFileSync(MEMORY_TOOL_PATH, "utf-8");

console.log("=== memory-bridge stats tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
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
  const { createMemoryBridgeStats, getMemoryBridgeStats, recordMemoryToolCall } = await import(
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
  assert.ok(typeof stats.lastCallAt === "number" && stats.lastCallAt >= stats.firstCallAt, "lastCallAt set");
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
  assert.strictEqual(
    Object.keys(statsA.perToolCounts).length,
    1,
    "session A tracks 1 tool",
  );
  assert.strictEqual(
    Object.keys(statsB.perToolCounts).length,
    2,
    "session B tracks 2 tools",
  );
});

await test("recordMemoryToolCall with no ctx is a safe no-op", async () => {
  const { recordMemoryToolCall } = await import(DIST_PATH);
  // Should not throw.
  recordMemoryToolCall(undefined, "memory_store");
  recordMemoryToolCall(undefined, "memory:anything");
  // If we got here, the no-op succeeded.
  assert.ok(true, "no-ctx call did not throw");
});

// ── Structural: source-level wiring checks ─────────────────────────────────
//
// These catch regressions where someone removes the instrumentation
// (e.g. during a refactor) without realizing the audit depends on it.

await test("memory-agent-bridge exports MemoryBridgeStats interface", () => {
  assert.match(
    bridgeSrc,
    /export\s+interface\s+MemoryBridgeStats/,
    "MemoryBridgeStats must be exported",
  );
  assert.match(bridgeSrc, /memoryToolCalls/);
  assert.match(bridgeSrc, /firstCallAt/);
  assert.match(bridgeSrc, /lastCallAt/);
  assert.match(bridgeSrc, /perToolCounts/);
});

await test("memory-agent-bridge exports stats helpers", () => {
  assert.match(bridgeSrc, /export\s*\{[^}]*createMemoryBridgeStats[^}]*\}/);
  assert.match(bridgeSrc, /export\s*\{[^}]*getMemoryBridgeStats[^}]*\}/);
  assert.match(bridgeSrc, /export\s*\{[^}]*recordMemoryToolCall[^}]*\}/);
});

await test("memory_store tool's execute records the call", () => {
  // memory_store tool is now in ./memory-store-tool.ts (P2-10d split).
  assert.match(
    storeToolSrc,
    /name:\s*"memory_store"[\s\S]*?execute:\s*async[\s\S]*?recordMemoryToolCall\(\s*ctx\s*,\s*"memory_store"\s*\)/,
    "memory_store execute must call recordMemoryToolCall(ctx, 'memory_store')",
  );
});

await test("unified memory tool's execute records per-action calls", () => {
  // memory tool is now in ./memory-tool.ts (P2-10d split).
  assert.match(
    memoryToolSrc,
    /name:\s*"memory"[\s\S]*?execute:\s*async[\s\S]*?recordMemoryToolCall\(\s*ctx\s*,\s*`memory:\$/,
    "unified memory execute must call recordMemoryToolCall(ctx, `memory:${action}`)",
  );
});

await test("session_shutdown hook is registered with the usage summary log", () => {
  // pi's actual end-of-session event is "session_shutdown" (aliased as
  // SESSION_SHUTDOWN in lib/core/event-names.ts). The SESSION_END
  // constant in event-names.ts is for the internal event-bus, NOT
  // pi.on. We use the SESSION_SHUTDOWN constant so the single-ownership
  // lint test passes (it bans raw event strings in non-constant files).
  assert.match(
    bridgeSrc,
    /pi\.on\(\s*SESSION_SHUTDOWN\s*,/,
    "session_shutdown hook must use the SESSION_SHUTDOWN constant (not the SESSION_END misnomer, not a raw string)",
  );
  assert.match(
    bridgeSrc,
    /SESSION_SHUTDOWN[\s\S]*?audit baseline 0\.84%/,
    "session_shutdown log must include the audit baseline 0.84%",
  );
});

await test("session_end log includes the audit baseline 0.84%", () => {
  // Same as above but a lighter check: the baseline number is referenced.
  assert.match(bridgeSrc, /0\.84%/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== memory-bridge stats tests passed ===");
