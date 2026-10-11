/**
 * Test: MARS tool-usage-analyzer content-change dedup (Step 1 +
 * numeric-drift refinement).
 *
 * Pins the contract: shouldAdvise must not re-emit a near-identical advice
 * message on every cooldown window. The time cooldown alone was not enough —
 * when a pattern persists, generateAdvice re-derives the SAME message from
 * the current pattern, so the mars-handler whispered "bash used N/M times
 * (46%)"every 60s (12+ live repeats observed; still firing in production because
 * the whitespace-only normalize let fresh counters differ each window).
 *
 * Contract:
 * - first occurrence fires;
 * - an identical (or digit-drifting) message after the cooldown is SUPPRESSED;
 * - a structurally different message (different tool name / advice type)
 * RE-EMITS — the situation actually changed;
 * - resetMARS clears the dedup state.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { getExtensionState } = await import("../../../dist/lib/state/extension-state.js");
const { shouldAdvise, resetMARS } =
  await import("../../../dist/lib/reasoning/tool-usage-analyzer.js");

/** Seed enforcement state so buildPattern sees a consecutive-error pattern. */
function seedErrors(ctx, consecutiveErrors) {
  const eState = getExtensionState(ctx, "enforcement", () => ({
    consecutiveErrors,
    toolLog: [],
    enforcementSignals: {},
  }));
  eState.consecutiveErrors = consecutiveErrors;
  eState.toolLog = []; // clear any prior tool distribution so only error_recurrence fires
  eState.enforcementSignals = {};
  return eState;
}

/** Seed a tool log dominated by one tool (severe-overuse branch, no failures). */
function seedToolLog(ctx, dominantTool, count, otherTools = 20) {
  const eState = getExtensionState(ctx, "enforcement", () => ({
    consecutiveErrors: 0,
    toolLog: [],
    enforcementSignals: {},
  }));
  eState.consecutiveErrors = 0;
  eState.toolLog = [];
  for (let i = 0; i < count; i++) eState.toolLog.push(dominantTool);
  for (let i = 0; i < otherTools; i++) eState.toolLog.push(`tool-${i}`);
  return eState;
}

/** Fetch the analyzer's internal state (to simulate cooldown expiry). */
function analyzerState(ctx) {
  return getExtensionState(ctx, "tool-usage-analyzer", () => ({}));
}

describe("MARS content-change dedup", () => {
  let ctx;

  beforeEach(() => {
    ctx = {};
  });

  it("emits the first advice for a pattern", () => {
    seedErrors(ctx, 3);
    const advice = shouldAdvise(ctx);
    assert.ok(advice, "first advice fires");
    assert.equal(advice.type, "error_recurrence");
  });

  it("suppresses an identical advice message after the cooldown expires", () => {
    seedErrors(ctx, 3);
    const first = shouldAdvise(ctx);
    assert.ok(first, "first advice fires");

    // Simulate the cooldown window elapsing while the pattern is unchanged.
    analyzerState(ctx).lastAdviceAt = 0;
    const second = shouldAdvise(ctx);
    assert.equal(second, null, "identical message must not re-emit");
  });

  it("suppresses a digit-drifting tool-overuse message (same tool, ticking counters)", () => {
    seedToolLog(ctx, "bash", 21);
    const first = shouldAdvise(ctx);
    assert.ok(first, "first advice fires");
    assert.equal(first.type, "tool_overuse");
    assert.match(first.message, /^\[mars\] bash used/);

    // Cooldown elapses; the counters drift (bash 21 -> 23, total 41 -> 43)
    // but the tool + structure are unchanged -> must stay suppressed.
    analyzerState(ctx).lastAdviceAt = 0;
    seedToolLog(ctx, "bash", 23);
    const second = shouldAdvise(ctx);
    assert.equal(
      second,
      null,
      "same-tool, ticking-counters message suppressed (numeric drift is noise)",
    );
  });

  it("re-emits when the overused tool changes (material change)", () => {
    seedToolLog(ctx, "bash", 21);
    assert.ok(shouldAdvise(ctx), "bash advice fires");

    analyzerState(ctx).lastAdviceAt = 0;
    seedToolLog(ctx, "read", 21); // different dominant tool
    const second = shouldAdvise(ctx);
    assert.ok(second, "different overused tool re-emits");
    assert.match(second.message, /^\[mars\] read used/);
  });

  it("re-emits when the advice type changes (material change)", () => {
    seedToolLog(ctx, "bash", 21);
    assert.ok(shouldAdvise(ctx), "tool_overuse fires");

    analyzerState(ctx).lastAdviceAt = 0;
    seedErrors(ctx, 5); // error recurrence now dominates
    const second = shouldAdvise(ctx);
    assert.ok(second, "different advice type re-emits");
    assert.equal(second.type, "error_recurrence");
  });

  it("resetMARS clears the dedup state so the same message can fire again", () => {
    seedErrors(ctx, 3);
    assert.ok(shouldAdvise(ctx), "first advice fires");

    analyzerState(ctx).lastAdviceAt = 0;
    assert.equal(shouldAdvise(ctx), null, "identical message suppressed");

    resetMARS(ctx);
    const again = shouldAdvise(ctx);
    assert.ok(again, "after reset the same message fires again");
  });
});
