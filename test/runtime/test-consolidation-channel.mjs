/**
 * Test: Consolidation Channel — experience selection + scheduling
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  scoreEpisode,
  selectCandidates,
  selectBestCandidate,
  queueForConsolidation,
  processConsolidationTick,
  getConsolidationStatus,
  getConsolidationQueue,
} = await import("../../dist/lib/consolidation-channel.js");

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

const partialEpisode = {
  id: "ep-2",
  task: "Debug race condition",
  outcome: "partial",
  quality: 0.4,
  toolSequence: ["read", "bash"],
  strategicSOP: "Add logs to trace",
  functionalSOP: ["Identify symptom"],
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
    assert.ok(candidate.valueScore >= 0.5, `valueScore should be high: ${candidate.valueScore}`);
    assert.ok(candidate.confidenceScore >= 0.7, `confidenceScore should be high: ${candidate.confidenceScore}`);
    assert.ok(candidate.consolidationScore >= 0.5, `consolidationScore should be high: ${candidate.consolidationScore}`);
    assert.equal(candidate.status, "pending");
  });

  it("scores failed episode lower", () => {
    const candidate = scoreEpisode(failedEpisode);
    assert.ok(candidate.consolidationScore < 0.5, `failed episode should score low: ${candidate.consolidationScore}`);
  });

  it("selects top candidates from episode list", () => {
    const candidates = selectCandidates([successfulEpisode, partialEpisode]);
    assert.ok(candidates.length >= 1, "Should select at least one candidate");
    if (candidates.length > 0) {
      assert.equal(candidates[0].episodeId, "ep-1", "Best episode should be first");
    }
  });

  it("selectBestCandidate returns highest scoring episode", () => {
    const best = selectBestCandidate([successfulEpisode]);
    assert.ok(best, "Should return a candidate");
    assert.equal(best.episodeId, "ep-1", "Should return the best episode");
  });

  it("queues candidates and processes them", () => {
    const queue = getConsolidationQueue();
    queue.clear();

    const { enqueued } = queueForConsolidation([successfulEpisode]);
    assert.equal(enqueued, 1, "Should enqueue 1 candidate");

    // Process one tick
    processConsolidationTick();
    assert.equal(queue.pendingCount, 0, "All candidates processed");
  });

  it("prevents duplicate queuing", () => {
    const queue = getConsolidationQueue();
    queue.clear();

    queueForConsolidation([successfulEpisode]);
    const { enqueued } = queueForConsolidation([successfulEpisode]);
    assert.equal(enqueued, 0, "Should not enqueue duplicate");
  });

  it("returns diagnostic status", () => {
    const status = getConsolidationStatus();
    assert.ok(status.includes("Consolidation Channel"), "Should identify itself");
    assert.ok(status.includes("Queue:") || status.includes("pending"), "Should show queue state");
  });
});

console.log("✅ Consolidation Channel tests complete");
