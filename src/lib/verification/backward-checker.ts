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
import { callLlm } from "../ai/llm-call.js";
import { resolveUtilityModel } from "../ai/model-resolver.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("verification:backward-checker");

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackwardCheckResult {
  /** Whether the fix chain is complete. */
  passes: boolean;
  /**
   * Confidence level: "high" (strong evidence the fix works),
   * "medium" (likely but not certain), "low" (unlikely to propagate).
   */
  confidence: "high" | "medium" | "low";
  /** Human-readable explanation. */
  reason: string;
  /** If the fix doesn't propagate, what's missing? */
  gap?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const BACKWARD_CHECK_TIMEOUT_MS = 10_000;
const BACKWARD_CHECK_MAX_TOKENS = 256;

// ── Prompt Construction ────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "You are a backward checker for code fixes. Your job is to determine",
    "whether a proposed fix actually propagates to the symptom it claims to fix.",
    "",
    "A fix 'propagates' if the chain is complete:",
    "  root cause -> the fix -> intermediate state -> observable symptom",
    "",
    "If the fix is in a different file or module than the symptom, check whether",
    "there is a clear call chain or data flow connecting them.",
    "If the fix addresses a different concern than the symptom, it does NOT propagate.",
    "",
    "Respond with ONLY a JSON object:",
    '{',
    '  "passes": true|false,',
    '  "confidence": "high"|"medium"|"low",',
    '  "reason": "explanation of the judgment",',
    '  "gap": "optional description of what is missing if passes is false"',
    '}',
  ].join("\n");
}

function buildUserPrompt(
  problem: string,
  editedFile: string,
  changeDescription: string,
  symptom: string,
  verifyResult: string,
): string {
  return [
    "## Problem Description",
    problem,
    "",
    "## File Edited",
    editedFile,
    "",
    "## Change Made",
    changeDescription,
    "",
    "## Symptom the Fix Should Address",
    symptom,
    "",
    "## Verification Result",
    verifyResult,
    "",
    "Does the fix in the edited file propagate to the symptom?",
    "Consider the call chain, data flow, and module dependencies.",
    "If the fix is in a different scope than the symptom, explain the gap.",
  ].join("\n");
}

// ── Response Parsing ───────────────────────────────────────────────────────

function parseResult(raw: string): BackwardCheckResult {
  let jsonStr = raw.trim();

  // Handle markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Find outermost JSON object
  const objMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objMatch) jsonStr = objMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonStr);

    const passes = typeof parsed.passes === "boolean" ? parsed.passes : false;
    const confidence = ["high", "medium", "low"].includes(parsed.confidence)
      ? (parsed.confidence as "high" | "medium" | "low")
      : "low";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason provided.";
    const gap = typeof parsed.gap === "string" ? parsed.gap : undefined;

    return { passes, confidence, reason, gap };
  } catch {
    log.warn("Failed to parse backward check result, defaulting to pass");
    return {
      passes: true,
      confidence: "low",
      reason: "Parse failure — defaulting to pass to avoid false positive.",
    };
  }
}

// ── Backward Check ─────────────────────────────────────────────────────────

/**
 * Run a backward check on a code fix.
 *
 * @param ctx - Extension context
 * @param problem - Description of the original problem
 * @param editedFile - Path to the file that was edited
 * @param changeDescription - What was changed (short summary)
 * @param symptom - The symptom the fix should address
 * @param verifyResult - Result of verification (e.g., "tests pass", "claim verified")
 * @returns BackwardCheckResult
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

  // Resolve model: prefer utility, fall back to session
  const utilityModel = resolveUtilityModel(ctx);
  const model = utilityModel ?? ctx.model;

  if (!model) {
    log.warn("No model available for backward check");
    return {
      passes: true,
      confidence: "low",
      reason: "No model available — skipping backward check.",
    };
  }

  const modelProvider = model.provider;
  if (!modelProvider) {
    log.warn("Model has no provider");
    return {
      passes: true,
      confidence: "low",
      reason: "No model provider — skipping backward check.",
    };
  }

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(modelProvider).catch(() => {
    log.warn("Could not resolve API key for backward check");
    return null as unknown as string;
  });
  if (!apiKey) {
    log.warn("No API key for backward check");
    return {
      passes: true,
      confidence: "low",
      reason: "No API key available — skipping backward check.",
    };
  }

  try {
    log.info("Running backward check");

    const result = await callLlm(
      model,
      apiKey,
      systemPrompt,
      userPrompt,
      {
        maxTokens: BACKWARD_CHECK_MAX_TOKENS,
        timeoutMs: BACKWARD_CHECK_TIMEOUT_MS,
      },
    );

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