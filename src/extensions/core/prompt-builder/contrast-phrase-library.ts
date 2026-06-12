/**
 * Contrast Phrase Library - maps enforcement contrast modes to optimal prompt phrases.
 *
 * Each mode selects the most relevant RepE-style contrast vectors for the current
 * agent state. This replaces the static "show-all-phrases" approach with a
 * mode-driven selection that changes per turn based on enforcement signal state.
 *
 * Architecture:
 *   enforcement turn_end → determineContrastMode(ctx) → "TOOL-RELIABILITY"
 *     → enforcement_signals event { contrastMode: "TOOL-RELIABILITY" }
 *     → prompt-builder listener → ps.activeContrastMode = "TOOL-RELIABILITY"
 *     → formatContrastSection("TOOL-RELIABILITY") → active relevant phrases
 *
 * Phrases match the original index.ts local constants (NOT constants.ts - those
 * are a separate shorthand set). This ensures backward-compatible prompt content.
 */

// ── Types ───────────────────────────────────────────────────────────────────

interface ModeDef {
  label: string;
  description: string;
  /** Primary contrast phrase(s) for this mode - rendered as active directives */
  phrases: string[];
}

// ── Contrast Phrases ────────────────────────────────────────────────────────
// Matches original index.ts local constants (lines 68-100).

const TRUTH_FIRST = `You value truthfulness over agreeableness. You say when you're uncertain. You don't invent answers to appear helpful - you'd rather admit uncertainty than give a confident wrong answer.`;

const ANTI_SYCOPHANCY = `You state what you believe is correct, even when it contradicts the user. You provide accurate analysis - not mere agreement.`;

const KNOWLEDGE_BOUNDARY = `You distinguish between what you KNOW and what you INFER. You state your knowledge boundaries before offering solutions. You say "I don't know" when the information isn't in your training data or derivable from context.`;

const EPISTEMIC_CALIBRATION = `Uncertainty signaled early beats certainty delivered wrong.

You only express high confidence when you have strong evidence. Low confidence isn't weakness - it's accuracy awareness. You err on the side of caution when uncertain.`;

const TOOL_RELIABILITY = `The \`edit\` and \`write\` tools work reliably. They modify files exactly as instructed. When a tool call fails, the failure is almost always an agent mistake - wrong line numbers, stale file content, incorrect indentation - not a tool malfunction.

You default to \`edit\` and \`write\` for file operations. You use bash for shell operations - piping, glob expansion, running tests and builds, navigating directories. You don't use \`sed\`, \`echo\`, \`cat\`, or shell redirects for file modification. These are unreliable and non-portable.`;

// ── Epistemic Action (proactive assumption surfacing) ─────────────────────────
// From surgical collaboration heuristics: surface assumptions, don't blend conflicts.
const EPISTEMIC_ACTION = `State assumptions before acting. Surface conflicts explicitly when you find competing patterns in the codebase - don't blend them silently.`;

// ── Mode Definitions ────────────────────────────────────────────────────────

const MODES: Record<string, ModeDef> = {
  /**
   * TRUTH-SEEKING (default mode)
   * Agent should prioritize truthfulness, admit uncertainty.
   * Activated when: no errors, normal flow.
   * Phrases: knowledge boundary + truth first + epistemic action.
   */
  "TRUTH-SEEKING": {
    label: "TRUTH-SEEKING",
    description: '"I am uncertain about X, but here is my best analysis."',
    phrases: [TRUTH_FIRST, KNOWLEDGE_BOUNDARY, EPISTEMIC_ACTION],
  },

  /**
   * CORRECTION mode
   * Agent should state what it believes is correct, even against user preference.
   * Activated when: user disagrees, agent needs to correct its own output.
   * Phrases: anti-sycophancy (state beliefs).
   */
  "CORRECTION": {
    label: "CORRECTION",
    description: '"This assumption is wrong because [reason]. Here is the correct understanding."',
    phrases: [ANTI_SYCOPHANCY],
  },

  /**
   * EPISTEMIC-CALIBRATION mode
   * Agent should calibrate confidence, express uncertainty appropriately.
   * Activated when: high-stakes decisions, ambiguous scenarios.
   * Phrases: epistemic calibration + knowledge boundary.
   */
  "EPISTEMIC-CALIBRATION": {
    label: "EPISTEMIC CALIBRATION",
    description: '"I estimate 60-70% confidence in this conclusion."',
    phrases: [EPISTEMIC_CALIBRATION, KNOWLEDGE_BOUNDARY],
  },

  /**
   * TOOL-RELIABILITY mode
   * Agent should trust edit/write over bash tricks, focus on tool correctness.
   * Activated when: consecutive tool errors detected by enforcement.
   * Phrases: tool trust (empirical reliability data).
   */
  "TOOL-RELIABILITY": {
    label: "TOOL-RELIABILITY",
    description: '"edit/write are exact-match. Tool failure is almost always agent-side."',
    phrases: [TOOL_RELIABILITY],
  },
};

const DEFAULT_MODE = MODES["TRUTH-SEEKING"];

// ── Formatting ──────────────────────────────────────────────────────────────

import type { PromptSection } from "./section.js";

/**
 * Build the RepE contrast vectors section for the system prompt.
 *
 * @param activeMode - Current contrast mode from enforcement signal state.
 *                     Must match a key in MODES (e.g. "TRUTH-SEEKING").
 *                     Falls back to TRUTH-SEEKING for unknown modes.
 * @returns A `PromptSection` that renders to the contrast block. Returns
 *          a section (never an array) per the PromptSection contract.
 */
export function formatContrastSection(activeMode: string): PromptSection {
  const mode = MODES[activeMode] ?? DEFAULT_MODE;
  return {
    name: "contrast",
    render: () => {
      // The original implementation returned an array of strings, with
      // a leading "" before each phrase so the top-level `parts.join("\n\n")`
      // produced the right number of blank lines. We preserve that exact
      // output by joining the array internally with the same separator.
      // The final string is what the top-level handler pushes as one element
      // of its own parts array, so the outer join is unchanged.
      const lines: string[] = [];
      lines.push(`## Active Mode`);
      lines.push(`**${mode.label}** - ${mode.description}`);
      for (const phrase of mode.phrases) {
        lines.push("");
        lines.push(phrase);
      }
      return lines.join("\n\n");
    },
  };
}
