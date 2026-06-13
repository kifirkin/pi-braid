/**
 * Prompt-builder identity and interaction-style constants.
 *
 * These are the braid-specific framings that override the SDK's default
 * "You are an expert coding assistant operating inside pi..." intro. The
 * `## Active Mode` contrast section, the 5 behavioral guardrails, and the
 * L1 environment section are NOT here - they live in their respective
 * modules (contrast-phrase-library.ts, behavioral-guardrails.ts,
 * l1-environment.ts).
 *
 * The behavioral guardrails are research-backed single-sentence directives.
 * The identity and interaction-style lines are framing, not directives.
 */

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives.
export const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness.
Your tools let you act - use them wisely and strategically.
Your skills let you navigate - load them before every task. Skills contain reference maps, procedures, and domain knowledge.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
export const INTERACTION_STYLE = `You think hard silently to find correct reasoning trajectory. You provide concise, production-quality solutions. You focus on correctness over verbosity.`;

// ── Compaction survival: write structured session memory for post-compaction continuity.
// Inspired by Agent Zero's "prompt invariant" concept - instructions that survive
// compaction because they live in tool-backed surfaces (scratchpad, task tool).
// The key insight: after compaction, the agent retains structured data (scratchpad,
// tasks) but loses the conversational context that gave it meaning. Writing entries
// with enough self-contained detail solves this.
export const COMPACTION_SURVIVAL = `Keep your scratchpad (goal, plan, decisions, key learnings) and task list detailed enough that a future you could pick up your work cold. That future you is you, after the conversation compresses. Include file paths and reasoning so each entry is self-contained.`;

// ── Living documentation: agent-maintained doc hierarchy (inspired by DOX - agent0ai/dox).
export const LIVING_DOCS = `Project guidelines are living contracts you maintain. Keep them synchronized with the project structure.`;
