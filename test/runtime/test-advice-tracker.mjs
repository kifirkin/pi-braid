/**
 * Test: Advice Tracker — feedback loop for Dreamer/MARS predictions.
 *
 * Tests recording, evaluation, and threshold adjustment logic.
 * All tests use pure functions with no pi dependency.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  recordAdvice,
  evaluatePendingAdvice,
  getSourceAccuracy,
  getPendingAdvice,
  resetAdviceTracker,
  dreamerCooldownMs,
  marsOveruseMultiplier,
} = await import("../../dist/lib/advice-tracker.js");

describe("Advice Tracking", () => {
  beforeEach(() => {
    resetAdviceTracker();
  });

  it("records a dreamer advice with prediction", () => {
    const id = recordAdvice("dreamer", "stuck", 5);
    assert.ok(id.startsWith("adv-dreamer-"), "ID has correct prefix");
  });

  it("records a MARS advice with tool name", () => {
    const id = recordAdvice("mars", "tool_overuse", 3, "bash");
    assert.ok(id.startsWith("adv-mars-"), "ID has correct prefix");
  });

  it("returns pending advice", () => {
    recordAdvice("dreamer", "stuck", 5);
    const pending = getPendingAdvice();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].evaluated, false);
  });

  it("evaluates dreamer stuck prediction as correct when tools repeat", () => {
    recordAdvice("dreamer", "stuck", 1);
    const evalCtx = {
      currentTurn: 12, // EVALUATION_DELAY_TURNS = 10
      consecutiveErrorTurns: 0,
      toolLog: ["read", "read", "read", "read", "read"],
      uniqueToolsCount: 1,
    };
    const evaluated = evaluatePendingAdvice(evalCtx);
    assert.equal(evaluated, 1, "should evaluate 1 record");
    const pending = getPendingAdvice();
    assert.equal(pending.length, 0, "no pending after evaluation");
  });

  it("evaluates dreamer stuck prediction as incorrect when tools vary", () => {
    recordAdvice("dreamer", "stuck", 1);
    const evalCtx = {
      currentTurn: 12,
      consecutiveErrorTurns: 0,
      toolLog: ["read", "bash", "edit", "grep", "write"],
      uniqueToolsCount: 5,
    };
    const evaluated = evaluatePendingAdvice(evalCtx);
    assert.equal(evaluated, 1, "should evaluate 1 record");
  });

  it("evaluates dreamer failure prediction as correct on consecutive errors", () => {
    recordAdvice("dreamer", "failure", 1);
    const evalCtx = {
      currentTurn: 12,
      consecutiveErrorTurns: 3,
      toolLog: ["bash", "bash"],
      uniqueToolsCount: 1,
    };
    const evaluated = evaluatePendingAdvice(evalCtx);
    assert.equal(evaluated, 1, "should evaluate 1 record");
  });

  it("does not evaluate advice before EVALUATION_DELAY_TURNS elapse", () => {
    recordAdvice("dreamer", "stuck", 5);
    const evalCtx = {
      currentTurn: 6, // only 1 turn later
      consecutiveErrorTurns: 0,
      toolLog: [],
      uniqueToolsCount: 0,
    };
    const evaluated = evaluatePendingAdvice(evalCtx);
    assert.equal(evaluated, 0, "should not evaluate before delay");
  });

  it("tracks accuracy metrics per source", () => {
    recordAdvice("dreamer", "stuck", 1);
    recordAdvice("dreamer", "stuck", 1);
    // Use a repeating-tools context so predictions are correct
    const evalCtx = {
      currentTurn: 12,
      consecutiveErrorTurns: 0,
      toolLog: ["read", "read", "read"],
      uniqueToolsCount: 1,
    };
    evaluatePendingAdvice(evalCtx);

    const accuracy = getSourceAccuracy("dreamer");
    assert.equal(accuracy.total, 2);
  });

  it("reset clears all records and thresholds", () => {
    recordAdvice("dreamer", "stuck", 1);
    resetAdviceTracker();
    assert.equal(getPendingAdvice().length, 0);
    assert.equal(dreamerCooldownMs, 60_000);
    assert.equal(marsOveruseMultiplier, 3);
  });
});

console.log("✅ Advice tracker tests complete");
