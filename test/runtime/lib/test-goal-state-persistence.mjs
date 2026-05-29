// Test: Goal state persistence across tool calls with updated extension-state.ts
// This verifies that getExtensionState uses session-stable keys instead of WeakMap

// ── Inline GoalManager for test (can't import from .ts source) ─────────────
class GoalManager {
  constructor() {
    this._goals = new Map();
  }
  addGoal(description, criteria) {
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this._goals.set(id, { id, description, criteria, status: "pending" });
    return id;
  }
  list() {
    return Array.from(this._goals.values());
  }
  complete(id) {
    const g = this._goals.get(id);
    if (g) g.status = "completed";
    return !!g;
  }
}

// ── Inline getExtensionState with session-stable keys ───────────────────────
const _sessionState = new Map();
const _stateBuckets = new WeakMap();

function getExtensionState(ctx, key, factory) {
  // Extract stable session key (matches updated extension-state.ts)
  const sm = ctx.sessionManager;
  let sessionKey;
  if (sm) {
    try {
      sessionKey = sm.getSessionFile?.() ?? sm.getSessionId?.();
    } catch { /* ignore */ }
  }
  if (!sessionKey) {
    sessionKey = ctx.agentId ?? ctx.runId;
  }

  if (sessionKey) {
    if (!_sessionState.has(sessionKey)) {
      _sessionState.set(sessionKey, new Map());
    }
    const bucket = _sessionState.get(sessionKey);
    if (!bucket.has(key)) {
      bucket.set(key, factory());
    }
    return bucket.get(key);
  }

  // Legacy fallback
  if (!_stateBuckets.has(ctx)) {
    _stateBuckets.set(ctx, new Map());
  }
  const bucket = _stateBuckets.get(ctx);
  if (!bucket.has(key)) {
    bucket.set(key, factory());
  }
  return bucket.get(key);
}

// ── Tests ──────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

// Test 1: Stable session manager → survives ctx recreation
const sessionManager = { getSessionFile: () => "/tmp/session-abc.json" };
const ctx1a = { sessionManager };
const state1a = getExtensionState(ctx1a, "planner", () => ({ gm: new GoalManager() }));
const goalId = state1a.gm.addGoal("test goal", ["criterion"]);

const ctx1b = { sessionManager }; // Different object, same session
const state1b = getExtensionState(ctx1b, "planner", () => ({ gm: new GoalManager() }));

if (state1a === state1b) {
  pass++;
  console.log("PASS: Same session manager → same state object (survives ctx recreation)");
} else {
  fail++;
  console.error("FAIL: Same session manager but different state objects!");
}

if (state1b.gm.list().length === 1 && state1b.gm.list()[0].id === goalId) {
  pass++;
  console.log("PASS: Goal persisted across ctx recreation");
} else {
  fail++;
  console.error("FAIL: Goal NOT persisted across ctx recreation!");
}

// Test 2: Complete goal from different ctx
state1b.gm.complete(goalId);
const state1c = getExtensionState({ sessionManager }, "planner", () => ({ gm: new GoalManager() }));
if (state1c.gm.list()[0].status === "completed") {
  pass++;
  console.log("PASS: Goal completion persisted across ctx recreation");
} else {
  fail++;
  console.error("FAIL: Goal completion NOT persisted!");
}

// Test 3: Different session → different state
const otherSession = { getSessionFile: () => "/tmp/session-xyz.json" };
const state2 = getExtensionState({ sessionManager: otherSession }, "planner", () => ({ gm: new GoalManager() }));

if (state2.gm.list().length === 0) {
  pass++;
  console.log("PASS: Different session → fresh state");
} else {
  fail++;
  console.error("FAIL: Different session leaked goals!");
}

// Test 4: Legacy fallback (no sessionManager) — WeakMap behavior
const noSessionCtx1 = {};
const legacyState1 = getExtensionState(noSessionCtx1, "legacy", () => ({ value: 42 }));
legacyState1.value = 100;

const noSessionCtx2 = {}; // Different object
const legacyState2 = getExtensionState(noSessionCtx2, "legacy", () => ({ value: 42 }));

if (legacyState2.value === 42) {
  pass++;
  console.log("PASS: Legacy fallback (no sessionManager) → WeakMap, different ctx = different state");
} else {
  fail++;
  console.error("FAIL: Legacy fallback leaked state across ctx objects!");
}

// Test 5: Fallback with agentId
const ctxWithAgent = { agentId: "agent-007" };
const agentState1 = getExtensionState(ctxWithAgent, "planner", () => ({ gm: new GoalManager() }));
agentState1.gm.addGoal("agent goal", ["done"]);

const ctxWithSameAgent = { agentId: "agent-007" };
const agentState2 = getExtensionState(ctxWithSameAgent, "planner", () => ({ gm: new GoalManager() }));

if (agentState2.gm.list().length === 1) {
  pass++;
  console.log("PASS: agentId fallback works for session stability");
} else {
  fail++;
  console.error("FAIL: agentId fallback failed!");
}

console.log(`\nGoal State Persistence Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
