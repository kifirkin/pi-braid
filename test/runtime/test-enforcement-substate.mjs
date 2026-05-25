/**
 * Test: Enforcement sub-state helpers (pure functions, no pi dependency).
 *
 * Tests the helpers extracted from the enforcement God Object:
 * - startJudge / completeJudge / shouldRunJudge / recordCalibration
 * - recordMemoryAccess / shouldNudgeForMemory / markMemoryNudgeSent
 * - recordContextTool / markNudgeSent / resetNudge / inOverflowRecovery
 * - recordThink / recordToolChainCall / resetScratchpadNudge
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the sub-state helpers. They operate on EnforcementState objects.
import {
  startJudge,
  completeJudge,
  shouldRunJudge,
  recordCalibration,
  shouldNudgeForMemory,
  markMemoryNudgeSent,
  recordContextTool,
  markNudgeSent,
  resetNudge,
  inOverflowRecovery,
  resetScratchpadNudge,
  recordToolChainCall,
  createState,
} from "../../dist/extensions/enforcement/state.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeState() {
  return createState();
}

// ── Verification Judge ────────────────────────────────────────────────────

describe("Verification Judge helpers", () => {
  it("startJudge returns true and sets running + timestamp", () => {
    const s = makeState();
    assert.equal(s.verificationJudgeRunning, false);
    assert.equal(s.lastJudgeTime, 0);

    const ok = startJudge(s);
    assert.equal(ok, true);
    assert.equal(s.verificationJudgeRunning, true);
    assert.ok(s.lastJudgeTime > 0, "timestamp set");
  });

  it("startJudge returns false when already running", () => {
    const s = makeState();
    startJudge(s);
    const ok = startJudge(s);
    assert.equal(ok, false);
  });

  it("completeJudge clears running and records turn", () => {
    const s = makeState();
    startJudge(s);
    completeJudge(s, 42);
    assert.equal(s.verificationJudgeRunning, false);
    assert.equal(s.lastVerificationJudgeTurn, 42);
  });

  it("shouldRunJudge returns false when running", () => {
    const s = makeState();
    startJudge(s);
    assert.equal(shouldRunJudge(s, 10), false);
  });

  it("shouldRunJudge returns false if turn gap too small", () => {
    const s = makeState();
    s.lastVerificationJudgeTurn = 9;
    assert.equal(shouldRunJudge(s, 10, 2), false);
    assert.equal(shouldRunJudge(s, 11, 2), true);
  });

  it("recordCalibration pushes and caps at 50", () => {
    const s = makeState();
    recordCalibration(s, 0.9, 1, "bash", 1);
    recordCalibration(s, 0.5, 0, "edit", 2);
    assert.equal(s.calibrationPairs.length, 2);
    assert.equal(s.calibrationPairs[0].tool, "bash");
    assert.equal(s.calibrationPairs[1].actual, 0);
  });
});

// ── Memory Hygiene ─────────────────────────────────────────────────────────

describe("Memory Hygiene helpers", () => {
  it("shouldNudgeForMemory returns true when threshold exceeded", () => {
    const s = makeState();
    s.hasCodeChanges = true;
    s.turnsSinceMemory = 20;
    assert.equal(shouldNudgeForMemory(s, 20, 20), true);
  });

  it("shouldNudgeForMemory returns false when nudge already sent", () => {
    const s = makeState();
    s.hasCodeChanges = true;
    s.turnsSinceMemory = 20;
    s.memoryNudgeSent = true;
    assert.equal(shouldNudgeForMemory(s, 20, 20), false);
  });

  it("shouldNudgeForMemory returns false when no code changes", () => {
    const s = makeState();
    s.hasCodeChanges = false;
    s.turnsSinceMemory = 20;
    assert.equal(shouldNudgeForMemory(s, 20, 20), false);
  });

  it("markMemoryNudgeSent sets flag", () => {
    const s = makeState();
    s.memoryNudgeSent = false;
    markMemoryNudgeSent(s);
    assert.equal(s.memoryNudgeSent, true);
  });
});

// ── Context Hygiene ────────────────────────────────────────────────────────

describe("Context Hygiene helpers", () => {
  it("recordContextTool updates check turn and resets nudge", () => {
    const s = makeState();
    s.contextNudgeSent = true;
    recordContextTool(s, 15);
    assert.equal(s.lastContextCheckTurn, 15);
    assert.equal(s.contextNudgeSent, false);
  });

  it("markNudgeSent sets flag and check turn", () => {
    const s = makeState();
    markNudgeSent(s, 20);
    assert.equal(s.contextNudgeSent, true);
    assert.equal(s.lastContextCheckTurn, 20);
  });

  it("resetNudge clears flag", () => {
    const s = makeState();
    s.contextNudgeSent = true;
    resetNudge(s);
    assert.equal(s.contextNudgeSent, false);
  });

  it("inOverflowRecovery detects grace period", () => {
    const s = makeState();
    s.overflowRecently = 10;
    assert.equal(inOverflowRecovery(s, 12, 5), true);
    assert.equal(inOverflowRecovery(s, 16, 5), false);
  });

  it("resetScratchpadNudge sets to -100", () => {
    const s = makeState();
    s.lastScratchpadNudgeTurn = 50;
    resetScratchpadNudge(s);
    assert.equal(s.lastScratchpadNudgeTurn, -100);
  });
});

// ── Tool Chain ────────────────────────────────────────────────────────────

describe("Tool Chain helpers", () => {
  it("recordToolChainCall increments totals and tracks exploration", () => {
    const s = makeState();
    recordToolChainCall(s, "read");
    assert.equal(s.totalToolCalls, 1);
    assert.ok(s.uniqueToolsUsed.has("read"));
    assert.equal(s.hasExplored, true);
    assert.equal(s.turnsSinceExplore, 0);

    recordToolChainCall(s, "edit");
    assert.equal(s.totalToolCalls, 2);
    assert.ok(s.uniqueToolsUsed.has("edit"));
  });

  it("recordToolChainCall tracks think tool calls", () => {
    const s = makeState();
    s.currentTurn = 5;
    recordToolChainCall(s, "think");
    assert.equal(s.toolChain.lastThinkCall, 5);
  });
});

console.log("=== Sub-state helper tests complete ===");