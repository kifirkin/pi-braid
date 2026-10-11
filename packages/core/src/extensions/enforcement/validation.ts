/**
 * Validation Logic
 *
 * Validates turns and tool usage patterns with smart detection that avoids
 * false positives for legitimate workflows (e.g. reading different files).
 */

import { ENFORCEMENT_PARAMS, getState } from "./state.js";
import { PROGRESS_TOOLS } from "./substate/tool-tracking-state.js";
import type { TurnState, ValidationResult } from "./types.js";

// Tools that are cheap to repeat legitimately (different files/targets)
const LEGIT_REPEATABLE = new Set<string>(["read", "grep", "find"]);

/**
 * Check if a tool sequence is semantically repetitive.
 * "read,read" on different files is fine. "read,read" on same file is wasteful.
 *
 * Returns:
 *  - null  : not a repetition problem
 *  - string: the issue message
 */
function checkSemanticRepetition(
  currentTools: string[],
  prevSeqs: string[][],
  warnThreshold: number,
): string | null {
  // Single-tool repetition: "read,read", "bash,bash"
  // These are NOT flagged as issues since read can hit different files,
  // bash can run different commands. Only flag if same PATH is targeted
  // (detected elsewhere via file path tracking).
  if (
    currentTools.length === 1 ||
    (currentTools.length === 2 && currentTools[0] === currentTools[1])
  ) {
    return null;
  }

  const currentSeq = currentTools.join(",");
  const repetitions = prevSeqs.filter((s) => s.join(",") === currentSeq).length;

  if (repetitions >= warnThreshold) {
    // Build a contextual message instead of raw tool names
    const tools = currentTools.join(" -> ");
    // If the sequence contains only cheap/repeatable tools, be softer
    const allRepeatable = currentTools.every((t) => LEGIT_REPEATABLE.has(t));
    if (allRepeatable) {
      return (
        `Exploration sequence "${tools}" repeated ${repetitions + 1} times without progress. ` +
        `Consider: editing files, running commands, or using think() to plan next steps.`
      );
    }
    return `Tool sequence "${tools}" repeated ${repetitions + 1} times. Consider a different approach.`;
  }

  return null;
}

/**
 * Detect wasteful re-reads: same file read without intervening progress.
 * This is the real problem behind "read,read" false positives.
 *
 * `reReadPaths` comes from the recentlyReadFiles map: recordToolInput stores
 * each read under its tool-call position and flags a path at read time when
 * the prior read has no progress tool after it. The list is per-turn and is
 * consumed by the caller.
 */
function checkReReadWaste(
  currentTools: string[],
  prevTools: string[][],
  reReadPaths: string[],
): string | null {
  // Only relevant for read-heavy turns
  const readCount = currentTools.filter((t) => t === "read").length;
  if (readCount < 2) return null;

  if (reReadPaths.length > 0) {
    const shown = reReadPaths.slice(0, 3).join(", ");
    const rest = reReadPaths.length > 3 ? ` (+${reReadPaths.length - 3} more)` : "";
    return (
      `Re-read ${reReadPaths.length} file(s) already in context with no edit or command since: ` +
      `${shown}${rest}. Work from the earlier read output instead of re-reading.`
    );
  }

  // Check if we've seen a read-only streak recently (no progress tools in between)
  let streak = 0;
  for (let i = prevTools.length - 1; i >= 0; i--) {
    const tools = prevTools[i];
    if (tools.length === 1 && tools[0] === "read") {
      streak++;
    } else if (tools.some((t) => PROGRESS_TOOLS.has(t))) {
      break;
    } else {
      streak++;
      if (streak > 3) break;
    }
  }

  if (streak >= 8 && readCount >= 5) {
    return (
      `You've spent ${streak + 1} turns mostly reading. Store what you've learned: ` +
      `memory_store(content="...", tags=["pattern", "codebase"]) and update scratchpad before continuing.`
    );
  }

  return null;
}

/**
 * Validate a turn's tool usage
 */
export function validateTurn(
  _previousState: TurnState | undefined,
  currentState: TurnState,
  ctx: any,
  erroredTools: Set<string> = new Set(),
  isInfrastructureError: boolean = false,
): ValidationResult {
  const s = getState(ctx);
  const issues: string[] = [];
  const hadErrors = erroredTools.size > 0;

  // Consume the per-turn re-read list here, even on turns that skip the
  // checks below, so it cannot leak into the next turn's report.
  const reReadWastePaths = s.turnReReadWastePaths;
  s.turnReReadWastePaths = [];

  // Skip if infrastructure error (API timeout, rate-limit, etc.) - the agent tried to work but couldn't
  if (isInfrastructureError) {
    // Don't penalize the agent for infrastructure failures
    s.silentTurns = 0;
  } else if (currentState.actualTools.length === 0) {
    s.silentTurns++;
    if (s.silentTurns >= ENFORCEMENT_PARAMS.maxSilentTurns) {
      issues.push(
        `${s.silentTurns} turns without tool calls. You work through tools - reach for read, bash, edit, write to make progress.`,
      );
    }
  } else {
    s.silentTurns = 0;
  }

  // Check for tool sequence repetition - smart detection avoids false positives
  if (!hadErrors && currentState.actualTools.length > 0) {
    const prevSeqs = s.recentToolSequences.slice(-ENFORCEMENT_PARAMS.warnOnToolSequenceRepetition);

    // Semantic repetition check (handles read,read etc. properly)
    const seqIssue = checkSemanticRepetition(
      currentState.actualTools,
      prevSeqs,
      ENFORCEMENT_PARAMS.warnOnToolSequenceRepetition,
    );
    if (seqIssue) {
      issues.push(seqIssue);
    }

    // Re-read waste detection
    const readWasteIssue = checkReReadWaste(currentState.actualTools, prevSeqs, reReadWastePaths);
    if (readWasteIssue) {
      issues.push(readWasteIssue);
    }

    // Track sequence (always, for next-turn analysis)
    s.recentToolSequences.push([...currentState.actualTools]);
    if (s.recentToolSequences.length > 20) {
      s.recentToolSequences.shift();
    }
  }

  // Generate nudge message
  let nudge: string | null = null;
  let severity: "info" | "warning" | "critical" = "info";

  if (issues.length > 0) {
    if (!hadErrors) {
      s.validationFailures++;
    }
    severity =
      s.validationFailures > 3 ? "critical" : s.validationFailures > 1 ? "warning" : "info";
    nudge = `
## Turn Validation Failed

${issues.map((i) => `- ${i}`).join("\n")}
`;
  }

  return {
    passed: issues.length === 0,
    issues,
    nudge,
    severity,
  };
}
