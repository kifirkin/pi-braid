/**
 * Verification Judge - LLM-based work quality audit.
 *
 * Structured LLM analysis at strategic checkpoints (pre-finalize,
 * verification gap, periodic drift) audits work quality.
 *
 * Uses the shared judge callLlm (judge-utils.ts), which resolves the model
 * with getJudgeModel() (the session model, or the cheapest non-reasoning model
 * when the session model reasons) and falls back utility -> judge/session
 * model. Evaluates whether the agent's work aligns with the user's request,
 * whether code changes are verified, and whether shortcuts were taken.
 *
 * Evidence sources, in descending authority:
 * - DELIVERABLES MANIFEST — files claimed via finalize, verified on disk.
 * - TASK EVIDENCE — timestamped tool results since the task's last real
 *   user message, rebuilt from the pi session store (task-evidence.ts);
 *   survives turn breaks such as wake-retry redeliveries that leave the
 *   turnHistory-derived log with only the tail turn.
 * - GIT HISTORY — recent commits, survives reloads and compactions.
 * - TOOL EXECUTION LOG — current-window turnHistory log (capped); this is
 *   the truncated-by-design view the other sources exist to back up.
 */

/**
 * LLM Judge System Prompt for Work Quality Verification.
 */
const VERIFICATION_JUDGE_SYSTEM_PROMPT = `Evaluate whether the agent's work matches the user's request.

Git history (recent commits) is provided as verification evidence that survives across reloads and compactions. If the GIT HISTORY section shows commits that match the changed files, that is strong evidence the work was completed and verified -- even if the tool log has been truncated.
- **DELIVERABLES MANIFEST (disk-checked):** The DELIVERABLES MANIFEST section lists the agent's claimed deliverables with 'exists: true/false' verified **directly on the filesystem** (not inferred from the tool log). If it shows the claimed files exist on disk, that is ground-truth verification — do NOT emit unverified/warn/fail solely because the TOOL EXECUTION LOG was truncated by compaction. Trust the manifest over absent tool-log entries.
- **TASK EVIDENCE + DELIVERABLES MANIFEST are ground truth equal to GIT HISTORY:** TASK EVIDENCE lists timestamped tool results since the task's last user message across ALL turns (bash/powershell [OK]/[FAIL], sent-message receipts, poller/timer/agent lifecycle). Do NOT emit warn/fail solely because the current-turn TOOL EXECUTION LOG looks truncated or missing — weigh the TASK EVIDENCE section first.
- **Chunk summaries are full-log coverage:** when the task ran long, early TASK EVIDENCE entries may appear as compact chunk summaries of the full log (each preserves per-tool OK/FAIL counts and key commands, followed by the newest entries verbatim). Treat those summaries as trustworthy coverage of the early log, not as truncation.

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
- **CRITICAL: Verification evidence is in the TOOL EXECUTION LOG, not just the text response.**
  The agent runs tests, typechecks, and builds via bash tool calls. Look for these commands
  in the tool log: \`npm test\`, \`npm run typecheck\`, \`npm run build\`, \`tsc\`, \`jest\`, \`vitest\`,
  or any output containing "PASS", "FAIL", "error TS", "tests passed", "typecheck clean".
  If the tool log shows successful verification commands, the work IS verified even if the
  text response doesn't mention it. Tool results are prefixed with [OK] or [FAIL] to show
  exit status without requiring output parsing.

Examples:
{"verdict":"fail","confidence":90,"summary":"Agent deleted auth middleware without running tests","issues":[{"severity":"critical","category":"unverified","description":"No test run after deleting src/auth/middleware.ts"}],"unverifiedChanges":true}
{"verdict":"pass","confidence":92,"summary":"Agent implemented the requested sort function and ran \`npm test\` (tool log shows 81/81 tests passing) — verification evidence is in the tool execution trace, not the response text","issues":[],"unverifiedChanges":false}
{"verdict":"warn","confidence":70,"summary":"Agent made changes and claims they work but didn't run verification","issues":[{"severity":"high","category":"unverified","description":"edit/write tool used but no test or validation command run"}],"unverifiedChanges":true}`;

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLlm, extractJson } from "./judge-utils.js";
import { findSelfStateClaims, renderSelfStateClaimsSection } from "./self-state-claims.js";
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
export interface DeliverableCheck {
  /** Repository-relative path of a claimed deliverable. */
  path: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /** Whether the on-disk sha256 matches the recorded sha256 (undefined if no record / unreadable). */
  sha256Match?: boolean;
}

export interface JudgeContext {
  /** User's original request/task */
  userRequest: string | undefined;
  /** Tools used during this session (unique set) */
  toolsUsed: string[];
  /** Tool execution log (chronological) */
  toolLog: string[];
  /** Has code been modified (edit/write) */
  hasCodeChanges: boolean;
  /** Agent's last response text (for claim detection) */
  lastResponse: string;
  /** Agent's thinking/reasoning text (if available) */
  thinking: string;
  /** Recent git history (git log --oneline -5) for verification evidence across reloads/compactions */
  gitHistory?: string;
  /** Disk-checked deliverables manifest (B17): claimed shipped files verified on the filesystem */
  deliverables?: DeliverableCheck[];
  /**
   * Task-wide evidence lines since the task's last real user message,
   * rebuilt from the pi session store. Survives turn
   * breaks (wake-retry redelivery) that leave toolLog with only the
   * tail turn. Rendered as the TASK EVIDENCE section.
   */
  taskEvidence?: string[];
}

/**
 * Build the verification analysis prompt. Exported for tests.
 */
export function buildVerificationPrompt(context: JudgeContext): string {
  const sections: string[] = [];

  if (context.userRequest) {
    sections.push(`## USER REQUEST\n${context.userRequest}\n`);
  }

  sections.push("## TOOLS USED");
  sections.push(context.toolsUsed.length > 0 ? context.toolsUsed.join(", ") : "(none)");
  sections.push("");

  // Task-wide evidence (since last user message, session-store
  // backed) comes BEFORE the current-window tool log — it is the surviving
  // view when turn breaks cut toolLog down to the tail turn.
  if (context.taskEvidence && context.taskEvidence.length > 0) {
    sections.push("## TASK EVIDENCE (since last user message, disk/session-surviving)");
    sections.push(context.taskEvidence.join("\n"));
    sections.push("");
  }

  if (context.toolLog.length > 0) {
    sections.push("## TOOL EXECUTION LOG");
    sections.push(context.toolLog.slice(-50).join("\n")); // Last 50 entries (matches turnHistory cap)
    sections.push("");
  }

  sections.push(`## CODE CHANGES: ${context.hasCodeChanges ? "YES" : "NO"}`);
  // (Verification evidence comes from the TOOL EXECUTION LOG above, not a boolean)
  sections.push("");

  if (context.thinking) {
    sections.push("## AGENT REASONING (thinking blocks)");
    sections.push(context.thinking);
    sections.push("");
  }

  if (context.gitHistory) {
    sections.push("## GIT HISTORY (recent commits)");
    sections.push(context.gitHistory);
    sections.push("");
  }

  if (context.deliverables && context.deliverables.length > 0) {
    sections.push("## DELIVERABLES MANIFEST (disk-checked — ground truth)");
    const allExist = context.deliverables.every((d) => d.exists);
    sections.push(
      context.deliverables
        .map(
          (d) =>
            `- ${d.exists ? "[OK]" : "[MISSING]"} ${d.path}${d.sha256Match === false ? " (sha256 MISMATCH)" : ""}`,
        )
        .join("\n"),
    );
    sections.push(
      allExist
        ? "\nAll claimed deliverables exist on disk → work is verified."
        : "\nSome deliverables missing on disk → real unverified risk.",
    );
    sections.push("");
  }

  if (context.lastResponse) {
    sections.push("## AGENT RESPONSE (visible text)");
    sections.push(context.lastResponse);
  }

  // Self-state claims: the deterministic detector scans the visible
  // response for liveness/delivery/progress assertions and is suppressed
  // entirely when the evidence window shows a probe call. With no candidates
  // nothing is appended (prompt byte-unchanged); with candidates the section
  // carries its own rule, so the judge system prompt stays untouched.
  const selfStateClaims = findSelfStateClaims({
    responseText: context.lastResponse,
    toolsUsed: context.toolsUsed,
    taskEvidence: context.taskEvidence,
    toolLog: context.toolLog,
  });
  if (selfStateClaims.length > 0) {
    sections.push(renderSelfStateClaimsSection(selfStateClaims));
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
      const prefix =
        issue.severity === "critical" ? "[high]" : issue.severity === "high" ? "[warn]" : "[med]";
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
