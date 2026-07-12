/**
 * Harness Validator — Phase 3 of the Self-Harness Loop (LP-1).
 *
 * Evaluates candidate edits from the Harness Proposer against held-in
 * and held-out failure evidence using LLM-as-judge. Applies the Pareto
 * acceptance rule and records a complete audit trail.
 *
 * Design:
 *   - Held-in evaluation: does the proposed change fix the weakness that
 *     generated the cluster? Uses the cluster's own failure signatures
 *     as evidence. Score: -1 (worse) to 1 (fully fixed).
 *   - Held-out evaluation: does the proposed change cause regressions on
 *     OTHER clusters' failure patterns? Uses a representative sample of
 *     signatures from other clusters. Score: -1 (regression) to 1 (safe).
 *   - Pareto acceptance rule: Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0.
 *     The candidate must not make anything worse and must improve at
 *     least one dimension.
 *
 * Inspired by Self-Harness paper (2606.09498) §4: "Each candidate is
 * evaluated on a held-in set (the failures that generated the cluster)
 * and a held-out set (other failures). Candidates that pass Pareto
 * non-regression on both sets are accepted."
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../ai/llm-call.js";
import { resolveUtilityModel } from "../ai/model-resolver.js";
import { nextId } from "../utils/id.js";
import { createLogger } from "../core/logger.js";
import type {
  WeaknessCluster,
  HarnessProposal,
  CandidateEdit,
  ValidationEval,
  ValidationResult,
} from "./types.js";

const log = createLogger("harness:validator");

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum failure signatures to include as evidence in the prompt (held-in). */
const MAX_HELD_IN_SIGS = 5;

/** Maximum failure signatures to include as evidence in the prompt (held-out). */
const MAX_HELD_OUT_SIGS = 8;

/** Maximum characters for the full evaluation prompt. */
const MAX_EVAL_PROMPT_CHARS = 3000;

/** LLM call timeout in ms — judge should be fast. */
const VALIDATOR_TIMEOUT_MS = 10_000;

/** Maximum tokens for the judge response. */
const VALIDATOR_MAX_TOKENS = 256;

/**
 * Minimum accepted score for the max() in the Pareto rule.
 * max(heldInScore, heldOutScore) must exceed this value.
 */
const MIN_ACCEPTABLE_MAX_SCORE = 0;

// ── Score Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a JSON evaluation result from the LLM response.
 * Expected JSON format:
 *   {
 *     "heldInScore": 0.8,
 *     "heldOutScore": 0.3,
 *     "rationale": "The proposed directive addresses the tool loop by..."
 *   }
 *
 * Scores are clamped to [-1, 1]. Missing or non-numeric scores
 * default to 0 (no change).
 */
function parseEvalResult(raw: string): ValidationEval {
  // Try to extract JSON from the response (handle markdown fences)
  let jsonStr = raw.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Find the outermost JSON object
  const objMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    jsonStr = objMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);

    const clamp = (v: unknown, fallback: number): number => {
      if (typeof v === "number" && !Number.isNaN(v)) {
        return Math.max(-1, Math.min(1, v));
      }
      return fallback;
    };

    const heldInScore = clamp(parsed.heldInScore, 0);
    const heldOutScore = clamp(parsed.heldOutScore, 0);
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.length > 0
        ? parsed.rationale
        : "No rationale provided.";

    return { heldInScore, heldOutScore, rationale };
  } catch {
    log.warn("Failed to parse evaluation JSON, using defaults");
    return {
      heldInScore: 0,
      heldOutScore: 0,
      rationale: "Parse failure — scores defaulted to 0.",
    };
  }
}

// ── Pareto Acceptance Rule ───────────────────────────────────────────────────

/**
 * Apply the Pareto non-regression acceptance rule.
 *
 * Rule: Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0
 *
 * Where Δ values are scores in [-1, 1]:
 *   - Δ_in >= 0: the candidate does not make the original weakness worse
 *   - Δ_out >= 0: the candidate does not cause regressions elsewhere
 *   - max > MIN_ACCEPTABLE_MAX_SCORE: at least one dimension shows improvement
 *
 * @returns true if the candidate passes acceptance
 */
export function applyParetoAcceptance(eval_: ValidationEval): boolean {
  return (
    eval_.heldInScore >= 0 &&
    eval_.heldOutScore >= 0 &&
    Math.max(eval_.heldInScore, eval_.heldOutScore) > MIN_ACCEPTABLE_MAX_SCORE
  );
}

// ── Prompt Construction ──────────────────────────────────────────────────────

/**
 * Format failure signatures as a bullet list for the prompt.
 */
function formatSigsForPrompt(
  sigs: Array<{ type: string; toolName?: string; message: string; count: number; turn: number }>,
  limit: number,
): string {
  const slice = sigs.slice(0, limit);
  if (slice.length === 0) return "No failure evidence available.";

  return slice
    .map(
      (s, i) =>
        `${i + 1}. [turn ${s.turn}] ${s.type}${s.toolName ? ` on \`${s.toolName}\`` : ""}: "${s.message}" (count: ${s.count})`,
    )
    .join("\n");
}

/**
 * Build the system prompt for the evaluation LLM call.
 */
function buildValidatorSystemPrompt(): string {
  return [
    "You are an objective harness validator. Your role is to evaluate whether a",
    "proposed change to an agent system would fix a specific weakness without",
    "causing regressions elsewhere.",
    "",
    "Respond with ONLY a JSON object in this exact format:",
    '{',
    '  "heldInScore": <number -1 to 1>,',
    '  "heldOutScore": <number -1 to 1>,',
    '  "rationale": "<string explaining your scores>"',
    '}',
    "",
    "Score guidelines:",
    "  +1.0 = Fully addresses the weakness / completely safe for other tasks",
    "  +0.5 = Partially addresses / mostly safe",
    "   0.0 = No effect either way / neutral",
    "  -0.5 = Makes the weakness worse / causes minor regression",
    "  -1.0 = Makes the weakness much worse / causes major regression",
    "",
    "Be conservative. A score of +0.3 means 'small but real improvement'.",
    "A score of 0.0 means 'no meaningful effect, positive or negative'.",
    "Only give positive scores when the proposed change clearly addresses",
    "the specific failure pattern described in the evidence.",
  ].join("\n");
}

/**
 * Build the user prompt evaluating a candidate against held-in and held-out
 * failure evidence.
 */
function buildEvalUserPrompt(
  candidate: CandidateEdit,
  cluster: WeaknessCluster,
  otherClusters: WeaknessCluster[],
): string {
  const heldInSigs = formatSigsForPrompt(cluster.signatures, MAX_HELD_IN_SIGS);

  // Collect representative signatures from other clusters
  const otherSigs = otherClusters
    .flatMap((c) => c.signatures)
    .slice(0, MAX_HELD_OUT_SIGS);
  const heldOutSigs = formatSigsForPrompt(otherSigs, MAX_HELD_OUT_SIGS);

  // Truncate the full prompt to prevent oversized context
  let prompt = [
    `## Proposed Change`,
    ``,
    `Label: ${candidate.label}`,
    `Target: ${candidate.surface}`,
    `Description: ${candidate.description}`,
    `Rationale: ${candidate.rationale}`,
    `Proposed content:`,
    candidate.proposedChange,
    ``,
    `## Weakness Being Addressed`,
    ``,
    `Label: ${cluster.label}`,
    `Type: ${cluster.type}`,
    `Severity: ${cluster.severity.toFixed(2)}`,
    `Frequency: ${cluster.frequency}x`,
    ``,
    `## Held-In Failure Evidence (does this change fix these failures?)`,
    ``,
    heldInSigs,
    ``,
    `## Held-Out Failure Evidence (does this change cause regressions on unrelated failures?)`,
    ``,
    heldOutSigs,
    ``,
    `Evaluate the proposed change on both dimensions and return JSON.`,
  ].join("\n");

  if (prompt.length > MAX_EVAL_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_EVAL_PROMPT_CHARS) +
      "\n\n[Evidence truncated due to length — evaluate based on available context.]";
  }

  return prompt;
}

// ── Candidate Validation ─────────────────────────────────────────────────────

/**
 * Validate a single candidate edit against its cluster's failure evidence.
 *
 * Makes one LLM call to evaluate the candidate on both held-in and held-out
 * dimensions. Returns a ValidationResult with scores and acceptance decision.
 *
 * @param ctx - Extension context (for model resolution)
 * @param proposal - The harness proposal containing this candidate
 * @param candidate - The candidate edit to validate
 * @param allClusters - All mined clusters (used for held-out evidence)
 * @param currentTurn - Current turn number
 * @returns ValidationResult, or null if evaluation fails
 */
export async function validateCandidate(
  ctx: ExtensionContext,
  proposal: HarnessProposal,
  candidate: CandidateEdit,
  allClusters: WeaknessCluster[],
  currentTurn: number,
  signal?: AbortSignal,
): Promise<ValidationResult | null> {
  // Find the cluster this proposal addresses
  const cluster = allClusters.find((c) => c.id === proposal.clusterId);
  if (!cluster) {
    log.warn(`Cluster ${proposal.clusterId} not found for validation`);
    return null;
  }

  // Other clusters provide held-out evidence
  const otherClusters = allClusters.filter((c) => c.id !== proposal.clusterId);

  const systemPrompt = buildValidatorSystemPrompt();
  const userPrompt = buildEvalUserPrompt(candidate, cluster, otherClusters);

  // Resolve model: prefer utility, fall back to session
  const utilityModel = resolveUtilityModel(ctx);
  const model = utilityModel ?? ctx.model;

  if (!model) {
    log.warn("No model available for validation");
    return null;
  }

  const modelProvider = model.provider;
  if (!modelProvider) {
    log.warn("Model has no provider");
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(modelProvider).catch(() => {
    log.warn("Could not resolve API key for validation");
    return null as unknown as string;
  });
  if (!apiKey) {
    log.warn(`No API key for provider ${modelProvider}`);
    return null;
  }

  try {
    log.info(
      `Validating candidate ${candidate.id}: "${candidate.label}" on ${candidate.surface}`,
    );

    const result = await callLlm(
      model,
      apiKey,
      systemPrompt,
      userPrompt,
      {
        maxTokens: VALIDATOR_MAX_TOKENS,
        timeoutMs: VALIDATOR_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );

    if ("error" in result) {
      log.warn(`Validation LLM call failed: ${result.error}`);
      return null;
    }

    const evalResult = parseEvalResult(result.text);
    const accepted = applyParetoAcceptance(evalResult);

    const validationResult: ValidationResult = {
      id: nextId("hval"),
      proposalId: proposal.id,
      candidateId: candidate.id,
      clusterId: proposal.clusterId,
      evalResult,
      accepted,
      validationTurn: currentTurn,
      decisionRationale: buildDecisionRationale(evalResult, accepted),
      timestamp: new Date().toISOString(),
    };

    log.info(
      `Validation ${validationResult.id}: ${accepted ? "ACCEPTED" : "REJECTED"} ` +
      `(in: ${evalResult.heldInScore.toFixed(2)}, out: ${evalResult.heldOutScore.toFixed(2)})`,
    );

    return validationResult;
  } catch (err) {
    log.warn(`Validation exception: ${(err as Error).message}`);
    return null;
  }
}

// ── Decision Rationale ───────────────────────────────────────────────────────

/**
 * Build a human-readable decision rationale from evaluation scores.
 */
function buildDecisionRationale(eval_: ValidationEval, accepted: boolean): string {
  const parts: string[] = [];

  parts.push(
    `Held-in score: ${eval_.heldInScore.toFixed(2)} ` +
    `(${scoreLabel(eval_.heldInScore)}). ` +
    `Held-out score: ${eval_.heldOutScore.toFixed(2)} ` +
    `(${scoreLabel(eval_.heldOutScore)}).`,
  );

  parts.push(
    `Pareto rule: Δ_in=${eval_.heldInScore.toFixed(2)}, Δ_out=${eval_.heldOutScore.toFixed(2)}, ` +
    `max=${Math.max(eval_.heldInScore, eval_.heldOutScore).toFixed(2)}.`,
  );

  parts.push(accepted ? "ACCEPTED: passes Pareto non-regression." : "REJECTED: fails Pareto non-regression.");

  if (eval_.rationale && !eval_.rationale.startsWith("Parse failure") && !eval_.rationale.startsWith("No rationale")) {
    parts.push(`Judge rationale: ${eval_.rationale}`);
  }

  return parts.join(" ");
}

/**
 * Get a human label for a score value.
 */
function scoreLabel(score: number): string {
  if (score > 0.7) return "strong improvement";
  if (score > 0.3) return "moderate improvement";
  if (score > 0) return "slight improvement";
  if (score === 0) return "no change";
  if (score > -0.3) return "slight regression";
  if (score > -0.7) return "moderate regression";
  return "severe regression";
}

// ── Proposal Validation ──────────────────────────────────────────────────────

/**
 * Validate all candidates in a harness proposal.
 *
 * @param ctx - Extension context
 * @param proposal - The harness proposal to validate
 * @param allClusters - All mined clusters (for held-out evidence)
 * @param currentTurn - Current turn number
 * @returns Array of validation results (one per candidate)
 */
export async function validateProposal(
  ctx: ExtensionContext,
  proposal: HarnessProposal,
  allClusters: WeaknessCluster[],
  currentTurn: number,
  signal?: AbortSignal,
): Promise<ValidationResult[]> {
  if (proposal.candidates.length === 0) {
    log.info(`No candidates to validate in proposal ${proposal.id}`);
    return [];
  }

  const results: ValidationResult[] = [];

  for (const candidate of proposal.candidates) {
    const result = await validateCandidate(
      ctx,
      proposal,
      candidate,
      allClusters,
      currentTurn,
      signal,
    );
    if (result) {
      results.push(result);
    }
  }

  log.info(
    `Validated proposal ${proposal.id}: ${results.length}/${proposal.candidates.length} candidates evaluated`,
  );

  return results;
}

// ── Pending Validation Dispatch ──────────────────────────────────────────────

/**
 * Generate validations for all pending proposals that haven't been validated yet.
 * Processes one proposal per call (to keep latency bounded), validating all its
 * candidates.
 *
 * A proposal is considered "pending validation" if:
 *   1. Its status is "pending"
 *   2. No validation results exist for any of its candidates
 *
 * @param ctx - Extension context
 * @param proposals - All generated proposals
 * @param existingResults - Already-recorded validation results
 * @param allClusters - All mined clusters
 * @param currentTurn - Current turn number
 * @param maxProposals - Max proposals to process (default: 1)
 * @returns New validation results generated this call
 */
export async function generateAllPendingValidations(
  ctx: ExtensionContext,
  proposals: HarnessProposal[],
  existingResults: ValidationResult[],
  allClusters: WeaknessCluster[],
  currentTurn: number,
  maxProposals: number = 1,
  signal?: AbortSignal,
): Promise<ValidationResult[]> {
  const validatedCandidateIds = new Set(existingResults.map((r) => r.candidateId));

  const pendingProposals = proposals
    .filter(
      (p) =>
        p.status === "pending" &&
        !p.candidates.every((c) => validatedCandidateIds.has(c.id)),
    )
    .slice(0, maxProposals);

  if (pendingProposals.length === 0) {
    return [];
  }

  log.info(
    `Validating ${pendingProposals.length} pending proposal(s) with unvalidated candidates`,
  );

  const results: ValidationResult[] = [];

  for (const proposal of pendingProposals) {
    const proposalResults = await validateProposal(ctx, proposal, allClusters, currentTurn, signal);
    results.push(...proposalResults);
  }

  return results;
}