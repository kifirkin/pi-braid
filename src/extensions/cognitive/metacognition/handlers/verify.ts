/**
 * Verify Tool - Recursive Verification Loop for Metacognition
 *
 * Validates code, reasoning, plans, or tool results before finalization.
 * Research: docs/research/braid-loop-research.md (Improvement 1: Agentic Verifier)
 * Based on: 2604.10980 "Enhancing LLM Agent via Multi-Turn Thinking"
 *
 * Design:
 * - Auto-detects target text from recent context if not provided
 * - Generates criteria heuristically if not provided
 * - Three verification dimensions: syntax, semantic, result
 * - Records verification in state for finalize pre-flight check
 * - If issues found and confidence < threshold -> blocks finalize + returns issues
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../../../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../../../lib/ai/model-resolver.js";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { extractJson } from "../../../../lib/utils/extract-json.js";

const log = createLogger("metacognition:verify");

// ── Types ─────────────────────────────────────────────────────────────────────

export type VerificationTarget = "code" | "reasoning" | "plan" | "result";
export type VerificationDepth = "quick" | "standard" | "deep";

export interface VerificationResult {
  passed: boolean;
  issues: string[];
  confidence: number; // 0-1
  suggestions: string[];
  target: VerificationTarget;
  checksRun: string[];
  verificationMs: number;
}

interface VerifyState {
  verifications: VerificationRecord[];
  lastVerification: VerificationRecord | null;
  blockedFinalizes: number;
  issuesResolved: number;
}

interface VerificationRecord {
  id: string;
  target: VerificationTarget;
  passed: boolean;
  issueCount: number;
  confidence: number;
  createdAt: number;
}

// ── Default Criteria by Target ─────────────────────────────────────────────────

const DEFAULT_CRITERIA: Record<VerificationTarget, string[]> = {
  code: [
    "Null/nil pointer access",
    "Uncaught exceptions",
    "Type safety violations",
    "Resource leaks (file handles, connections)",
    "Logic errors in control flow",
    "Import/module resolution",
  ],
  reasoning: [
    "Logical consistency",
    "Unsupported assumptions",
    "Contradictory claims",
    "Missing edge cases",
    "Causal mechanism explained",
    "Evidence cited or verifiable",
  ],
  plan: [
    "Dependencies specified",
    "Feasibility within constraints",
    "No circular dependencies",
    "Failure modes addressed",
    "Success criteria measurable",
  ],
  result: [
    "Matches requested output format",
    "No hallucinated content",
    "Cross-references verified",
    "Completeness (all parts addressed)",
  ],
};

// ── Auto-Detection ───────────────────────────────────────────────────────────

/** Auto-detect the most recent code/reasoning/plan from session messages. */
function autoDetectTarget(
  ctx: ExtensionContext,
): { target: VerificationTarget; text: string } | null {
  // Use getBranch() - getCurrentSession() does not exist on SessionManager
  const entries = ctx.sessionManager?.getBranch();
  if (!entries || entries.length === 0) return null;

  // Walk backwards to find the last assistant message
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;

    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n")
          : "";

    if (!text || text.length < 50) continue;

    // Simple heuristic: code blocks -> code, lists of steps -> plan, narrative -> reasoning
    const codeBlockCount = (text.match(/```[\s\S]*?```/g) ?? []).length;
    const hasCodeBlocks = codeBlockCount > 0;
    const hasPlanMarkers = /\d+\.\s+\w+|first|then|finally|step\s+\d/i.test(text);
    const hasReasoningMarkers = /\b(because|therefore|since|however|thus|hence)\b/i.test(text);

    if (hasCodeBlocks && !hasPlanMarkers) return { target: "code", text };
    if (hasPlanMarkers) return { target: "plan", text };
    if (hasReasoningMarkers) return { target: "reasoning", text };

    // Default to result for short responses
    return { target: "result", text };
  }

  return null;
}

// ── Heuristic Quick Check ─────────────────────────────────────────────────────

/**
 * Tier 1 fallback (no LLM available) for verify() at 'quick' depth.
 *
 * Only the deterministic, low-false-positive code-safety checks are kept
 * here - TODO/FIXME markers, eval(), innerHTML assignment, and the
 * misleading `delete obj, {...}` comma syntax. Everything else (brace
 * balance, claim ratios, plan step ordering, placeholder text) was
 * removed because it produced too many false positives on real-world
 * text. The LLM tier is responsible for the semantic checks; the
 * heuristic exists only to catch obvious code-safety landmines when
 * the LLM is unavailable.
 */
export function heuristicCheck(
  target: VerificationTarget,
  text: string,
): { issues: string[]; checksRun: string[] } {
  const issues: string[] = [];
  const checksRun: string[] = [];

  if (target === "code") {
    checksRun.push("safety-patterns");
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(text))
      issues.push("Contains unresolved TODO/FIXME markers");
    if (/\beval\s*\(/.test(text)) issues.push("Use of eval() detected - security risk");
    if (/\.innerHTML\s*=/.test(text)) issues.push("Direct innerHTML assignment - XSS risk");
    if (/delete\s+\w+\s*,\s*{/.test(text))
      issues.push("Delete with comma syntax - may be unintended");
  }
  // Other targets: no heuristic checks. The LLM tier is responsible.


  return { issues, checksRun };
}

// ── LLM Verification ─────────────────────────────────────────────────────────

/** Deep verification via LLM call. Used for standard/deep depth. */
async function llmVerify(
  target: VerificationTarget,
  text: string,
  criteria: string[],
  depth: VerificationDepth,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ issues: string[]; suggestions: string[]; confidence: number }> {
  const depthInstructions =
    depth === "deep"
      ? "Perform thorough analysis. Consider edge cases, security implications, and long-term maintainability."
      : depth === "standard"
        ? "Perform standard verification. Check correctness, completeness, and common failure modes."
        : "Perform quick verification. Focus on the most critical issues only.";

  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const prompt = `You are a meticulous verification reviewer. ${depthInstructions}

Check the following ${target.toUpperCase()} against these criteria:
${criteriaText}

---
${text.slice(0, 4000)}
---

Respond with a JSON object:
{
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestions": ["actionable fix 1", "actionable fix 2"],
  "confidence": 0.0-1.0
}

Only report real issues. If everything looks correct, set issues to [].
Do not invent problems that are not supported by the text.`;

  try {
    const utilModel = resolveUtilityModel(ctx);
    if (!ctx.model && !utilModel) {
      // Model unavailable - cannot run LLM verification. Return neutral confidence
      // so the caller's heuristic confidence is not dragged down.
      return {
        issues: [],
        suggestions: ["LLM verification skipped: no model available"],
        confidence: 1.0,
      };
    }
    // Prefer utility model (cheaper for verification), fall back to session model
    const verifyModel = utilModel ?? ctx.model!;
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(verifyModel.provider);
    const llmResult = await callLlm(verifyModel, apiKey, "", prompt, {
      temperature: 0.1,
      signal,
    });

    if ("error" in llmResult) {
      log.debug(`verify: LLM call failed: ${llmResult.error}`);
      return { issues: [], suggestions: [], confidence: 0.5 };
    }

    // Extract JSON from response (use shared robust extractor)
    const jsonStr = extractJson(llmResult.text);
    if (!jsonStr) {
      log.debug("verify: could not parse LLM response as JSON");
      return { issues: [], suggestions: [], confidence: 0.5 };
    }

    const parsed = JSON.parse(jsonStr);
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter(Boolean).slice(0, 10) : [],
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter(Boolean).slice(0, 5)
        : [],
      confidence:
        typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
    };
  } catch (err) {
    log.debug(`verify: LLM call failed: ${err}`);
    // LLM verification failed - return neutral values so the caller's heuristic
    // confidence is not penalized. The caller will keep heuristic confidence.
    return {
      issues: [],
      suggestions: ["LLM verification failed, relying on heuristics only"],
      confidence: 1.0,
    };
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

function getVerifyState(ctx: ExtensionContext): VerifyState {
  return getExtensionState<VerifyState>(ctx, "metacognition-verify", () => ({
    verifications: [],
    lastVerification: null,
    blockedFinalizes: 0,
    issuesResolved: 0,
  }));
}

/** Export for use by finalize handler - checks if recent verification passed. */
export function getLastVerification(ctx: ExtensionContext): VerificationRecord | null {
  return getVerifyState(ctx).lastVerification;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export function createVerifyTool(): ToolDefinition<any, any, any> {
  return {
    name: "verify",
    label: "Verify",
    promptSnippet: "Verify code, reasoning, or tool results before finalization",
    description:
      "Verify code, reasoning, or results after writing code or when uncertain about an approach to catch errors early. Call after every edit or write to check changes before moving on. Provide specific criteria for targeted checks. Before each verification, name the failure mode it guards — 'does the file exist?' is not a meaningful check, 'does the function handle empty input?' is.",

    parameters: Type.Object(
      {
        target: Type.Optional(
          Type.String({
            description: "What to verify: code, reasoning, plan, or result",
            enum: ["code", "reasoning", "plan", "result"],
          }),
        ),
        targetText: Type.Optional(
          Type.String({
            description: "Text to verify. If omitted, auto-detected from recent context.",
          }),
        ),
        criteria: Type.Optional(
          Type.Array(Type.String(), {
            description: "Specific criteria to check. Auto-generated if omitted.",
          }),
        ),
        depth: Type.Optional(
          Type.String({
            description:
              "Verification depth: quick (heuristic only), standard (heuristic + LLM), deep (thorough LLM)",
            enum: ["quick", "standard", "deep"],
          }),
        ),
        confidenceThreshold: Type.Optional(
          Type.Number({
            description: "Block finalize if confidence below this threshold. Default: 0.5",
            minimum: 0,
            maximum: 1,
          }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate: (update: unknown) => void,
      ctx: ExtensionContext,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }> {
      const p = params as {
        target?: VerificationTarget;
        targetText?: string;
        criteria?: string[];
        depth?: VerificationDepth;
        confidenceThreshold?: number;
      };

      const startMs = Date.now();
      const target = p.target ?? "result";
      const depth = p.depth ?? "standard";
      const criteria = p.criteria ?? DEFAULT_CRITERIA[target];
      const confidenceThreshold = p.confidenceThreshold ?? 0.5;

      // Resolve text to verify
      const text = p.targetText ?? autoDetectTarget(ctx)?.text;
      if (!text) {
        return {
          content: [
            {
              type: "text",
              text: "[verify] Could not auto-detect target text from recent context. Provide targetText explicitly.",
            },
          ],
          details: { passed: false, reason: "no-text" },
        };
      }

      log.debug(`verify: ${target} (${depth}), ${text.length} chars, ${criteria.length} criteria`);

      // Step 1: Heuristic quick check (always runs)
      const { issues: heuristicIssues, checksRun } = heuristicCheck(target, text);
      let allIssues = [...heuristicIssues];
      let confidence =
        heuristicIssues.length === 0 ? 0.7 : Math.max(0.3, 0.7 - heuristicIssues.length * 0.1);
      let suggestions: string[] = [];

      // Step 2: LLM deep verification for standard/deep (requires a session model)
      const modelAvailable = Boolean(ctx.model);
      if (
        modelAvailable &&
        depth !== "quick" &&
        (depth === "deep" || allIssues.length > 0 || confidence < 0.8)
      ) {
        const llmResult = await llmVerify(target, text, criteria, depth, ctx, signal);
        allIssues = [...allIssues, ...llmResult.issues];
        suggestions = llmResult.suggestions;
        // Only reduce confidence if LLM actually found issues.
        // If LLM found no issues but has low confidence (e.g., model unavailable,
        // provider not found, network error), keep the heuristic confidence.
        if (llmResult.issues.length > 0) {
          confidence = Math.min(confidence, llmResult.confidence);
        }
      }

      // Deduplicate issues
      const uniqueIssues = [...new Set(allIssues)];
      const passed = uniqueIssues.length === 0 && confidence >= confidenceThreshold;

      const result: VerificationResult = {
        passed,
        issues: uniqueIssues,
        confidence,
        suggestions,
        target,
        checksRun,
        verificationMs: Date.now() - startMs,
      };

      // Record in state
      const state = getVerifyState(ctx);
      const record: VerificationRecord = {
        id: `v-${Date.now()}`,
        target,
        passed,
        issueCount: uniqueIssues.length,
        confidence,
        createdAt: Date.now(),
      };
      state.verifications.push(record);
      state.lastVerification = record; // avoid unused

      // Format output
      const lines: string[] = [];
      const verdict = passed ? "[ok] PASSED" : `[fail] ${uniqueIssues.length} issue(s) found`;
      lines.push(
        `[verify] ${verdict} (confidence: ${(confidence * 100).toFixed(0)}%, ${result.verificationMs}ms)`,
      );
      lines.push(`Target: ${target} | Depth: ${depth} | Checks: ${checksRun.join(", ")}`);

      if (uniqueIssues.length > 0) {
        lines.push("\nIssues:");
        for (const issue of uniqueIssues.slice(0, 10)) {
          lines.push(`  * ${issue}`);
        }
      }

      if (suggestions.length > 0) {
        lines.push("\nSuggestions:");
        for (const s of suggestions.slice(0, 5)) {
          lines.push(`  -> ${s}`);
        }
      }

      if (!passed) {
        lines.push(
          `\n[verify] Finalize may be blocked. Use the issues above to fix problems before re-running verify.`,
        );
      }

      log.debug(
        `verify: ${passed ? "PASSED" : "FAILED"} (${uniqueIssues.length} issues, conf=${confidence.toFixed(2)})`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          passed: result.passed,
          issues: result.issues,
          confidence: result.confidence,
          suggestions: result.suggestions,
          target: result.target,
          checksRun: result.checksRun,
          verificationMs: result.verificationMs,
          blockedFinalize: !passed,
        },
      };
    },
  };
}
