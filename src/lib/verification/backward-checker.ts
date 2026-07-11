/**
 * Backward Checker — LP-2 component.
 *
 * After a fix is applied, checks whether the fix actually propagates to the
 * original symptom. Uses LLM-as-judge to evaluate: "Given the problem
 * description, the file that was fixed, and the symptom, does the fix
 * complete the chain from root cause to observable behavior?"
 *
 * The classic failure mode: agent fixes a local variable name but the real
 * bug was in a different module. The backward checker catches it before
 * the agent claims done.
 *
 * Usage:
 *   import { backwardCheck } from "./backward-checker.js";
 *
 *   const result = await backwardCheck(ctx, problem, fix, symptom);
 *   if (!result.passes) {
 *     whisper(`Backward check failed: ${result.reason}`);
 *   }
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveUtilityModel, resolveMaxPowerModel, tryModelChain } from "../ai/model-resolver.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("verification:backward-checker");

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackwardCheckResult {
  passes: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  /** If the fix doesn't propagate, what's missing? */
  gap?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const BACKWARD_CHECK_MAX_TOKENS = 1024;
const BACKWARD_CHECK_TIMEOUT_MS = 30_000;

// ── Prompt Building ────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a debugging quality assurance tool. Your job is to verify whether a code change actually fixes the reported problem.

Given:
1. The problem description
2. The file that was modified
3. A description of what changed
4. The symptom (what was actually observed)
5. A verification result

Determine if the fix completes the causal chain from root cause to observable behavior.

Output JSON:
{
  "passes": true/false,
  "confidence": "high" | "medium" | "low",
  "reason": "Brief explanation of your reasoning",
  "gap": "optional description of what is missing if passes is false"
}

Rules:
- passes=true: The fix addresses the root cause and the symptom should be resolved
- passes=false: The fix doesn't complete the causal chain - the symptom would persist
- Be conservative: if you're not sure, set confidence to low
- If the fix is in a different module than the symptom suggests, it's likely wrong`;
}

function buildUserPrompt(
  problem: string,
  editedFile: string,
  changeDescription: string,
  symptom: string,
  verifyResult: string,
): string {
  return `## Problem
${problem}

## Modified File
${editedFile}

## Change Description
${changeDescription}

## Symptom
${symptom}

## Verification Result
${verifyResult}

Does this fix complete the causal chain from root cause to observable symptom?`;
}

// ── Result Parsing ─────────────────────────────────────────────────────────

function parseResult(text: string): BackwardCheckResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        passes: true,
        confidence: "low",
        reason: "Could not parse LLM response as JSON.",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const confidence = parsed.confidence ?? "low";
    const validConfidence = ["high", "medium", "low"].includes(confidence)
      ? confidence
      : "low";

    return {
      passes: parsed.passes !== false,
      confidence: validConfidence,
      reason: parsed.reason ?? "No reason provided",
      gap: parsed.gap ?? undefined,
    };
  } catch {
    return {
      passes: true,
      confidence: "low",
      reason: "Could not parse LLM response.",
    };
  }
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Run a backward check on a fix.
 *
 * Determines whether the fix actually propagates to the original symptom.
 * Uses a model chain with max-power first (accuracy-critical), then utility,
 * then session as fallback.
 *
 * The backward check is an LLM-intensive operation but only runs when
 * explicitly invoked (post-fix verification), so defaulting to the
 * max-power model is appropriate.
 */
export async function backwardCheck(
  ctx: ExtensionContext,
  problem: string,
  editedFile: string,
  changeDescription: string,
  symptom: string,
  verifyResult: string = "Verification completed.",
): Promise<BackwardCheckResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(problem, editedFile, changeDescription, symptom, verifyResult);

  try {
    log.info("Running backward check");

    // Try max-power first (accuracy-critical), then utility, then session
    const result = await tryModelChain(ctx, [
      () => resolveMaxPowerModel(ctx),
      () => resolveUtilityModel(ctx),
      () => ctx.model,
    ], systemPrompt, userPrompt, {
      maxTokens: BACKWARD_CHECK_MAX_TOKENS,
      timeoutMs: BACKWARD_CHECK_TIMEOUT_MS,
    });

    if ("error" in result) {
      log.warn(`Backward check LLM call failed: ${result.error}`);
      return {
        passes: true,
        confidence: "low",
        reason: `LLM call failed: ${result.error}`,
      };
    }

    const parsed = parseResult(result.text);

    log.info(
      `Backward check: ${parsed.passes ? "PASS" : "FAIL"} ` +
      `(confidence: ${parsed.confidence})`,
    );

    return parsed;
  } catch (err) {
    log.warn(`Backward check exception: ${(err as Error).message}`);
    return {
      passes: true,
      confidence: "low",
      reason: `Exception: ${(err as Error).message}`,
    };
  }
}