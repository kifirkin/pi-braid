/**
 * Test-Burst Detector (Part 3 — auto-rollback test-debug guard)
 *
 * Evidence: the checkpoint extension's
 * auto-rollback fired mid-implementation on a LEGITIMATE failing-test loop
 * (error rate 10.6%, bash test-runner invocations), rewound the conversation
 * to turn 21, and cost ~1.4M tokens of cache-invalidated re-prefill. An
 * agent legitimately running failing tests (TDD, gate triage) is NOT a
 * degraded agent — the rollback must not fire on it.
 *
 * Design (brief constraint): fix at the DECISION point (autoRollback's
 * restore step), never by disabling telemetry. The detector keeps a bounded
 * per-session ring of recent tool outcomes (fed from the enforcement
 * tool_result handler) and classifies whether the current error burst is
 * DOMINATED by test-runner invocations:
 *   - outputs carry test-runner markers (pass/fail counts, runner banners,
 *     assertion errors) or the command is a test-runner invocation;
 *   - ZERO errors span non-test tool families — the brief's hard rule:
 *     a single non-test failure means genuine degradation, rollback stays
 *     exactly as today (no weakening).
 *
 * When suppressed, the watchdog/auto-rollback action downgrades to
 * whisper-only: the degradation advisory still fires, the destructive
 * conversation rewind is withheld.
 *
 * State model: getExtensionState(ctx...) — per-session, no module-level
 * let (lib/state/AGENTS.md contract). The ring is bounded and stores only
 * scalars (tool name + booleans) — no tool output is retained.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";

/** Ring window of recent tool outcomes kept per session. */
const BURST_WINDOW = 12;

/** Minimum test-marked errors in the window before suppression applies. */
export const MIN_BURST_ERRORS = 3;

/** Cap on retained command/output snippets — scalars only, never full output. */
const SNIPPET_MAX_CHARS = 200;

interface BurstOutcome {
  toolName: string;
  isError: boolean;
  testLike: boolean;
  ts: number;
}

interface TestBurstState {
  outcomes: BurstOutcome[];
}

function burstState(ctx: ExtensionContext): TestBurstState {
  return getExtensionState(ctx, "test-burst-guard", () => ({
    outcomes: [] as BurstOutcome[],
  }));
}

// ── Test-runner classification ───────────────────────────────────────────────

/**
 * Command lines that are test-runner invocations. Intentionally covers the
 * common JS/TS + polyglot runners; unknown runners fall back to output
 * markers below.
 */
const RUNNER_COMMAND_RE =
  /\b(npm (run )?test|npm test|npx (vitest|jest|mocha|tsc|tsx|playwright)\b|node --test|node -[-]+test|pnpm (run )?test|yarn test|pytest|python -m pytest|cargo test|go test|make test|mvn test|gradle test|vitest|jest|playwright test)\b/;

/**
 * Test-runner OUTPUT markers: numeric pass/fail counts, runner summary
 * banners, check/cross result marks, assertion errors, TAP lines.
 */
const RUNNER_OUTPUT_RE =
  /\b\d+ (passing|failing|passed|failed)\b|\bTest Suites?:\s*\d+|\bTests?:\s*\d+|\b\d+\/\d+ (tests?|specs?|passing|failing)\b|\bfailures?:\s*\d+|^\s*(ok|not ok) \d+ |\bAssertionError\b|\bexpect\w*\([^)]*\)\s*(to|received)|[✓✔]|(✗|✘)/;

/**
 * True when a command/output pair looks like a test-runner invocation.
 * Either signal suffices (command OR output). Both inputs optional —
 * missing telemetry degrades to "not test-like" (conservative: rollback
 * stays for unclassifiable errors).
 */
export function classifyTestRunnerSignal(command?: string, output?: string): boolean {
  if (command && RUNNER_COMMAND_RE.test(command)) return true;
  if (output && RUNNER_OUTPUT_RE.test(output)) return true;
  return false;
}

// ── Ring feed ────────────────────────────────────────────────────────────────

/**
 * Record one tool outcome in the per-session burst ring. Called from the
 * enforcement tool_result handler for EVERY tool result (success and error —
 * successes bound the burst window). Never throws; stores scalars only.
 *
 * @param ctx     extension context (session scope)
 * @param toolName tool that produced the result
 * @param isError whether the tool call failed
 * @param signal  optional command (bash input) / output text for classification
 */
export function noteToolOutcomeForBurst(
  ctx: ExtensionContext,
  toolName: string,
  isError: boolean,
  signal?: { command?: string; output?: string },
): void {
  try {
    const s = burstState(ctx);
    const command =
      typeof signal?.command === "string" ? signal.command.slice(0, SNIPPET_MAX_CHARS) : undefined;
    const output =
      typeof signal?.output === "string" ? signal.output.slice(0, SNIPPET_MAX_CHARS) : undefined;
    s.outcomes.push({
      toolName: String(toolName ?? "").slice(0, SNIPPET_MAX_CHARS),
      isError: Boolean(isError),
      testLike: classifyTestRunnerSignal(command, output),
      ts: Date.now(),
    });
    if (s.outcomes.length > BURST_WINDOW) {
      s.outcomes = s.outcomes.slice(-BURST_WINDOW);
    }
  } catch {
    // guard telemetry never fatal
  }
}

// ── Burst evaluation ─────────────────────────────────────────────────────────

export interface TestBurstEvaluation {
  /** An error burst exists in the window (>= MIN_BURST_ERRORS errors). */
  burst: boolean;
  /** Errors in the window carrying test-runner markers. */
  testErrors: number;
  /** Errors in the window NOT carrying test-runner markers. */
  nonTestErrors: number;
  /**
   * The burst is test-dominated AND no error spans a non-test tool family —
   * the only condition under which rollback may be downgraded.
   */
  testDominated: boolean;
}

/**
 * Evaluate the recent tool-outcome window. Suppression rule (strict, per
 * brief): suppress the destructive rollback ONLY when the window holds at
 * least MIN_BURST_ERRORS errors, EVERY one of them carries test-runner
 * markers, and zero errors belong to non-test tool families. Any non-test
 * error => genuine degradation => rollback behaves exactly as today.
 */
export function evaluateTestBurst(ctx: ExtensionContext): TestBurstEvaluation {
  const result = { burst: false, testErrors: 0, nonTestErrors: 0, testDominated: false };
  try {
    const s = burstState(ctx);
    const window = s.outcomes.slice(-BURST_WINDOW);
    const errors = window.filter((o) => o.isError);
    if (errors.length < MIN_BURST_ERRORS) return result;
    result.burst = true;
    result.testErrors = errors.filter((e) => e.testLike).length;
    result.nonTestErrors = errors.length - result.testErrors;
    result.testDominated = result.testErrors >= MIN_BURST_ERRORS && result.nonTestErrors === 0;
  } catch {
    // evaluation never fatal — default (no suppression) on any failure
  }
  return result;
}

/** Convenience wrapper: should the destructive rollback be withheld? */
export function shouldSuppressRollbackForTestBurst(ctx: ExtensionContext): boolean {
  return evaluateTestBurst(ctx).testDominated;
}
