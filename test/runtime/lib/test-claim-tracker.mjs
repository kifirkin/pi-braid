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
  extractClaims,
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

describe("Claim Extractor (sync fallback)", () => {
  it("extracts claims from technical response", () => {
    const text = "The API returns a list of users. The database schema needs migration.";
    const claims = extractClaims(text);
    assert.ok(claims.length >= 2, `Expected ≥2 claims, got ${claims.length}`);
    assert.ok(claims.some((c) => c.entity === "api" || c.entity === "the api"));
    assert.ok(claims.some((c) => c.entity.includes("database")));
  });

  it("skips questions and commands", () => {
    const text = "What is the API endpoint? Let me check the config. Try running the test.";
    const claims = extractClaims(text);
    assert.equal(claims.length, 0, "Should not extract claims from questions/commands");
  });

  it("skips first-person meta-commentary", () => {
    const text = "I think the function is correct. I believe the fix works. The module exports a class.";
    const claims = extractClaims(text);
    assert.equal(claims.length, 1, "Should only extract factual claim, not opinions");
    assert.ok(claims[0].entity.includes("module"));
  });

  it("detects negative polarity", () => {
    const text = "The method does not return null.";
    const claims = extractClaims(text);
    assert.ok(claims.length >= 1);
    assert.equal(claims[0].polarity, "negative");
  });

  it("detects positive polarity", () => {
    const text = "The function returns a promise.";
    const claims = extractClaims(text);
    assert.ok(claims.length >= 1);
    assert.equal(claims[0].polarity, "positive");
  });

  it("limits to 10 claims per response", () => {
    const sentences = Array.from({ length: 20 }, (_, i) =>
      `The function${i} returns value${i}.`,
    ).join(" ");
    const claims = extractClaims(sentences);
    assert.ok(claims.length <= 10);
  });

  it("handles empty input", () => {
    assert.equal(extractClaims("").length, 0);
    assert.equal(extractClaims("   ").length, 0);
    assert.equal(extractClaims("a").length, 0);
  });
});

describe("Contradiction Detection (async, heuristic fallback)", () => {
  it("detects opposite polarity on same entity", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "does not support pagination", "negative", 5);
    assert.ok(await claimsContradict(claimA, claimB, undefined));
  });

  it("ignores same polarity (not a contradiction)", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "is well designed", "positive", 5);
    // Same polarity → early return false
    assert.ok(!(await claimsContradict(claimA, claimB, undefined)));
  });

  it("ignores different entities", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("database", "does not support pagination", "negative", 5);
    // Different entity → early return false
    assert.ok(!(await claimsContradict(claimA, claimB, undefined)));
  });

  it("requires sufficient token overlap", async () => {
    const claimA = makeClaim("api", "supports pagination", "positive", 1);
    const claimB = makeClaim("api", "does not work with python", "negative", 5);
    // Low token overlap → different topic, not a contradiction
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

console.log("✅ claim-tracker tests complete");
