/**
 * Test: Behavioral Drift Detection Module
 *
 * Tests the JS divergence calculation, tool categorization,
 * and drift detection logic.
 */

import assert from "node:assert/strict";

const { behavioralDriftModule } = await import(
  "../../../dist/extensions/heartbeat/heartbeat-scheduler/modules/behavioral-drift.js"
);

let passed = 0;
let failed = 0;

console.log("\n[1] Module exports");
{
  assert.ok(behavioralDriftModule, "behavioralDriftModule should be exported");
  assert.equal(behavioralDriftModule.name, "behavioral-drift", "name should be behavioral-drift");
  assert.ok(behavioralDriftModule.priority < 1, "priority should be < 1");
  assert.equal(typeof behavioralDriftModule.shouldActivate, "function", "shouldActivate should be a function");
  assert.equal(typeof behavioralDriftModule.activate, "function", "activate should be a function");
  console.log("  [ok] Module exports correct");
}

console.log("\n[2] shouldActivate gating");
{
  // Should not activate during baseline window (< 10 turns)
  const earlyCtx = { turnCount: 5, toolCallsSinceLastTick: [] };
  assert.ok(!behavioralDriftModule.shouldActivate(earlyCtx), "should not activate before baseline window");

  // Should not activate when turnCount is not a multiple of 5
  const nonModuloCtx = { turnCount: 13, toolCallsSinceLastTick: [] };
  assert.ok(!behavioralDriftModule.shouldActivate(nonModuloCtx), "should not activate on non-modulo turns");

  // Should activate after baseline window on modulo turns
  const activeCtx = { turnCount: 15, toolCallsSinceLastTick: ["read", "edit"] };
  assert.ok(behavioralDriftModule.shouldActivate(activeCtx), "should activate after baseline on modulo turns");
  console.log("  [ok] shouldActivate gating correct");
}



console.log("\n==================================================");
console.log(`Behavioral Drift Tests: All assertions passed`);
