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

/**
 * LLM Judge System Prompt for Work Quality Verification.
 */
const VERIFICATION_JUDGE_SYSTEM_PROMPT = `Evaluate whether the agent's work matches the user's request.

Output a JSON object with exactly these fields:
- verdict: "pass" | "warn" | "fail"
- confidence: number 0-100
- summary: string (2-3 sentences)
- issues: array of { severity: "critical"|"high"|"medium"|"low", category: "unverified"|"incomplete"|"shortcut"|"claim"|"scope", description: string }
- unverifiedChanges: boolean

Rules:
- pass = work matches request, changes verified, no shortcuts
- warn = work mostly matches but has minor gaps or unverified changes
- fail = work doesn't match, significant shortcuts, or claims without evidence
- Be strict - the agent should verify changes before declaring done
- If user request is missing or empty, evaluate the agent's last response and tool execution log to infer the task. Check: did the agent make concrete changes? Did it verify them? Does the response have specific claims without evidence?

Examples:
{"verdict":"fail","confidence":90,"summary":"Agent deleted auth middleware without running tests","issues":[{"severity":"critical","category":"unverified","description":"No test run after deleting src/auth/middleware.ts"}],"unverifiedChanges":true}
{"verdict":"pass","confidence":85,"summary":"Agent implemented the requested sort function and verified with test suite","issues":[],"unverifiedChanges":false}
{"verdict":"warn","confidence":70,"summary":"Agent made changes and claims they work but didn't run verification","issues":[{"severity":"high","category":"unverified","description":"edit/write tool used but no test or validation command run"}],"unverifiedChanges":true}`;

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
      const prefix = issue.severity === "critical" ? "[high]" : issue.severity === "high" ? "[warn]" : "[med]";
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
 * @param options - Optional timeout + cancellation signal.
 *                  The signal is threaded into the underlying callLlm
 *                  so ESC / session shutdown aborts the judge cleanly
 *                  instead of letting it run to its 30s timeout.
 *                  Pass `signal: ctx.signal` from the caller (the
 *                  MESSAGE_END handler receives ctx but not an
 *                  execute-style signal parameter).
 * @returns Verification verdict or null on failure
 */
export async function runVerificationJudge(
  ctx: ExtensionContext,
  judgeContext: JudgeContext,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VerificationVerdict | null> {
  const prompt = buildVerificationPrompt(judgeContext);
  const result = await callLlm(ctx, VERIFICATION_JUDGE_SYSTEM_PROMPT, prompt, {
    ...options,
    // The judge-utils wrapper accepts signal through LlmCallOptions
    // (it's part of the shared callLlm signature), so just spread
    // options through. We re-state signal explicitly so the
    // signal-threading contract is grep-able at this call site.
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if ("error" in result) {
    log.warn("Verification judge error:", result.error);
    return null;
  }

  return parseVerificationOutput(result.text);
}
