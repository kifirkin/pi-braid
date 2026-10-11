/**
 * Test suite for claim-tracker - LLM-based cross-turn contradiction detection
 *
 * Validates:
 * - Claim extraction from agent responses (sync fallback path)
 * - Cross-turn contradiction detection (async, heuristic fallback)
 * - Formatting and edge cases
 *
 * The async functions (claimsContradict, detectContradictions) test the
 * heuristic fallback path since no real ExtensionContext is available.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  claimsContradict,
  detectContradictions,
  formatContradictionWhisper,
} from "../../../dist/lib/store/claim-tracker.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeClaim(entity, claim, polarity, turn = 1) {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    entity,
    claim,
    polarity,
    turn,
    source: `${entity} ${claim}`,
    createdAt: Date.now(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

// The "Claim Extractor (sync fallback)" describe block was previously here.
// It tested extractClaims() - a sync heuristic fallback that was removed
// because the LLM path is the only real call site and
// the sync fallback's B/A-class heuristics (question-skip regex, polarity
// regex) were the last fragile hand-coded patterns in claim-tracker.
// processAgentResponse is the only real entry point now and uses
// classify() for both entity extraction and polarity detection.

describe("Contradiction Detection (async, heuristic fallback)", () => {
  it("detects opposite polarity on same entity", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "does not support pagination", "negative", 5);
    assert.ok(await claimsContradict(claimA, claimB, undefined));
  });

  it("ignores same polarity (not a contradiction)", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "is well designed", "positive", 5);
    // Same polarity -> early return false
    assert.ok(!(await claimsContradict(claimA, claimB, undefined)));
  });

  it("ignores different entities", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("database", "does not support pagination", "negative", 5);
    // Different entity -> early return false
    assert.ok(!(await claimsContradict(claimA, claimB, undefined)));
  });

  it("requires sufficient token overlap", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "does not work with python", "negative", 5);
    // Low token overlap -> different topic, not a contradiction
    assert.ok(!(await claimsContradict(claimA, claimB, undefined)));
  });

  it("findContradictions returns matching pairs", async () => {
    const history = [
      makeClaim("api", "supports pagination", "positive", 1),
      makeClaim("function", "returns a promise", "positive", 2),
    ];
    const newClaims = [
      makeClaim("api", "does not support pagination", "negative", 5),
      makeClaim("function", "is async", "positive", 5),
    ];
    const results = await detectContradictions(newClaims, history, undefined);
    assert.equal(results.length, 1);
    assert.equal(results[0].new.entity, "api");
  });
});

describe("Whisper Formatting", () => {
  it("returns empty string for empty input", () => {
    assert.equal(formatContradictionWhisper([]), "");
  });

  it("formats single contradiction", () => {
    const c = {
      new: makeClaim("api", "does not support pagination", "negative", 5),
      old: makeClaim("api", "supports pagination", "positive", 1),
      similarity: 0.5,
    };
    const result = formatContradictionWhisper([c]);
    assert.ok(result.includes("[self-consistency]"));
    assert.ok(result.includes("Turn 1"));
    assert.ok(result.includes("Turn 5"));
    assert.ok(result.includes("contradicts"));
  });

  it("truncates at limit", () => {
    const contradictions = Array.from({ length: 5 }, (_, i) => ({
      new: makeClaim(`entity${i}`, "is broken", "negative", 5),
      old: makeClaim(`entity${i}`, "is working", "positive", 1),
      similarity: 0.5,
    }));
    const result = formatContradictionWhisper(contradictions, 2);
    assert.ok(result.includes("and 3 more"));
  });
});

console.log("[ok] claim-tracker tests complete");
