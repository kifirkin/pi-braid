/**
 * Test: Consolidation Channel - experience scoring + tick processing
 *
 * Removed tests for selectCandidates, selectBestCandidate, queueForConsolidation,
 * getConsolidationStatus, getConsolidationQueue - those functions were removed
 * as unreachable dead code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { scoreEpisode, processConsolidationTick } = await import(
  "../../../dist/lib/events/consolidation-channel.js"
);

// Sample episodes for testing
const successfulEpisode = {
  id: "ep-1",
  task: "Fix type error in utils.ts",
  outcome: "success",
  quality: 0.8,
  toolSequence: ["read", "edit", "bash"],
  strategicSOP: "Debug by isolating components",
  functionalSOP: ["Reproduce bug", "Locate root cause", "Apply fix"],
};

const failedEpisode = {
  id: "ep-3",
  task: "Complex refactoring",
  outcome: "failure",
  quality: 0.2,
  toolSequence: ["read"],
};

describe("Consolidation Channel", () => {
  it("scores successful episode highly", () => {
    const candidate = scoreEpisode(successfulEpisode);
    assert.ok(
      candidate.valueScore >= 0.5,
      `valueScore should be high: ${candidate.valueScore}`,
    );
    assert.ok(
      candidate.confidenceScore >= 0.7,
      `confidenceScore should be high: ${candidate.confidenceScore}`,
    );
    assert.ok(
      candidate.consolidationScore >= 0.5,
      `consolidationScore should be high: ${candidate.consolidationScore}`,
    );
    assert.equal(candidate.status, "pending");
  });

  it("scores failed episode lower", () => {
    const candidate = scoreEpisode(failedEpisode);
    assert.ok(
      candidate.consolidationScore < 0.5,
      `failed episode should score low: ${candidate.consolidationScore}`,
    );
  });

  it("processConsolidationTick runs without error on empty queue", () => {
    // Should not throw when queue is empty. processConsolidationTick
    // now takes ctx (required for the isHintTooGeneric classify() call
    // when a candidate is processed); with an empty queue the function
    // returns early before ctx is used, so a minimal mock is fine.
    processConsolidationTick({} /* mock ExtensionContext */);
  });
});

console.log("✅ Consolidation Channel tests complete");
