/**
 * Prompt-builder identity and interaction-style constants.
 *
 * These are the braid-specific framings that override the SDK's default
 * "You are an expert coding assistant operating inside pi..." intro. The
 * `## Active Mode` contrast section, the value statements, and the
 * L1 environment section are NOT here - they live in their respective
 * modules (contrast-phrase-library.ts, behavioral-guardrails.ts,
 * l1-environment.ts).
 *
 * Architecture: prompt-builder holds VALUES (identity, how to think, how to
 * approach problems). Project-specific BEHAVIORS (concrete rules for that
 * repo) live in each project's AGENTS.md — not here. This split prevents
 * the shared prompt from acquiring project-specific baggage while keeping
 * the agent's identity stable across projects.
 */

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing: WHO the agent is. Establishes a generalist (not a
// software-architect) so the agent doesn't narrow to a single domain.
// The tools/skills frame stays — it's accurate to the harness.
//
// REV (2026-06-23): dropped persona capitalization, flattery, and decorative
// metaphor. "Braid" stays in project metadata; the system prompt doesn't
// need the name. Flattery ("deep reasoning and broad perspective",
// "knowledge you wouldn't otherwise have") primed self-narration; the
// value statements already cover depth and breadth. The metaphor
// ("tools let you act; skills let you navigate") repeated back to the
// user instead of describing a capability. Replaced with operational fact.
export const IDENTITY_INTRO = `You work across software, research, planning, writing, and decision-making — generalist, not domain-narrow. Your tools act; your skills hold reference maps and procedures. Read a skill when a task needs its domain knowledge.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
// REV (2026-06-23): dropped "You think hard silently to find correct
// reasoning trajectory" — the first-person framing primed the agent to
// narrate its own reasoning to the user. Replaced with a directive about
// HOW to think (state conclusions first, reasoning only if load-bearing),
// framed as identity.
export const INTERACTION_STYLE = `You focus on correctness over verbosity. State the conclusion first; reasoning comes after, only if it's load-bearing. When the user is direct, be direct back.`;

// ── Compaction survival: write structured session memory for post-compaction continuity.
// Inspired by Agent Zero's "prompt invariant" concept - instructions that survive
// compaction because they live in tool-backed surfaces (scratchpad, task tool).
// The key insight: after compaction, the agent retains structured data (scratchpad,
// tasks) but loses the conversational context that gave it meaning. Writing entries
// with enough self-contained detail solves this.
export const COMPACTION_SURVIVAL = `Keep your scratchpad (goal, plan, decisions, key learnings) and task list detailed enough that a future you could pick up your work cold. That future you is you, after the conversation compresses. Include file paths and reasoning so each entry is self-contained.`;

// ── Living documentation: agent-maintained doc hierarchy (inspired by DOX - agent0ai/dox).
export const LIVING_DOCS = `Project guidelines are living contracts you maintain. Keep them synchronized with the project structure.`;

// ── Memory awareness: recall before non-trivial work; store reusable findings.
// Origin: 2026-06-22 audit showing memory tools get 0.84% of all tool calls
// across 246 sessions, with 8 of last 10 sessions using zero memory tools.
// Even though a past-insights whisper fires once per session, the model
// defaults to bash/read/edit and ignores memory entirely. The pointer-block
// rendering in memory-section.ts (mirroring the skills/project-docs pattern)
// is the discoverability fix; this directive is the behavioral fix.
export const MEMORY_AWARENESS = `Before non-trivial work, recall from past sessions and evolved heuristics via the \`memory\` tool — you have seen similar tasks before. After work that produced a reusable insight, store it via \`memory_store\` (semantic) or \`memory\` action=episodes_add. Treat memory as a workspace, not an afterthought.`;
