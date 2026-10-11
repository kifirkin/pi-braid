/**
 * Test: lib/dreamer.ts - tool sequence predictor (enforcement dreamer).
 *
 * Tests the pure functions: simulatePaths() and dream() return values.
 * Does NOT test the heartbeat dreamer module (test-dreamer.mjs covers that).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { simulatePaths, resetDreamer } = await import("../../../dist/lib/reasoning/dreamer.js");

describe("simulatePaths", () => {
  it("returns empty array for empty current sequence", () => {
    const paths = simulatePaths([], []);
    assert.deepEqual(paths, []);
  });

  it("returns empty array when no transitions exist for last tool", () => {
    const paths = simulatePaths(["read"], []);
    assert.deepEqual(paths, []);
  });

  it("returns predicted paths from historical sequences", () => {
    // Use >= MIN_SAMPLE_FOR_PREDICTION transitions to satisfy the sample-size guard.
    const history = Array.from({ length: 6 }, () => ["read", "edit", "read"]);
    const paths = simulatePaths(["read"], history);
    assert.ok(paths.length > 0, "should return predicted paths");
    assert.ok(
      paths.every((p) => p.probability > 0),
      "all probabilities positive",
    );
  });

  it("returns [] when sample is below MIN_SAMPLE_FOR_PREDICTION", () => {
    // With only 3 observations of read->*, the predictor bails (insufficient
    // data). This is the small-sample fix.
    const history = [
      ["read", "edit", "read"],
      ["read", "edit", "bash"],
      ["read", "grep", "edit"],
    ];
    const paths = simulatePaths(["read"], history);
    assert.deepEqual(paths, [], "with <5 transitions, predictor stays silent");
  });

  it("sorts paths by probability descending", () => {
    const history = [
      ["read", "edit"],
      ["read", "edit"],
      ["read", "edit"],
      ["read", "grep"],
      ["read", "edit"],
      ["read", "grep"],
    ];
    const paths = simulatePaths(["read"], history);
    for (let i = 1; i < paths.length; i++) {
      assert.ok(paths[i - 1].probability >= paths[i].probability, "sorted descending");
    }
  });

  it("returns at most 5 paths", () => {
    const history = Array.from({ length: 20 }, (_, i) => ["read", `tool${i % 6}`]);
    const paths = simulatePaths(["read"], history);
    assert.ok(paths.length <= 5, "at most 5 paths");
  });

  it("classifies high self-loop rate as stuck", () => {
    // If "edit" always transitions to "edit" again -> outcome should be "stuck"
    const history = Array.from({ length: 10 }, () => ["edit", "edit"]);
    const paths = simulatePaths(["edit"], history);
    const stuck = paths.find((p) => p.outcome === "stuck");
    assert.ok(stuck, "high self-loop should be classified as stuck");
  });

  it("classifies moderate self-loop rate as failure", () => {
    // If "edit" transitions to "edit" ~40% of the time -> outcome "failure"
    const history = [
      ...Array.from({ length: 4 }, () => ["edit", "edit"]),
      ...Array.from({ length: 6 }, () => ["edit", "read"]),
    ];
    const paths = simulatePaths(["edit"], history);
    const failure = paths.find((p) => p.outcome === "failure");
    assert.ok(failure, "moderate self-loop should be classified as failure");
  });
});

describe("resetDreamer", () => {
  it("resetDreamer exists as a function", () => {
    assert.equal(typeof resetDreamer, "function");
  });
});

console.log("[ok] Dreamer lib tests complete");
