/**
 * Cross-Turn Claim Tracker - LLM-based cross-turn contradiction detection
 *
 * Tracks factual claims made by the agent across turns and detects
 * when a new claim contradicts a previous one.
 *
 * Claim extraction uses the session model via callLlm() for structured
 * JSON output - no regex entity patterns, no negation word sets, no
 * stem maps, no keyword lists. Falls back to a minimal sentence heuristic
 * when the model is unavailable.
 *
 * Contradiction detection uses classify() with CRITICS.claimContradiction
 * for three-tier fallback (heuristic → utility → session).
 *
 * Replaces the previous implementation that maintained 4 regex patterns,
 * 25 negation words, 18 contradiction pairs, and a verb-stem map - all
 * of which needed constant maintenance and were inherently fragile.
 */

import { callLlm } from "../ai/llm-call.js";
import { resolveUtilityModel } from "../ai/model-resolver.js";
import { getExtensionState } from "../state/extension-state.js";
import { classify } from "../ai/text-classifier.js";
import { CRITICS, ENTITY_VERBS } from "../ai/critic-registry.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nextId } from "../utils/id.js";

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

// ── State ────────────────────────────────────────────────────────────────────

const CLAIM_HISTORY_MAX = 100;

function getClaimState(ctx: ExtensionContext): ClaimHistoryState {
  return getExtensionState(ctx, "claim-tracker", () => ({
    claims: [],
    lastCheckMs: 0,
  }));
}

// ── Claim Extraction via LLM ──────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT =
  "You extract factual claims from text. " +
  "A factual claim asserts something about a technical entity (function, API, database, " +
  "module, class, method, tool, interface, etc.). " +
  "Return ONLY a JSON array of objects. Each object must have: " +
  '"entity" (the subject, lowercase), "claim" (what\'s said about it, max 80 chars), ' +
  '"polarity" ("positive" or "negative"). ' +
  "Example: [{\"entity\": \"api\", \"claim\": \"supports pagination\", \"polarity\": \"positive\"}] " +
  "Return [] if no factual claims are found. No explanations - JSON only.";

/**
 * Extract claims from text using the session model (callLlm).
 * Falls back to a minimal sentence heuristic when the model is unavailable.
 */
async function extractClaimsViaLLM(
  text: string,
  ctx: ExtensionContext,
): Promise<Claim[]> {
  const truncated = text.slice(0, 3000);
  if (truncated.length < 20) return [];

  // ── LLM extraction (primary path) ──────────────────────────────────────
  try {
    // Prefer utility model (cheaper for extraction), fall back to session model
    const utilityModel = resolveUtilityModel(ctx);
    const model = utilityModel ?? ctx.model;
    if (!model) return []; // no LLM available - return empty (no claims)

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) return []; // no API key - return empty (no claims)

    const result = await callLlm(model, apiKey, EXTRACTION_SYSTEM_PROMPT, truncated, {
      temperature: 0.1,
      timeoutMs: 120_000,
      maxRetries: 0,
      // Thread ctx.signal so ESC / session shutdown aborts the claim
      // extraction cleanly instead of leaking until the 8s timeout.
      // Same anti-pattern fix as input-polisher 9966c8ad,
      // text-classifier, and verification-judge.
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if ("error" in result) return []; // LLM call failed - return empty (no claims)

    const raw = result.text.trim();
    // Extract JSON array from response (handles markdown-wrapped JSON)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return []; // no JSON in response - return empty (no claims)

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return []; // malformed JSON - return empty (no claims)

    return parsed
      .filter((item: any) => item.entity && item.claim)
      .slice(0, 10)
      .map((item: any) => ({
        id: nextId('c'),
        entity: String(item.entity).toLowerCase().trim(),
        claim: String(item.claim).slice(0, 80).trim(),
        polarity: item.polarity === "negative" ? "negative" as const : "positive" as const,
        turn: 0, // filled by caller
        source: text.slice(0, 150),
        createdAt: Date.now(),
      }));
  } catch {
    return extractClaimsViaClassify(text, ctx);
  }
}

/**
 * Secondary extraction path - classify() per sentence for entity + polarity.
 * More resilient than the heuristic fallback (three-tier via text-classifier).
 */
async function extractClaimsViaClassify(
  text: string,
  ctx: ExtensionContext,
): Promise<Claim[]> {
  const sentences = text
    .slice(0, 3000)
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const claims: Claim[] = [];

  for (const sentence of sentences) {
    try {
      // Check if sentence contains a factual claim
      const entityResult = await classify(
        ctx,
        CRITICS.entityExtraction.criteria,
        { sentence },
        {
          timeoutMs: 60_000,
          label: CRITICS.entityExtraction.label,
          modelPreference: "quality",
          // Q9: ENTITY_VERBS regex misses most entities. Always use LLM.
          tierPolicy: "always-llm",
        },
      );
      if (entityResult.label !== "yes") continue;

      // Determine polarity
      const polarityResult = await classify(
        ctx,
        CRITICS.polarityDetection.criteria,
        { sentence },
        {
          timeoutMs: 60_000,
          label: CRITICS.polarityDetection.label,
          modelPreference: "quality",
          // Q9: negation-word list breaks on double-negation. Always use LLM.
          tierPolicy: "always-llm",
        },
      );

      // Extract entity/claim via verb matching (minimal heuristic)
      entityClaimFromSentence(sentence, polarityResult.label === "negative" ? "negative" : "positive", claims);
    } catch {
      // Per-sentence errors are non-fatal - skip this sentence
      continue;
    }
  }

  return claims.slice(0, 10);
}

/**
 * Extract entity + claim from a single sentence using minimal verb regex.
 * Mutates the `claims` accumulator directly (avoid re-parsing).
 */
function entityClaimFromSentence(
  sentence: string,
  polarity: "positive" | "negative",
  claims: Claim[],
): void {
  if (sentence.length < 15) return;

  const verbMatch = sentence.match(ENTITY_VERBS);
  if (!verbMatch || verbMatch.index === undefined) return;

  const entity = sentence.slice(0, verbMatch.index).replace(/^(the\s+)/i, "").trim().toLowerCase();
  if (!entity || entity.length < 2) return;

  const claim = sentence.slice(verbMatch.index + verbMatch[0].length).trim().slice(0, 80).trim();
  if (claim.length < 3) return;

  // Deduplicate
  const isDuplicate = claims.some(
    (c) => c.entity === entity && c.claim.slice(0, 20) === claim.slice(0, 20),
  );
  if (isDuplicate) return;

  claims.push({
    id: nextId('c'),
    entity,
    claim,
    polarity,
    turn: 0,
    source: sentence.slice(0, 150),
    createdAt: Date.now(),
  });
}

// ── Contradiction Detection (triple-critic) ───────────────────────────────────

/**
 * Check if two claims about the same entity are contradictory using classify().
 * Falls back to polarity + overlap check when LLM unavailable.
 */
export async function claimsContradict(a: Claim, b: Claim, ctx: ExtensionContext): Promise<boolean> {
  if (a.entity !== b.entity) return false;
  if (a.turn === b.turn) return false;
  if (a.polarity === b.polarity) return false;

  const claimText = `${a.entity} ${a.claim}${a.polarity === "negative" ? " (negated)" : ""}`;
  const contextText = `${b.entity} ${b.claim}${b.polarity === "negative" ? " (negated)" : ""}`;

  try {
    const result = await classify(
      ctx,
      CRITICS.claimContradiction.criteria,
      { claim: claimText.slice(0, 500), context: contextText.slice(0, 500) },
      {
        timeoutMs: 60_000,
        label: CRITICS.claimContradiction.label,
        modelPreference: "quality",
        // Q9: heuristic negation-word overlap has many false positives. Always LLM.
        tierPolicy: "always-llm",
      },
    );
    return result.label === "yes";
  } catch {
    // Catch-all: minimal overlap check
    return simpleOverlap(a.claim, b.claim) >= 0.2;
  }
}

/** Minimal token overlap - no stemming, no normalization maps. */
function simpleOverlap(a: string, b: string): number {
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
 * Detect contradictions between a new set of claims and stored history.
 */
export async function detectContradictions(
  newClaims: Claim[],
  history: Claim[],
  ctx: ExtensionContext,
): Promise<Array<{ new: Claim; old: Claim; similarity: number }>> {
  const contradictions: Array<{ new: Claim; old: Claim; similarity: number }> = [];

  for (const newClaim of newClaims) {
    for (const oldClaim of history) {
      if (await claimsContradict(newClaim, oldClaim, ctx)) {
        contradictions.push({
          new: newClaim,
          old: oldClaim,
          similarity: simpleOverlap(newClaim.claim, oldClaim.claim),
        });
      }
    }
  }

  return contradictions;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Process an agent response: extract claims via LLM, check against history,
 * and update history. Returns any contradictions found.
 */
export async function processAgentResponse(
  text: string,
  ctx: ExtensionContext | undefined,
  turn: number,
): Promise<Array<{ new: Claim; old: Claim; similarity: number }>> {
  if (!ctx) return [];

  const state = getClaimState(ctx);
  // state.claims is always initialized to [] by getClaimState; no defensive reset needed.

  // Extract claims via LLM (falls back to minimal heuristic)
  const newClaims = await extractClaimsViaLLM(text, ctx);

  // Set turn on extracted claims
  for (const claim of newClaims) {
    claim.turn = turn;
  }

  // Only compare against claims from DIFFERENT turns
  const relevantHistory = state.claims.filter((c) => c.turn < turn);

  // Check against history
  const contradictions = await detectContradictions(newClaims, relevantHistory, ctx);

  // Update history
  state.claims.push(...newClaims);
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
