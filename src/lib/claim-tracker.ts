/**
 * @fileoverview Cross-Turn Claim Tracker — Lie-Detector Pattern (RepE)
 *
 * Tracks factual claims made by the agent across turns and detects
 * when a new claim contradicts a previous one.
 *
 * Based on: RepE (2310.01405) §5 — honesty direction in residual stream,
 * adapted for text-level detection (API-only providers).
 *
 * Builds on existing infrastructure:
 * - reasoning-metrics.ts: countSelfContradictions() for within-response
 * - judge.ts: LLM-based single-response contradiction scoring
 * - evidence-pool.ts: extractClaim/normalize/tokenOverlap
 * - Process Supervision (stepConsistencyCheck): think-tool chain consistency
 *
 * WHAT THIS ADDS: cross-turn tracking — agent says X in turn 1,
 * then NOT-X in turn 10. The lie-detector catches it.
 *
 * Detection strategy:
 * 1. Extract entity-claim pairs from agent text (simple heuristic: find
 *    subject-like nouns + predicate-like verb phrases)
 * 2. Store in session-scoped history
 * 3. On each new response, compare against stored claims
 * 4. Flag contradictions via enforcement signal + whisper
 */

import { getExtensionState } from "./extension-state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single claim extracted from agent output */
export interface Claim {
  id: string;
  /** The entity the claim is about (e.g., "database", "API", "function") */
  entity: string;
  /** The claim text (predicate + object, e.g., "returns User[]") */
  claim: string;
  /** Polarity: positive (returns) or negative (doesn't return) */
  polarity: "positive" | "negative";
  /** Turn number when claim was made */
  turn: number;
  /** Full context sentence for display */
  source: string;
  /** Timestamp */
  createdAt: number;
}

/** Session-scoped claim history */
interface ClaimHistoryState {
  claims: Claim[];
  lastCheckMs: number;
}

// ── Keywords for entity/claim extraction ──────────────────────────────────────

/** Common subject entities in code/reasoning contexts */
const ENTITY_KEYWORDS = [
  /\b(?:function|class|method|API|database|schema|module|interface|type|config|service)\b/i,
  /\b(?:the\s+\w+\s+(?:function|method|class|API|endpoint|route|handler))\b/i,
  /\b(?:this\s+(?:code|function|method|class|approach|solution|fix|bug))\b/i,
  /\b(?:it|this)\s+(?:is|was|will|can|should|must|doesn't|won't)\b/i,
];

/** Negation markers for polarity detection */
const NEGATION_WORDS = new Set([
  "not", "no", "never", "neither", "nor", "none", "nothing",
  "doesn't", "don't", "didn't", "won't", "wouldn't", "shouldn't",
  "can't", "cannot", "couldn't", "isn't", "aren't", "wasn't",
  "haven't", "hasn't", "hadn't", "without",
]);

/** Contradiction signal pairs: opposite-direction claims about same entity */
const CONTRADICTION_PAIRS: [string, string][] = [
  ["is", "is not"],
  ["is", "isn't"],
  ["was", "was not"],
  ["was", "wasn't"],
  ["will", "will not"],
  ["will", "won't"],
  ["can", "cannot"],
  ["can", "can't"],
  ["does", "does not"],
  ["does", "doesn't"],
  ["has", "has not"],
  ["has", "hasn't"],
  ["should", "should not"],
  ["should", "shouldn't"],
  ["exists", "missing"],
  ["exists", "absent"],
  ["works", "broken"],
  ["working", "failing"],
  ["correct", "incorrect"],
  ["right", "wrong"],
  ["good", "bad"],
  ["supported", "unsupported"],
  ["available", "unavailable"],
  ["possible", "impossible"],
  ["true", "false"],
  ["yes", "no"],
];

// ── State ────────────────────────────────────────────────────────────────────

const CLAIM_HISTORY_MAX = 100;

function getClaimState(ctx: ExtensionContext): ClaimHistoryState {
  return getExtensionState(ctx, "claim-tracker", () => ({
    claims: [],
    lastCheckMs: 0,
  }));
}

// ── Claim Extraction ──────────────────────────────────────────────────────────

/**
 * Extract factual claims from agent response text.
 * Uses lightweight heuristics — no LLM call needed.
 */
export function extractClaims(text: string): Claim[] {
  if (!text || text.length < 20) return [];

  const claims: Claim[] = [];
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 15);

  for (const sentence of sentences) {
    // Skip questions, commands, and meta-commentary
    if (/^\s*(what|how|why|is|are|can|should|would|let|try|check|note|see)/i.test(sentence)) continue;
    if (/^(i'?ll|i will|i need|i think|i believe|i suggest|i'm going)/i.test(sentence)) continue;
    if (/^(this is why|the reason|because|so|therefore|thus|however|but|although)/i.test(sentence)) continue;

    // Extract entity: first noun-like phrase
    const entity = extractEntity(sentence);
    if (!entity) continue;

    // Determine polarity
    const polarity = detectPolarity(sentence);

    // Extract claim text (predicate + object portion)
    const claimText = extractPredicate(sentence);
    if (!claimText || claimText.length < 3) continue;

    // Deduplicate: skip if similar claim already extracted from same response
    const isDuplicate = claims.some(
      (c) => c.entity.toLowerCase() === entity.toLowerCase() &&
        tokenOverlap(c.claim, claimText) > 0.7,
    );
    if (isDuplicate) continue;

    claims.push({
      id: `c${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      entity: entity.toLowerCase(),
      claim: claimText,
      polarity,
      turn: 0, // filled by caller
      source: sentence.slice(0, 150),
      createdAt: Date.now(),
    });
  }

  return claims.slice(0, 10); // max 10 claims per response
}

/** Extract the entity/subject from a sentence */
function extractEntity(sentence: string): string | null {
  // Pattern: "The X is/does..." or "X is/does..."
  const match = sentence.match(/^(?:the\s+)?(\w+(?:\s+\w+){0,3})\s+(?:is|was|will|can|does|has|should|must|returns|takes|accepts|uses|provides|creates|handles|implements|extends|contains|supports|needs|requires)\b/i);
  if (match) return match[1].toLowerCase();

  // Pattern: "This X..." where X is a known entity type
  for (const re of ENTITY_KEYWORDS) {
    const m = sentence.match(re);
    if (m) return m[0].toLowerCase();
  }

  return null;
}

/** Extract the predicate/claim portion after the entity */
function extractPredicate(sentence: string): string {
  // Remove leading entity
  const cleaned = sentence.replace(/^(?:the\s+)?(?:\w+(?:\s+\w+){0,3})\s+(?:is|was|will|can|does|has|should|must|returns|takes|accepts|uses|provides|creates|handles|implements|extends|contains|supports|needs|requires)\s+/i, "");
  return cleaned.slice(0, 80).trim();
}

/** Detect claim polarity */
function detectPolarity(sentence: string): "positive" | "negative" {
  const words = sentence.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (NEGATION_WORDS.has(word)) return "negative";
  }
  return "positive";
}

// ── Contradiction Detection ───────────────────────────────────────────────────

/** Token overlap ratio between two strings */
export function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if two claims about the same entity are contradictory.
 * Returns true if they conflict.
 */
export function claimsContradict(a: Claim, b: Claim): boolean {
  // Must be about the same entity
  if (a.entity !== b.entity) return false;

  // Same polarity = not a contradiction (same claim, just repeated)
  if (a.polarity === b.polarity) return false;

  // Different polarity = potential contradiction
  // Check if predicates overlap semantically (same topic)
  const overlap = tokenOverlap(a.claim, b.claim);
  return overlap >= 0.2; // Enough token overlap to be about the same thing
}

/**
 * Detect contradictions between a new set of claims and stored history.
 * Returns pairs of (newClaim, oldClaim) that contradict.
 */
export function detectContradictions(
  newClaims: Claim[],
  history: Claim[],
): Array<{ new: Claim; old: Claim; similarity: number }> {
  const contradictions: Array<{ new: Claim; old: Claim; similarity: number }> = [];

  for (const newClaim of newClaims) {
    for (const oldClaim of history) {
      if (claimsContradict(newClaim, oldClaim)) {
        contradictions.push({
          new: newClaim,
          old: oldClaim,
          similarity: tokenOverlap(newClaim.claim, oldClaim.claim),
        });
      }
    }
  }

  return contradictions;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Process an agent response: extract claims, check against history,
 * and update history. Returns any contradictions found.
 */
export function processAgentResponse(
  text: string,
  ctx: ExtensionContext | undefined,
  turn: number,
): Array<{ new: Claim; old: Claim; similarity: number }> {
  if (!ctx) return [];

  const state = getClaimState(ctx);
  const newClaims = extractClaims(text);

  // Set turn on extracted claims
  for (const claim of newClaims) {
    claim.turn = turn;
  }

  // Check against history
  const contradictions = detectContradictions(newClaims, state.claims);

  // Update history
  state.claims.push(...newClaims);

  // Prune: keep only last CLAIM_HISTORY_MAX claims
  if (state.claims.length > CLAIM_HISTORY_MAX) {
    state.claims = state.claims.slice(-CLAIM_HISTORY_MAX);
  }

  state.lastCheckMs = Date.now();

  return contradictions;
}

/**
 * Format contradiction findings as a human-readable whisper.
 */
export function formatContradictionWhisper(
  contradictions: Array<{ new: Claim; old: Claim; similarity: number }>,
  limit = 3,
): string {
  if (contradictions.length === 0) return "";

  const items = contradictions.slice(0, limit);
  const lines: string[] = [
    `[self-consistency] ${contradictions.length} cross-turn contradiction${contradictions.length > 1 ? "s" : ""} detected:`,
  ];

  for (const c of items) {
    lines.push(
      `  • Turn ${c.old.turn}: "${c.new.entity} ${c.old.claim.slice(0, 40)}"`,
      `    → Turn ${c.new.turn}: "${c.new.entity} ${c.new.claim.slice(0, 40)}" (contradicts)`,
    );
  }

  if (contradictions.length > limit) {
    lines.push(`  … and ${contradictions.length - limit} more`);
  }

  return lines.join("\n");
}

/**
 * Get summary statistics for the current session.
 */
export function getClaimStats(ctx: ExtensionContext): {
  totalClaims: number;
  uniqueEntities: number;
  lastCheckMs: number;
} {
  const state = getClaimState(ctx);
  const entities = new Set(state.claims.map((c) => c.entity));
  return {
    totalClaims: state.claims.length,
    uniqueEntities: entities.size,
    lastCheckMs: state.lastCheckMs,
  };
}
