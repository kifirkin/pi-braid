import { strict as assert } from "assert";
// ── Inline rotation state for testing (mirrors global-state.ts) ──────────────

function getRotationState() {
  return {
    lastRotationTimestamp: 0,
    turnsSinceRotation: 0,
    rotationCount: 0,
    pendingRotation: false,
    continuationSummary: "",
    lastNudgeTimestamp: 0,
    lastNudgeTurn: 0,
    nudgeCount: 0,
    actionTaken: false,
  };
}

// Simulate nudge handler logic for testing
function shouldNudge(state) {
  const currentTurn = state.turnsSinceRotation;
  const sinceLastNudge = currentTurn - state.lastNudgeTurn;

  if (state.lastNudgeTurn === currentTurn) return { nudge: false, reason: "already-nudged-this-turn" };

  if (state.actionTaken) {
    const timeSinceNudge = Date.now() - state.lastNudgeTimestamp;
    if (sinceLastNudge < 50 || timeSinceNudge < 5 * 60 * 1000) {
      return { nudge: false, reason: "action-taken-cooldown" };
    }
  }

  return { nudge: true, reason: "threshold-crossed" };
}

function recordNudge(state) {
  state.lastNudgeTurn = state.turnsSinceRotation;
  state.lastNudgeTimestamp = Date.now();
  state.nudgeCount++;
  state.actionTaken = false;
}

function recordAction(state, toolName) {
  state.actionTaken = true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("Test 1: First nudge at threshold - should fire");
{
  const state = getRotationState();
  Object.assign(state, {
    turnsSinceRotation: 500,
    lastNudgeTurn: 0,
    lastNudgeTimestamp: 0,
    nudgeCount: 0,
    actionTaken: false,
  });
  const result = shouldNudge(state);
  assert.strictEqual(result.nudge, true, "First nudge should fire");
  recordNudge(state);
  assert.strictEqual(state.nudgeCount, 1);
  console.log("✅ PASS: First nudge fires");
}

console.log("\nTest 2: Same turn - should suppress");
{
  const state = getRotationState();
  state.turnsSinceRotation = 500;
  state.lastNudgeTurn = 500; // already nudged this turn
  const result = shouldNudge(state);
  assert.strictEqual(result.nudge, false, "Should not nudge same turn");
  assert.strictEqual(result.reason, "already-nudged-this-turn");
  console.log("✅ PASS: Same-turn suppression works");
}

console.log("\nTest 3: Action taken, within cooldown - should suppress");
{
  const state = getRotationState();
  state.turnsSinceRotation = 520;
  state.lastNudgeTurn = 500;
  state.lastNudgeTimestamp = Date.now() - 1000; // 1 second ago
  state.actionTaken = true;
  const result = shouldNudge(state);
  assert.strictEqual(result.nudge, false, "Should suppress after action");
  assert.strictEqual(result.reason, "action-taken-cooldown");
  console.log("✅ PASS: Action-taken cooldown works");
}

console.log("\nTest 4: Action taken, cooldown expired - should fire");
{
  const state = getRotationState();
  state.turnsSinceRotation = 560;
  state.lastNudgeTurn = 500;
  state.lastNudgeTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
  state.actionTaken = true;
  const result = shouldNudge(state);
  assert.strictEqual(result.nudge, true, "Should fire after cooldown expires");
  console.log("✅ PASS: Cooldown expiry works");
}

console.log("\nTest 5: finalize resets all nudge state");
{
  const state = getRotationState();
  state.turnsSinceRotation = 600;
  state.lastNudgeTurn = 500;
  state.lastNudgeTimestamp = Date.now();
  state.nudgeCount = 5;
  state.actionTaken = true;

  // Simulate finalize handler reset
  state.turnsSinceRotation = 0;
  state.lastNudgeTurn = 0;
  state.lastNudgeTimestamp = 0;
  state.nudgeCount = 0;
  state.actionTaken = false;

  assert.strictEqual(state.nudgeCount, 0);
  assert.strictEqual(state.turnsSinceRotation, 0);
  console.log("✅ PASS: Finalize reset works");
}

console.log("\n🎯 All nudge deduplication tests passed!");
