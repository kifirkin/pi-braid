/**
 * Consolidated unit tests for lib modules with pure functions.
 * Covers consolidation-channel, filter-safe-to-remove, context-density.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── consolidation-channel: scoreEpisode ─────────────────────────────────────

const { scoreEpisode } = await import("../../../dist/lib/events/consolidation-channel.js");

describe("consolidation-channel", () => {
  it("scoreEpisode returns ConsolidationCandidate with episodeId", () => {
    const result = scoreEpisode({
      id: "ep1",
      task: "Fix bug in parser",
      outcome: "success",
    });
    assert.equal(result.episodeId, "ep1");
    assert.equal(result.outcome, "success");
    assert.equal(typeof result.valueScore, "number");
    assert.equal(typeof result.confidenceScore, "number");
    assert.equal(typeof result.noveltyScore, "number");
    assert.equal(typeof result.consolidationScore, "number");
  });

  it("scoreEpisode rates success higher than failure", () => {
    const success = scoreEpisode({ id: "a", task: "x", outcome: "success", quality: 0.8 });
    const failure = scoreEpisode({ id: "b", task: "x", outcome: "failure", quality: 0.8 });
    assert.ok(success.valueScore >= failure.valueScore, "success should score >= failure");
  });

  it("scoreEpisode with SOP gets higher confidence", () => {
    const withSOP = scoreEpisode({
      id: "a",
      task: "x",
      outcome: "success",
      strategicSOP: "Plan before editing",
      functionalSOP: ["read code", "edit fix", "test"],
    });
    const without = scoreEpisode({ id: "b", task: "x", outcome: "success" });
    assert.ok(withSOP.confidenceScore >= without.confidenceScore, "SOP should increase confidence");
  });

  it("scoreEpisode accepts out-of-range quality without crashing", () => {
    const result = scoreEpisode({ id: "a", task: "x", outcome: "success", quality: 5 });
    assert.ok(typeof result.consolidationScore === "number", "should still compute score");
  });
});

// ── filter-safe-to-remove: filterSafeToRemove ──────────────────────────────

const { filterSafeToRemove } = await import("../../../dist/lib/utils/filter-safe-to-remove.js");

describe("filter-safe-to-remove", () => {
  function msg(overrides = {}) {
    return {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("returns filtered array and stats for empty input", () => {
    const result = filterSafeToRemove([]);
    assert.ok(Array.isArray(result.filtered));
    assert.equal(result.filtered.length, 0);
    assert.equal(typeof result.stats.totalRemoved, "number");
  });

  it("returns stats for single message", () => {
    const result = filterSafeToRemove([msg({ role: "user" })]);
    assert.ok(Array.isArray(result.filtered));
    assert.equal(typeof result.stats.totalRemoved, "number");
  });

  it("returns stats for mixed roles", () => {
    const messages = [
      msg({ role: "user", content: "first" }),
      msg({ role: "tool", content: "result", toolCallId: "t1" }),
      msg({ role: "assistant", content: "done" }),
    ];
    const result = filterSafeToRemove(messages);
    assert.ok(result.filtered.length <= messages.length, "filtered should not exceed input");
  });
});

// ── context-density: recommendCompressionStrategy ───────────────────────────

const { recommendCompressionStrategy } =
  await import("../../../dist/lib/detection/context-density.js");

describe("context-density", () => {
  /** Build a valid DensityResult. Uses density + tokenRatio as primary signals. */
  function density(overrides = {}) {
    return {
      density: 0.5,
      signalMessages: 10,
      noiseMessages: 10,
      tokenRatio: 0.3,
      oldestMessageAge: 100,
      messageCount: 20,
      avgMessageLength: 200,
      suggestedActions: [],
      ...overrides,
    };
  }

  it("recommends 'none' for low token ratio + moderate density", () => {
    const strategy = recommendCompressionStrategy(density({ tokenRatio: 0.3, density: 0.5 }));
    assert.equal(strategy, "none", "low token ratio should recommend none");
  });

  it("recommends a non-none strategy for very high token ratio", () => {
    const strategy = recommendCompressionStrategy(density({ tokenRatio: 0.9, density: 0.5 }));
    assert.notEqual(strategy, "none", "high token ratio should recommend a strategy");
  });
});

console.log("[ok] Lib modules tests complete");
