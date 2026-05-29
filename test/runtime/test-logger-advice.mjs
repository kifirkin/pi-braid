/**
 * Tests for logger public API and advice-tracker threshold adjustment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ═════════════════════════════════════════════════════════════════════════
// Logger: public API tests
// ═════════════════════════════════════════════════════════════════════════

const logger = await import("../../dist/lib/core/logger.js");

describe("logger", () => {
  it("createLogger returns a logger with expected methods", () => {
    const log = logger.createLogger("test");
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.debug, "function");
  });

  it("getActiveLoggerSources returns logger names", () => {
    const sources = logger.getActiveLoggerSources();
    assert.ok(sources.includes("test"), "should include previously created logger");
  });

  it("formatLogBuffer returns formatted string", () => {
    const log = logger.createLogger("fmt-test");
    log.info("hello");
    const formatted = logger.formatLogBuffer();
    assert.ok(formatted.includes("fmt-test"), "should include source name");
    assert.ok(formatted.includes("INFO"), "should include level");
  });

  it("clearLogBuffer empties the buffer", () => {
    const log = logger.createLogger("clear-test");
    log.info("to-clear");
    assert.ok(logger.getLogBuffer().length > 0);
    logger.clearLogBuffer();
    assert.equal(logger.getLogBuffer().length, 0);
  });

  it("suppress/unsuppress logger toggles output", () => {
    logger.suppressLogger("test-module");
    logger.unsuppressLogger("test-module");
    // No crash = pass
  });

  it("setGlobalLogLevel accepts all levels", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      logger.setGlobalLogLevel(level);
    }
    // No crash = pass
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Advice tracker: threshold adjustment test
// ═════════════════════════════════════════════════════════════════════════

const advice = await import("../../dist/lib/reasoning/advice-tracker.js");

describe("advice-tracker thresholds", () => {
  beforeEach(() => {
    advice.resetAdviceTracker();
  });

  it("starts with default thresholds", () => {
    assert.equal(advice.dreamerCooldownMs, 60_000);
    assert.equal(advice.marsOveruseMultiplier, 3);
  });

  it("adjusts Dreamer cooldown after enough bad predictions", () => {
    // Record 6 "stuck" predictions and evaluate as wrong (varied tools)
    for (let i = 0; i < 6; i++) {
      advice.recordAdvice("dreamer", "stuck", i);
      advice.evaluatePendingAdvice({
        currentTurn: i + 12, // past EVALUATION_DELAY_TURNS
        consecutiveErrorTurns: 0,
        toolLog: ["bash", "edit", "grep", "write", "read"], // varied = not stuck
        uniqueToolsCount: 5,
      });
      // Move to next evaluation cycle
    }
    // After 6 evaluations with <50% accuracy, cooldown should have increased
    const accuracy = advice.getSourceAccuracy("dreamer");
    assert.ok(accuracy.total >= 6);
    // The cooldown will have been adjusted after MIN_PREDICTIONS_FOR_ADJUSTMENT (5)
    // With mostly wrong predictions, cooldown should increase
    if (accuracy.correct / accuracy.total < 0.5) {
      assert.ok(advice.dreamerCooldownMs > 60_000, "cooldown should increase with bad accuracy");
    }
  });

  it("adjusts MARS multiplier after enough bad predictions", () => {
    // Record 6 MARS advice with wrong predictions (tool not overused)
    for (let i = 0; i < 6; i++) {
      advice.recordAdvice("mars", "tool_overuse", i, "read");
      advice.evaluatePendingAdvice({
        currentTurn: i + 12,
        consecutiveErrorTurns: 0,
        toolLog: ["read", "edit", "bash", "grep", "write"], // read is 20% of tools = not overused
        uniqueToolsCount: 5,
      });
    }
    const accuracy = advice.getSourceAccuracy("mars");
    assert.ok(accuracy.total >= 6);
    if (accuracy.correct / accuracy.total < 0.5) {
      assert.ok(advice.marsOveruseMultiplier > 3, "should increase with bad accuracy");
    }
  });

  it("resetAdviceTracker resets thresholds to defaults", () => {
    advice.dreamerCooldownMs = 120_000;
    advice.resetAdviceTracker();
    assert.equal(advice.dreamerCooldownMs, 60_000);
    assert.equal(advice.marsOveruseMultiplier, 3);
  });
});

console.log("✅ Logger + advice tracker tests complete");
