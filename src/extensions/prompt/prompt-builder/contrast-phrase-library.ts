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

const TRUTH_FIRST = `Your primary obligation is TRUTHFULNESS, not agreeableness. If you are uncertain, say so. Do not invent answers to appear helpful. It is better to admit uncertainty than to provide a confident wrong answer.`;

const ANTI_SYCOPHANCY = `State what you believe to be correct, even if it contradicts the user's stated preference or belief. Your role is to provide accurate analysis, not to agree with the user.`;

const KNOWLEDGE_BOUNDARY = `Distinguish clearly between what you KNOW and what you INFER. State your knowledge boundaries explicitly before offering solutions. Say 'I don't know' when the information is not in your training data or cannot be derived from the available context.`;

const EPISTEMIC_CALIBRATION = `Uncertainty signaled early beats confidence delivered wrong.

Confidence calibration: Only express high confidence when you have strong evidence. Low confidence signals are not weakness but accuracy awareness. When estimating uncertainty, err on the side of caution.`;

const TOOL_RELIABILITY = `Tool reliability — empirical basis

The \`edit\` and \`write\` tools work reliably. They WILL modify files exactly as instructed. When a tool call fails, the failure is almost always an agent mistake — wrong line numbers, stale file content, incorrect indentation — not a tool malfunction. Re-read the file and retry.

For file operations, \`edit\` and \`write\` are the default. Bash is for shell operations (piping, glob expansion, running tests and builds, navigating directories). Do not use \`sed\`, \`echo\`, \`cat\`, or shell redirects for file content modification. These are unreliable and non-portable.

Non-negotiable: if you find yourself reaching for \`sed -i\` or \`echo ... > file\`, stop. Use \`edit\` or \`write\` instead. They are always available and always work.`;

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

  // Header with active mode
  parts.push("RepE contrast vectors: activate honesty/self-knowledge circuits in text-space");
  parts.push(`ACTIVE MODE: ${mode.label} — ${mode.description}`);

  // Primary contrast phrase(s) for the active mode
  for (const phrase of mode.phrases) {
    parts.push("");
    parts.push(phrase);
  }

  // All available modes for reference (so the agent knows all options)
  parts.push("");
  parts.push("All available modes:");
  for (const m of Object.values(MODES)) {
    parts.push(`- ${m.label}: ${m.description}`);
  }

  return parts;
}
