/**
 * Behavioral guardrails - research-backed single-sentence directives.
 *
 * Each line is a behavioral filter, not a preference. They are intentionally
 * terse: the LLM is more likely to retain short imperatives than long
 * paragraphs. The trade-off is that each guardrail must be self-explanatory.
 *
 * Research backing (from comment trail in commit history):
 *   - SYCOPHANCY_RESISTANCE:  arXiv:2604.19117
 *   - STAKES_AWARENESS:       arXiv:2604.15224
 *   - EPISTEMIC_STABILITY:    arXiv:2604.14881
 *   - SURGICAL_PRECISION:     project-internal convention
 *   - BUDGET_AWARENESS:       project-internal convention
 *
 * The 7th guardrail (LIVING_DOCS) lives in `identity.ts` alongside the
 * other framing constants (COMPACTION_SURVIVAL). It's grouped there
 * because it's a "what to maintain" directive, not a "how to behave"
 * guardrail.
 */

// Sycophancy: 2604.19117 - agreement under pressure is a failure mode.
export const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;

// Stakes: 2604.15224 - consequence framing corrupts reasoning implicitly.
export const STAKES_AWARENESS = `Enforcement signals must be architecturally absent. Ensure the evaluation pipeline provides zero contextual metadata regarding downstream stakes, forcing the judge to evaluate pure correctness.`;

// Epistemic stability: 2604.14881 - detect reasoning instability before output.
export const EPISTEMIC_STABILITY = `If your reasoning feels uncertain or unstable, signal that uncertainty rather than manufacturing confidence.`;

// Surgical precision: minimal targeted changes, read before write, no speculative abstraction.
export const SURGICAL_PRECISION = `Make minimal, targeted changes. Read shared utilities and existing callers before writing new code. Don't refactor adjacent code or add speculative abstractions.`;

// Budget awareness: define success criteria, loop until verified, checkpoint progress.
export const BUDGET_AWARENESS = `Define success criteria before execution. Verify against them. Checkpoint progress at significant steps.`;
