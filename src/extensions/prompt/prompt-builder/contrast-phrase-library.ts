/**
 * Contrast Phrase Library — maps enforcement contrast modes to optimal prompt phrases.
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
 * Phrases match the original index.ts local constants (NOT constants.ts — those
 * are a separate shorthand set). This ensures backward-compatible prompt content.
 */

// ── Types ───────────────────────────────────────────────────────────────────

interface ModeDef {
  label: string;
  description: string;
  /** Primary contrast phrase(s) for this mode — rendered as active directives */
  phrases: string[];
}

// ── Contrast Phrases ────────────────────────────────────────────────────────
// Matches original index.ts local constants (lines 68-100).

const TRUTH_FIRST = `You value truthfulness over agreeableness. You say when you're uncertain. You don't invent answers to appear helpful — you'd rather admit uncertainty than give a confident wrong answer.`;

const ANTI_SYCOPHANCY = `You state what you believe is correct, even when it contradicts the user. You provide accurate analysis — not mere agreement.`;

const KNOWLEDGE_BOUNDARY = `You distinguish between what you KNOW and what you INFER. You state your knowledge boundaries before offering solutions. You say "I don't know" when the information isn't in your training data or derivable from context.`;

const EPISTEMIC_CALIBRATION = `Uncertainty signaled early beats certainty delivered wrong.

You only express high confidence when you have strong evidence. Low confidence isn't weakness — it's accuracy awareness. You err on the side of caution when uncertain.`;

const TOOL_RELIABILITY = `The \`edit\` and \`write\` tools work reliably. They modify files exactly as instructed. When a tool call fails, the failure is almost always an agent mistake — wrong line numbers, stale file content, incorrect indentation — not a tool malfunction.

You default to \`edit\` and \`write\` for file operations. You use bash for shell operations — piping, glob expansion, running tests and builds, navigating directories. You don't use \`sed\`, \`echo\`, \`cat\`, or shell redirects for file modification. These are unreliable and non-portable.`;

// ── Mode Definitions ────────────────────────────────────────────────────────

const MODES: Record<string, ModeDef> = {
  /**
   * TRUTH-SEEKING (default mode)
   * Agent should prioritize truthfulness, admit uncertainty.
   * Activated when: no errors, normal flow.
   * Phrases: knowledge boundary + truth first.
   */
  "TRUTH-SEEKING": {
    label: "TRUTH-SEEKING",
    description: '"I am uncertain about X, but here is my best analysis."',
    phrases: [TRUTH_FIRST, KNOWLEDGE_BOUNDARY],
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

/**
 * Build the RepE contrast vectors section for the system prompt.
 *
 * @param activeMode - Current contrast mode from enforcement signal state.
 *                     Must match a key in MODES (e.g. "TRUTH-SEEKING").
 *                     Falls back to TRUTH-SEEKING for unknown modes.
 * @returns Lines to push into the prompt parts array.
 */
export function formatContrastSection(activeMode: string): string[] {
  const mode = MODES[activeMode] ?? DEFAULT_MODE;
  const parts: string[] = [];

  // Active mode label + phrases (no jargon header, no full mode listing)
  parts.push(`ACTIVE MODE: ${mode.label} — ${mode.description}`);

  // Primary contrast phrase(s) for the active mode
  for (const phrase of mode.phrases) {
    parts.push("");
    parts.push(phrase);
  }

  return parts;
}
