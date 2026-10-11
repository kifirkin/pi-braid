/**
 * Consolidated Claim Critic -- single LLM call for all 3 claim-verification checks.
 *
 * Replaces 3+ parallel classify() calls (claimContradiction, claimSupported,
 * claimOverconfidence) with one structured-output LLM call that returns all
 * three verdicts as JSON. Falls back to individual classify() calls on failure.
 *
 * Benefits:
 *   - 3x fewer LLM calls -> ~66% latency reduction for verify_claim
 *   - Single system prompt shared across all three dimensions
 *   - Model can cross-reference (e.g., contradiction vs support)
 *   - Same return interface -- drop-in replacement for claim-verification.ts
 *
 * Output budget: the answer is ~40 tokens of JSON, but thinking tokens count
 * against max_tokens on every reasoning model braid routes to, and the
 * channel cannot be switched off for a model whose thinkingLevelMap declares
 * no "off" level (pi-ai clamps "off" to the lowest declared level). The
 * mechanism that answers this - first completion with no maxTokens, one
 * enlarged-budget retry when a completion ends at its ceiling without a
 * verdict - is shared with the other two consolidated judges and lives in
 * lib/ai/judge-budget.ts. What stays here is the domain half: the prompt, the
 * reader that decides what counts as a verdict, and the fall-through.
 *
 * A null return means the caller runs the three-call fallback path; the
 * null is counted and announced once per process.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractJson } from "../utils/extract-json.js";
import { createLogger } from "../core/logger.js";
import { recordCriticCall } from "./critic-stats.js";
import {
  judgeAcrossTiers,
  type JudgeCompletionView,
  type JudgeFailureReason,
  type JudgeOutcome,
  type JudgeReading,
} from "./judge-budget.js";

const log = createLogger("consolidated-claim-critic");

// Fall-through observability: the null return is a contract with the caller -
// claim-verification.ts runs its three individual classify() calls instead.
// Uncounted, a judge losing a third of its calls to a starved output budget
// looks healthy from the outside; the count is kept here, at the return that
// decides it, and announced once per process - the shape of llm-call.ts's
// degraded-transport latch.

/**
 * Why a consolidated call produced no verdict. The vocabulary is the shared
 * one (judge-budget.ts) under this module's existing name, so the counters and
 * the warning keep their words.
 */
export type ClaimCriticFailureReason = JudgeFailureReason;

export interface ClaimCriticStats {
  /** consolidatedClaimCritique calls. */
  invocations: number;
  /** Calls that produced a verdict (the caller skips the three-call fallback). */
  verdicts: number;

  /** Calls that returned null (the caller runs the three-call fallback path). */
  fallthroughs: number;
  /** Terminal reason per fall-through. */
  fallthroughReasons: Record<ClaimCriticFailureReason, number>;
  /** Judge completions attempted (one per model tier, +1 when a retry fired). */
  modelCalls: number;
  /** Completions that ended at their output ceiling without a verdict. */
  budgetExhausted: number;
  /** Enlarged-budget retries issued. */
  retries: number;
  /** Retries that produced a verdict. */
  retryRecoveries: number;
}

function emptyStats(): ClaimCriticStats {
  return {
    invocations: 0,
    verdicts: 0,
    fallthroughs: 0,
    fallthroughReasons: {
      "budget-exhausted": 0,
      "unparseable": 0,
      "invalid-fields": 0,
      "call-error": 0,
    },
    modelCalls: 0,
    budgetExhausted: 0,
    retries: 0,
    retryRecoveries: 0,
  };
}

/**
 * Counters and the once-per-process warning latch, in one `const` holder (no
 * module-level `let`). Both are process-scoped in the same sense as
 * llm-call.ts's reportedUnusableModels: they live until the module is
 * re-evaluated, which /reload does.
 */
const state = { stats: emptyStats(), fallthroughWarned: false };

/** Snapshot of this critic's call outcomes since the module was loaded. */
export function getConsolidatedClaimStats(): ClaimCriticStats {
  return { ...state.stats, fallthroughReasons: { ...state.stats.fallthroughReasons } };
}

/** @internal Test helper: clear the counters and the warning latch. */
export function __resetConsolidatedClaimStatsForTest(): void {
  state.stats = emptyStats();
  state.fallthroughWarned = false;
}

/**
 * Announce the fall-through exactly once per process, naming what went wrong.
 * Later fall-throughs stay silent in the log but keep counting; the per-reason
 * totals - and the rate - are readable through getConsolidatedClaimStats().
 */
function warnFallthroughOnce(reason: ClaimCriticFailureReason, detail: string): void {
  if (state.fallthroughWarned) return;
  state.fallthroughWarned = true;
  const next =
    reason === "budget-exhausted"
      ? "The model's output budget is being consumed before it can answer, even " +
        "after the enlarged-budget retry: raise the budget for this call or " +
        "lower the prompt's thinking burden."
      : "The judge's answer is not in the shape this critic reads.";
  log.warn(
    `[consolidated-claim] no verdict (${reason}: ${detail}); the caller falls ` +
      `through to its three individual classify() calls. ${next} Further ` +
      `fall-throughs are counted silently - see getConsolidatedClaimStats().`,
  );
}

// ── Consolidated Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a claim verification analyzer. You do one thing: " +
  "read a claim and context inside XML tags, and rate the claim on three " +
  "binary dimensions. Respond with a valid JSON object containing exactly " +
  "these three fields. No explanation, no markdown, no other text.";

const USER_PROMPT =
  "Analyze the claim against the context. Respond with valid JSON only:\n" +
  "{\n" +
  '  "contradiction": true|false,   // Does the claim directly contradict the context? ' +
  "(true = yes, they conflict)\n" +
  '  "supported": true|false,       // Is the claim supported by the context? ' +
  "(true = yes, context backs it up)\n" +
  '  "overconfidence": true|false   // Does the claim contain unwarranted certainty ' +
  '("always", "never", "guaranteed", "definitely", etc.)?\n' +
  "}\n\n" +
  "<claim>\n{{claim}}\n</claim>\n\n" +
  "<context>\n{{context}}\n</context>";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidatedClaimVerdict {
  /** true = claim directly contradicts context */
  contradiction: boolean;
  /** true = claim is supported by context */
  supported: boolean;
  /** true = claim contains overconfident language */
  overconfidence: boolean;
}

export interface ConsolidatedClaimResult {
  contradiction: boolean;
  supported: boolean;
  overconfidence: boolean;
  classifierDown: boolean;
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Consolidated claim critique -- single LLM call for all 3 dimensions.
 *
 * Model tier strategy (modelPreference: "quality"):
 *   1. Try session model (cheap, may already be powerful)
 *   2. If session fails, try utility model
 *   3. If all fail, return null so caller falls through to individual calls
 *
 * Each tier gets at most two completions: its call, plus one enlarged-budget
 * retry when that call ended at its output ceiling. The walk itself is bounded
 * by the tier list, so the worst case is four completions, not a retry loop.
 */
export async function consolidatedClaimCritique(
  claim: string,
  context: string,
  ctx: ExtensionContext,
): Promise<ConsolidatedClaimResult | null> {
  const truncatedClaim = claim.length > 2000 ? claim.slice(0, 2000) + "..." : claim;
  const truncatedContext = context.length > 3000 ? context.slice(0, 3000) + "..." : context;
  const start = Date.now();
  state.stats.invocations++;

  // ── Attempt consolidated LLM call ──────────────────────────────────────
  const outcome = await tryConsolidatedCall(truncatedClaim, truncatedContext, ctx);
  const latency = Date.now() - start;

  if (outcome.ok) {
    state.stats.verdicts++;
    recordCriticCall("consolidated-claim", "utility", latency);
    log.debug(`[consolidated-claim] OK ${latency}ms: ${JSON.stringify(outcome.verdict)}`);
    return {
      contradiction: outcome.verdict.contradiction,
      supported: outcome.verdict.supported,
      overconfidence: outcome.verdict.overconfidence,
      classifierDown: false,
    };
  }

  // ── Fallback: return null so caller falls through to individual calls ──
  state.stats.fallthroughs++;
  state.stats.fallthroughReasons[outcome.reason]++;
  recordCriticCall("consolidated-claim", "failed", latency);
  log.debug(`[consolidated-claim] no verdict (${outcome.reason}), returning null for fallback`);
  warnFallthroughOnce(outcome.reason, outcome.detail);
  return null;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * The consolidated judge, across the model tiers, on the shared output-budget
 * contract (lib/ai/judge-budget.ts): session model first, then utility, each
 * with at most one enlarged-budget retry.
 */
async function tryConsolidatedCall(
  claim: string,
  context: string,
  ctx: ExtensionContext,
): Promise<JudgeOutcome<ConsolidatedClaimVerdict>> {
  const userMessage = USER_PROMPT.replace("{{claim}}", claim).replace("{{context}}", context);
  return judgeAcrossTiers({
    ctx,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    read: readClaimVerdict,
    label: "consolidated-claim",
    counters: state.stats,
  });
}

/**
 * Read one completion as a claim verdict. The mapping from "what the model
 * said" to "why there is no verdict" is this judge's business; the retry
 * decision above it is not.
 */
function readClaimVerdict(view: JudgeCompletionView): JudgeReading<ConsolidatedClaimVerdict> {
  const jsonStr = extractJson(view.text);
  if (!jsonStr) {
    log.debug(
      `[consolidated-claim] No JSON found in response from ${view.model.id} ${view.elapsedMs}ms: ${view.text.slice(0, 100)}`,
    );
    return {
      ok: false,
      reason: view.atCeiling ? "budget-exhausted" : "unparseable",
      detail: `${view.text.length} chars of response, no JSON`,
    };
  }

  let parsed: ConsolidatedClaimVerdict;
  try {
    parsed = JSON.parse(jsonStr) as ConsolidatedClaimVerdict;
  } catch {
    log.debug(
      `[consolidated-claim] Unparseable JSON from ${view.model.id}: ${jsonStr.slice(0, 100)}`,
    );
    return {
      ok: false,
      reason: view.atCeiling ? "budget-exhausted" : "unparseable",
      detail: `enclosed object is not parseable JSON`,
    };
  }

  if (
    typeof parsed.contradiction === "boolean" &&
    typeof parsed.supported === "boolean" &&
    typeof parsed.overconfidence === "boolean"
  ) {
    return { ok: true, verdict: parsed };
  }

  log.debug(`[consolidated-claim] Invalid fields from ${view.model.id}: ${jsonStr}`);
  return { ok: false, reason: "invalid-fields", detail: `JSON without the three boolean fields` };
}
