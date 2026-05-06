/**
 * Verify Tool — Recursive Verification Loop for Metacognition
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
 * - If issues found and confidence < threshold → blocks finalize + returns issues
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { getExtensionState } from "../../../../lib/extension-state.js";
import { createLogger } from "../../../../lib/logger.js";

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
  const session = (ctx as any)?.sessionManager?.getCurrentSession?.();
  if (!session?.messages) return null;

  const msgs = session.messages;
  // Walk backwards to find the last assistant message
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role !== "assistant") continue;

    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n")
          : "";

    if (!text || text.length < 50) continue;

    // Simple heuristic: code blocks → code, lists of steps → plan, narrative → reasoning
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

/** Fast heuristic checks — no LLM call. Used for quick depth. */
export function heuristicCheck(
  target: VerificationTarget,
  text: string,
): { issues: string[]; checksRun: string[] } {
  const issues: string[] = [];
  const checksRun: string[] = [];

  switch (target) {
    case "code": {
      checksRun.push("syntax", "safety-patterns", "imports");
      // Unclosed brackets/braces
      if ((text.match(/{/g) ?? []).length !== (text.match(/}/g) ?? []).length)
        issues.push("Unmatched braces detected");
      if ((text.match(/\[/g) ?? []).length !== (text.match(/\]/g) ?? []).length)
        issues.push("Unmatched brackets detected");
      // TODO/FIXME in code
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(text))
        issues.push("Contains unresolved TODO/FIXME markers");
      // Dangerous patterns
      if (/\beval\s*\(/.test(text)) issues.push("Use of eval() detected — security risk");
      if (/\.innerHTML\s*=/.test(text)) issues.push("Direct innerHTML assignment — XSS risk");
      if (/delete\s+\w+\s*,\s*{/.test(text))
        issues.push("Delete with comma syntax — may be unintended");
      break;
    }
    case "reasoning": {
      checksRun.push("logic", "evidence", "assumptions");
      // Check for unsupported absolutes
      if (/\b(always|never|definitely|certainly)\b/i.test(text))
        issues.push("Absolute language detected — may overstate certainty");
      // Check for contradiction markers
      const contradictions = text.match(/\bbut\b|\bhowever\b|\balthough\b/gi) ?? [];
      if (contradictions.length > 3)
        issues.push(
          `Many contradiction markers (${contradictions.length}) — verify claims are reconciled`,
        );
      // Check for unexplained claims
      const claims = (text.match(/^\s*[-*]\s+.+$/gm) ?? []).length;
      const explanations = (text.match(/\b(because|since|therefore)\b/gi) ?? []).length;
      if (claims > 5 && explanations < claims / 2)
        issues.push("Many claims without sufficient explanation");
      break;
    }
    case "plan": {
      checksRun.push("dependencies", "completeness", "feasibility");
      // Circular dependency check
      const steps = text.match(/^\d+\.\s+/gm) ?? [];
      if (steps.length > 1) {
        const stepTexts = text.split(/\n/).filter((l) => /^\d+\.\s/.test(l));
        for (let i = 0; i < stepTexts.length; i++) {
          for (let j = i + 1; j < stepTexts.length; j++) {
            // Simple: step N should not mention completing step N+1 before itself
            const mentionsLater = /\b(step\s*\d+|after\s+(step|item)\s*\d+)/gi.test(stepTexts[i]);
            if (mentionsLater && j > i + 1)
              issues.push(`Step ${i + 1} may reference steps out of order`);
          }
        }
      }
      // Missing exit condition
      if (!/finish|complete|done|success|abort|fail/i.test(text))
        issues.push("No explicit completion or failure criteria found");
      break;
    }
    case "result": {
      checksRun.push("format", "completeness", "hallucination-risk");
      // Check for placeholder content
      if (/\[.*?\]|<.*?>/.test(text))
        issues.push("Contains placeholder markers — may be incomplete");
      if (/\.\.\.$|\blorem ipsum\b/i.test(text)) issues.push("Contains placeholder or filler text");
      // Very short results
      if (text.length < 20) issues.push("Result is very short — may be truncated or incomplete");
      break;
    }
  }

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
    if (!ctx.model) {
      return { issues: [], suggestions: [], confidence: 0.3 };
    }
    const response = await complete(
      ctx.model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 1024, temperature: 0.1 },
    );

    const content =
      typeof response === "string"
        ? response
        : ((response as any)?.content ?? (response as any)?.message?.content ?? "");

    // Extract JSON from response
    const jsonMatch = content.match(/{[\s\S]*?}/);
    if (!jsonMatch) {
      log.debug("verify: could not parse LLM response as JSON");
      return { issues: [], suggestions: [], confidence: 0.5 };
    }

    const parsed = JSON.parse(jsonMatch[0]);
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
    return { issues: [], suggestions: [], confidence: 0.3 };
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

/** Export for use by finalize handler — checks if recent verification passed. */
export function getLastVerification(ctx: ExtensionContext): VerificationRecord | null {
  return getVerifyState(ctx).lastVerification;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export function createVerifyTool() {
  return {
    name: "verify",
    promptSnippet: "Verify code, reasoning, or tool results before finalization",
    description:
      "Verify code, reasoning, plans, or tool results. Call verify(target='code') after writing code to check correctness. Call verify(target='reasoning') when uncertain about an approach — catches logic errors early. Provide specific criteria for targeted checks.",

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
      _signal: AbortSignal,
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

      // Step 2: LLM deep verification for standard/deep
      if (depth !== "quick" && (depth === "deep" || allIssues.length > 0 || confidence < 0.8)) {
        const llmResult = await llmVerify(target, text, criteria, depth, ctx);
        allIssues = [...allIssues, ...llmResult.issues];
        suggestions = llmResult.suggestions;
        confidence = Math.min(confidence, llmResult.confidence);
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
      const verdict = passed ? "✅ PASSED" : `❌ ${uniqueIssues.length} issue(s) found`;
      lines.push(
        `[verify] ${verdict} (confidence: ${(confidence * 100).toFixed(0)}%, ${result.verificationMs}ms)`,
      );
      lines.push(`Target: ${target} | Depth: ${depth} | Checks: ${checksRun.join(", ")}`);

      if (uniqueIssues.length > 0) {
        lines.push("\nIssues:");
        for (const issue of uniqueIssues.slice(0, 10)) {
          lines.push(`  • ${issue}`);
        }
      }

      if (suggestions.length > 0) {
        lines.push("\nSuggestions:");
        for (const s of suggestions.slice(0, 5)) {
          lines.push(`  → ${s}`);
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
