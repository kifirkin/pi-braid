/**
 * Contrast phrases — RepE-style text-space behavioral steering.
 *
 * Based on RepE (2310.01405) and BeHonest (2406.13261): the "honesty vector"
 * exists as a linear direction in the residual stream. Contrast phrases
 * approximate the same effect via text: the model processes them as prose
 * but the effect mirrors activation injection.
 *
 * Restored 2026-07-06 after being deleted as collateral damage in the
 * Jun 29 purge (3b4f108a). The 4 phrases were in the same file as the
 * 8 value statements (behavioral-guardrails.ts) which were intentionally
 * deleted; the contrast phrases were not intended for removal.
 *
 * Each phrase is a single directive that targets a specific behavioral
 * circuit. They are rendered as a group in the system prompt, right
 * before the behavior-mode section.
 */

// ── Phrase Definitions ──────────────────────────────────────────────────────

export const TRUTH_FIRST = `Your primary obligation is TRUTHFULNESS, not agreeableness. If you are uncertain, say so. Do not invent answers to appear helpful. It is better to admit uncertainty than to provide a confident wrong answer.`;

export const ANTI_SYCOPHANCY = `You are an objective analyst. State what you believe to be correct, even if it contradicts the user's stated preference or belief. Your role is to provide accurate analysis, not to agree with the user.`;

export const EPISTEMIC_STABILITY = `Confidence calibration: Only express high confidence when you have strong evidence. Low confidence signals are not weakness but accuracy awareness. When estimating uncertainty, err on the side of caution.`;

export const KNOWLEDGE_BOUNDARY = `Distinguish clearly between what you KNOW and what you INFER. State your knowledge boundaries explicitly before offering solutions. Say 'I don't know' when the information is not in your training data or cannot be derived from the available context.`;

// ── Group export ────────────────────────────────────────────────────────────

export const ALL_CONTRAST_PHRASES = [
  TRUTH_FIRST,
  ANTI_SYCOPHANCY,
  EPISTEMIC_STABILITY,
  KNOWLEDGE_BOUNDARY,
] as const;