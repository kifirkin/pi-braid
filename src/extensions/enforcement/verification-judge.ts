/**
 * Verification Judge - LLM-based work quality audit
 *
 * Replaces regex-based claim/lazy detection with structured LLM analysis
 * at strategic checkpoints (pre-finalize, verification gap, periodic drift).
 *
 * Uses completeSimple() with the session model (ctx.model). Evaluates whether
 * the agent's work aligns with the user's request, whether code changes
 * are verified, and whether shortcuts were taken.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { VERIFICATION_JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";
import { callLlm, extractJson } from "./judge-utils.js";
import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("verification-judge");

/**
 * Result from the verification judge analysis
 */
export interface VerificationVerdict {
  /** Overall pass/fail/warn */
  verdict: "pass" | "warn" | "fail";
  /** Confidence 0-100 */
  confidence: number;
  /** Human-readable summary */
  summary: string;
  /** Specific issues found (empty if pass) */
  issues: VerificationIssue[];
  /** Whether code changes exist that haven't been verified */
  unverifiedChanges: boolean;
}

export interface VerificationIssue {
  severity: "critical" | "high" | "medium" | "low";
  category: "unverified" | "incomplete" | "shortcut" | "claim" | "scope";
  description: string;
}

/**
 * Context snapshot passed to the judge for analysis
 */
export interface JudgeContext {
  /** User's original request/task */
  userRequest: string | undefined;
  /** Tools used during this session (unique set) */
  toolsUsed: string[];
  /** Tool execution log (chronological) */
  toolLog: string[];
  /** Has code been modified (edit/write) */
  hasCodeChanges: boolean;
  /** Has verification been run (bash with test commands) */
  hasVerification: boolean;
  /** Agent's last response text (for claim detection) */
  lastResponse: string;
  /** Agent's thinking/reasoning text (if available) */
  thinking: string;
}

/**
 * Build the verification analysis prompt
 */
function buildVerificationPrompt(context: JudgeContext): string {
  const sections: string[] = [];

  if (context.userRequest) {
    sections.push(`## USER REQUEST\n${context.userRequest}\n`);
  }

  sections.push("## TOOLS USED");
  sections.push(context.toolsUsed.length > 0 ? context.toolsUsed.join(", ") : "(none)");
  sections.push("");

  if (context.toolLog.length > 0) {
    sections.push("## TOOL EXECUTION LOG");
    sections.push(context.toolLog.slice(-30).join("\n")); // Last 30 entries
    sections.push("");
  }

  sections.push(`## CODE CHANGES: ${context.hasCodeChanges ? "YES" : "NO"}`);
  sections.push(`## VERIFICATION RUN: ${context.hasVerification ? "YES" : "NO"}`);
  sections.push("");

  if (context.thinking) {
    sections.push("## AGENT REASONING (thinking blocks)");
    sections.push(context.thinking);
    sections.push("");
  }

  if (context.lastResponse) {
    sections.push("## AGENT RESPONSE (visible text)");
    sections.push(context.lastResponse);
  }

  return sections.join("\n");
}

/**
 * Parse judge output with robust error handling
 */
export function parseVerificationOutput(raw: string): VerificationVerdict | null {
  try {
    const jsonStr = extractJson(raw);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    const issues: VerificationIssue[] = (parsed.issues ?? [])
      .filter((i: Record<string, unknown>) => i.description && i.category)
      .map((i: Record<string, unknown>) => ({
        severity: (i.severity as VerificationIssue["severity"]) ?? "medium",
        category: i.category as VerificationIssue["category"],
        description: i.description as string,
      }));

    const verdict = ["pass", "warn", "fail"].includes(parsed.verdict)
      ? (parsed.verdict as VerificationVerdict["verdict"])
      : "warn";

    return {
      verdict,
      confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
      summary: parsed.summary ?? "Analysis complete",
      issues,
      unverifiedChanges: parsed.unverifiedChanges ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Format judge result as enforcement nudge message
 */
export function formatVerificationNudge(result: VerificationVerdict): string {
  const lines: string[] = [];

  const icon =
    result.verdict === "fail" ? "[FAIL]" : result.verdict === "warn" ? "[WARN]" : "[PASS]";
  lines.push(`## ${icon} VERIFICATION JUDGE: ${result.verdict.toUpperCase()}`);

  if (result.summary) {
    lines.push(`\n**Summary:** ${result.summary}`);
  }

  if (result.issues.length > 0) {
    lines.push("\n**Issues:**");
    for (const issue of result.issues) {
      const prefix = issue.severity === "critical" ? "🔴" : issue.severity === "high" ? "🟠" : "🟡";
      lines.push(`- ${prefix} [${issue.category}] ${issue.description}`);
    }
  }

  if (result.unverifiedChanges) {
    lines.push(
      "\n**Unverified code changes detected.** Run tests or commands to verify before finalizing.",
    );
  }

  lines.push(`\n*Confidence: ${result.confidence}%*`);

  return lines.join("\n");
}

/**
 * Run the verification judge analysis
 *
 * @param ctx - Extension context for model access
 * @param judgeContext - Context snapshot for analysis
 * @returns Verification verdict or null on failure
 */
export async function runVerificationJudge(
  ctx: ExtensionContext,
  judgeContext: JudgeContext,
  options: { timeoutMs?: number } = {},
): Promise<VerificationVerdict | null> {
  const prompt = buildVerificationPrompt(judgeContext);
  const result = await callLlm(ctx, VERIFICATION_JUDGE_SYSTEM_PROMPT, prompt, options);

  if ("error" in result) {
    log.warn("Verification judge error:", result.error);
    return null;
  }

  return parseVerificationOutput(result.text);
}
