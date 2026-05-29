/**
 * Test: Extension State — session-scoped state factory.
 *
 * Verifies that getExtensionState provides isolated state per key+ctx,
 * handles factory functions, type inference, and error cases.
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const { getExtensionState } = await import("../../dist/lib/state/extension-state.js");

// ── [1] Basic state creation ──────────────────────────────────────
console.log("\n[1] Basic state creation");
{
  const ctx = { cwd: "/test/project" };
  const state = getExtensionState(ctx, "test-ext", () => ({ count: 0, items: [] }));
  assert(state.count === 0, "Factory creates initial state");
  assert(Array.isArray(state.items), "Factory creates arrays");
  assert(state.items.length === 0, "Factory creates empty arrays");
}

// ── [2] State persistence across calls ─────────────────────────────
console.log("\n[2] State persistence");
{
  const ctx = { cwd: "/test/project2" };
  const state1 = getExtensionState(ctx, "persist-ext", () => ({ count: 0 }));
  state1.count = 42;

  const state2 = getExtensionState(ctx, "persist-ext", () => ({ count: 0 }));
  assert(state2.count === 42, "State persists across calls with same ctx+key");
}

// ── [3] State isolation by key ────────────────────────────────────
console.log("\n[3] State isolation by key");
{
  const ctx = { cwd: "/test/project3" };
  const stateA = getExtensionState(ctx, "ext-a", () => ({ val: "a" }));
  const stateB = getExtensionState(ctx, "ext-b", () => ({ val: "b" }));
  stateA.val = "modified";
  assert(stateA.val === "modified", "State A can be modified");
  assert(stateB.val === "b", "State B is isolated from A");
}

// ── [4] State isolation by context ────────────────────────────────
console.log("\n[4] State isolation by context");
{
  const ctx1 = { cwd: "/project/alpha" };
  const ctx2 = { cwd: "/project/beta" };

  const state1 = getExtensionState(ctx1, "shared-ext", () => ({ count: 0 }));
  const state2 = getExtensionState(ctx2, "shared-ext", () => ({ count: 0 }));

  state1.count = 100;
  assert(state1.count === 100, "Context 1 has count 100");
  assert(state2.count === 0, "Context 2 has isolated count 0");
}

// ── [5] Factory is called only when needed ────────────────────────
console.log("\n[5] Factory lazy initialization");
{
  const ctx = { cwd: "/test/project5" };
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls++;
    return { created: true };
  };

  const _state1 = getExtensionState(ctx, "lazy-ext", factory);
  assert(factoryCalls === 1, "Factory called once on first access");

  const _state2 = getExtensionState(ctx, "lazy-ext", factory);
  assert(factoryCalls === 1, "Factory NOT called again on second access");
}

// ── [6] TypeScript type inference ─────────────────────────────────
console.log("\n[6] Type inference");
{
  const ctx = { cwd: "/test/type" };
  const state = getExtensionState(ctx, "typed-ext", () => ({
    items: [],
    version: 1,
  }));
  assert(state.version === 1, "Supports typed state via generics");
  assert(Array.isArray(state.items), "Supports typed arrays");
}

// ── [7] Error handling ────────────────────────────────────────────
console.log("\n[7] Error handling");
{
  // Factory that throws should propagate
  const ctx = { cwd: "/test/error" };
  let threw = false;
  try {
    getExtensionState(ctx, "error-ext", () => {
      throw new Error("factory failure");
    });
  } catch {
    threw = true;
  }
  assert(threw, "Factory errors propagate to caller");
}

// ── [8] Get without create (edge case) ────────────────────────────
console.log("\n[8] Edge cases");
{
  // Reading from different ctx objects that represent same session
  const ctxA = { cwd: "/same/path" };
  const ctxB = { cwd: "/same/path" };
  // Note: each unique ctx object gets its own state slot
  const _stateA = getExtensionState(ctxA, "same-key", () => ({ x: 1 }));
  const stateB = getExtensionState(ctxB, "same-key", () => ({ x: 2 }));
  assert(stateB.x === 2, "Different ctx objects get separate state (by design)");
}

// Summary
console.log("\n" + ("=").repeat(50));
console.log("Extension State Tests: " + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
