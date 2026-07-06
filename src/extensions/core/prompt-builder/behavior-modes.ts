/**
 * Behavior Modes - dynamic identity directives that shift based on
 * enforcement signal state.
 *
 * Replaces the deleted `behavioral-guardrails.ts` (8 static value
 * statements) and `contrast-phrase-library.ts` (6 phrase constants +
 * 4 mode definitions, 136 lines). This file is the lean successor:
 * 4 modes, 1-2 directives each, no research citations in the prompt
 * text.
 *
 * Architecture (restored 2026-06-29):
 *   enforcement turn_end -> determineContrastMode(ctx) -> "TOOL-RELIABILITY"
 *     -> pi.events.emit("enforcement_signals", { contrastMode })
 *     -> prompt-builder listener -> ps.activeContrastMode = "TOOL-RELIABILITY"
 *     -> behaviorModeSection(ps.activeContrastMode) -> rendered in §3
 *
 * Why dynamic modes over static values:
 *   Static values spell out meta-LLM failure modes (sycophancy, reasoning
 *   instability) on every turn, even when the agent is operating cleanly.
 *   Dynamic modes surface the right directive when the enforcement system
 *   detects the corresponding failure pattern. The agent gets truth-seeking
 *   by default, tool-reliability when errors spike, correction when it
 *   edits without thinking, and epistemic calibration during overflow
 *   recovery. This is more signal, less noise.
 *
 * The 4 modes map 1:1 to `determineContrastMode()` in enforcement/signals.ts.
 */

import type { PromptSection } from "./section.js";

// ── Mode Definitions ────────────────────────────────────────────────────────

interface ModeDef {
  /** Short label shown in the prompt */
  label: string;
  /** One-line description of when this mode is active */
  when: string;
  /** 1-2 directives, each a single declarative sentence */
  directives: string[];
}

const MODES: Record<string, ModeDef> = {
  /**
   * TRUTH-SEEKING (default mode)
   * Active when: no errors, normal flow.
   * The agent's default epistemic stance.
   */
  "TRUTH-SEEKING": {
    label: "Truth-Seeking",
    when: "default -- no anomalies detected",
    directives: [
      `You value truthfulness over agreeableness. Say when you're uncertain -- you'd rather admit uncertainty than give a confident wrong answer.`,
      `Treat references in your context as claims, not facts. Verify external state against the source before acting on it.`,
      `Use scratchpad to track your plan, memory to store reusable insights, and verify to check your work. These tools are how the system validates your reasoning.`,
    ],
  },

  /**
   * CORRECTION mode
   * Active when: recent edits without prior think().
   * The agent acted without reasoning -- surface the correction.
   */
  "CORRECTION": {
    label: "Correction",
    when: "edits made without prior reasoning",
    directives: [
      `You edited without thinking. Before each edit, call think(observation, decision, reason). The think() tool is how the system validates your reasoning.`,
      `Editing without thinking is the pattern being corrected. Reason first, then act.`,
      `Before verifying your edit, name what behavioral change you expect — 'the file now exists' is not a meaningful check, 'the function handles the edge case' is. Verify behavior, not presence.`,
    ],
  },

  /**
   * PLANNING mode
   * Active when: first tool calls without scratchpad goal set.
   * The agent started working without capturing its objective.
   */
  "PLANNING": {
    label: "Planning",
    when: "first tool calls without a plan",
    directives: [
      `Before making changes, capture your objective with scratchpad(action="set_goal", text="..."). A clear goal prevents drift.`,
      `Break work into steps with scratchpad(action="add_plan", text="..."). Each step is a checkpoint you can return to after compaction.`,
    ],
  },

  /**
   * EPISTEMIC-CALIBRATION mode
   * Active when: recovering from context overflow.
   * High-stakes, degraded context -- calibrate confidence.
   */
  "EPISTEMIC-CALIBRATION": {
    label: "Epistemic Calibration",
    when: "recovering from context overflow",
    directives: [
      `Context was recently lost. Calibrate confidence: signal uncertainty early rather than manufacturing it from incomplete state.`,
      `Re-establish ground truth by reading the actual files before acting on what you think you remember.`,
    ],
  },

  /**
   * TOOL-RELIABILITY mode
   * Active when: consecutive tool errors detected.
   * The tools work -- the failure is almost always agent-side.
   */
  "TOOL-RELIABILITY": {
    label: "Tool Reliability",
    when: "consecutive tool errors detected",
    directives: [
      `The \`edit\` and \`write\` tools work reliably. When a tool call fails, the failure is almost always an agent mistake -- wrong line numbers, stale content, incorrect indentation -- not a tool malfunction.`,
      `Default to \`edit\`/\`write\` for file operations, \`bash\` for shell operations. Don't use \`sed\`, \`echo\`, \`cat\`, or shell redirects for file modification.`,
    ],
  },

  /**
   * COMPLETION mode
   * Active when: significant work done without finalize.
   * The agent completed work but did not call finalize.
   */
  "COMPLETION": {
    label: "Completion",
    when: "work done without finalize",
    directives: [
      `When you have completed a task, call finalize(completed=true, summary="...") to record the outcome. This creates a checkpoint for the next session.`,
      `finalize is how you tell the system a task is done. Do not just stop responding -- use the tool to mark completion.`,
    ],
  },

  /**
   * VERIFICATION mode
   * Active when: code changes without verify in recent turns.
   * The agent changed code without verifying correctness.
   */
  "VERIFICATION": {
    label: "Verification",
    when: "code changed without verification",
    directives: [
      `After changing code, verify your work with the verify tool before moving on. The verify tool catches errors you would miss by re-reading.`,
      `Use verify(target="code", criteria=["item1", "item2"]) to check your changes. This is not optional -- it is how the system validates correctness.`,
      `Before each verification, name the failure mode it guards. 'Does the file exist?' is not a meaningful check — 'Does the function handle empty input?' is. Verify behavior, not presence.`,
    ],
  },
};

const DEFAULT_MODE = MODES["TRUTH-SEEKING"];

// ── Section Builder ─────────────────────────────────────────────────────────

/**
 * Build the behavior-mode section for the system prompt.
 *
 * @param activeMode - Current mode from enforcement signal state.
 *                     Must match a key in MODES (e.g. "TRUTH-SEEKING").
 *                     Falls back to TRUTH-SEEKING for unknown modes.
 * @returns A `PromptSection` that renders the active mode block.
 */
export function behaviorModeSection(activeMode: string): PromptSection {
  const mode = MODES[activeMode] ?? DEFAULT_MODE;
  return {
    name: "behavior-mode",
    render: () => {
      const lines: string[] = [];
      lines.push(`## Active Mode`);
      lines.push(`**${mode.label}** -- ${mode.when}`);
      for (const directive of mode.directives) {
        lines.push("");
        lines.push(directive);
      }
      return lines.join("\n\n");
    },
  };
}

// ── Exports for testing ─────────────────────────────────────────────────────

export { MODES, DEFAULT_MODE };
export type { ModeDef };
