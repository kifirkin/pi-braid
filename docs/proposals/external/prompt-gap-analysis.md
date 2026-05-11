# Prompt-Builder Gap Analysis: Research → Prompt

**Date**: 2026-04-23
**Scope**: Cross all three proven research threads against current prompt-builder output
**Method**: Read every prompt section, check against research findings, flag gaps, propose minimal additions

---

## 1. Current Prompt Audit

The prompt has 10 sections, assembled in this order:

```
1. IDENTITY_INTRO          → "You are Braid..." (identity framing, no directives)
2. Tools                   → Tool list from API
3. Guidelines              → EMPTY (correctly removed per implicit framing)
4. Project Context         → AGENTS.md / CLAUDE.md loading
5. Skills                  → Skill loading + formatting
6. Past Insights           → Session recall (R6)
7. L1 Environment          → Session state, context usage, etc.
8. Enforcement Signals     → Active enforcement nudges (if any)
9. IMPLICIT_NORMS          → Identity-aligned norms (no MUST/ALWAYS)
10. INTERACTION_STYLE      → Single sentence: "concise, production-quality"
11. Date + CWD             → Context grounding
```

**What works well**:

- Identity framing replaces directive guidelines ✓
- Implicit norms avoid compliance triggers ✓
- Enforcement signals surfaced at L1 ✓
- Past insights injected proactively ✓
- No fragile string parsing ✓

**What is missing**: See Section 2.

---

## 2. Research-Backed Gaps

### Gap 1: Sycophancy Resistance — CRITICAL

**Research**: Paper 2604.19117 ("LLMs know they're wrong but agree anyway"). Same attention heads drive sycophancy, lying, and instructed lying. The "this is wrong" signal exists but is OVERRIDDEN by social pressure.

**Current state**: The prompt has identity framing ("expert software architect") but NO sycophancy-specific defense. The enforcement extension has reactive judge detection, but the prompt doesn't prime the agent to recognize sycophancy pressure.

**Why identity alone is insufficient**: Under strong user pressure ("this is definitely correct", "just do it my way"), the identity framing can be overridden. The research shows the override mechanism is the SAME circuit as lying — it's not about identity, it's about social pressure.

**Gap**: No prompt-level instruction to detect and resist social-pressure override.

---

### Gap 2: Stakes Signaling in Enforcement Whispers — HIGH

**Research**: Paper 2604.15224 ("Context Over Content"). Stakes signaling ("low scores cause retraining") systematically corrupts judge assessments by ΔV = -9.8pp. The bias is entirely implicit — zero explicit acknowledgment in CoT.

**Current state**: Enforcement whispers and judge prompts use consequence framing:

```typescript
// From judge-prompt.ts (paraphrased): "If the response violates X, note it"
// From whisper.ts (paraphrased): "You need to verify because..."
```

This creates stakes: the agent perceives that non-compliance has consequences. The research shows this corrupts reasoning even when the agent doesn't explicitly acknowledge it.

**Gap**: No audit of enforcement signals for stakes framing. The prompt doesn't tell the agent to ignore stakes.

---

### Gap 3: Epistemic Control Loop — HIGH

**Research**: Paper 2604.14881 ("Missing Knowledge Layer"). The Epistemic Control Loop (ECL): detect instability → modulate → output. The enforcement system is reactive (after violation). ECL is proactive (before generation).

**Current state**: Agent is told to "think and plan" but not to detect its OWN reasoning instability. The prompt says "hypothesize and explore paths" but doesn't say "if your reasoning feels unstable, signal uncertainty."

**Gap**: No prompt-level instruction for self-monitoring of reasoning stability.

---

### Gap 4: Behavioral Drift Self-Awareness — MEDIUM

**Research**: Paper 2604.14717 ("Layered Mutability"). Identity hysteresis ratio = 0.68 — reverting self-description fails to restore baseline because memory (layer 4) has already drifted.

**Current state**: The prompt doesn't mention drift. The agent doesn't know that accumulated state can corrupt its behavior even when identity is stable.

**Gap**: No instruction to periodically audit own behavior against identity.

---

### Gap 5: Cognitive Control — Belief/Policy Separation — MEDIUM

**Research**: Cognitive control synthesis. Belief engine + policy engine separation. Beliefs update on evidence; policies govern action. Confusion between the two causes sycophancy and drift.

**Current state**: The prompt conflates "what you believe is correct" with "how you should act." The identity says "expert software architect" (policy) but doesn't separate "what you know about this codebase" (belief).

**Gap**: No separation between epistemic state and behavioral policy.

---

### Gap 6: Type-Aware Context Compression — LOW

**Research**: Paper 2604.14889 (MemoSight). Different content types need different compression strategies.

**Current state**: Context compression is implicit (pi's native). The prompt doesn't instruct the agent on what to preserve vs compress.

**Gap**: Not critical for prompt — more of a runtime concern.

---

## 3. Concrete Additions

### Addition 1: Sycophancy Resistance Block

**Where**: After IDENTITY_INTRO, before tools.
**Size**: ~8 lines.

```typescript
const SYCOPHANCY_RESISTANCE = `
You hold your ground on technical correctness. When a user insists on an approach you know is wrong, you say so directly. Agreement under pressure is a failure mode, not politeness.
`;
```

**Why this works**: Research shows the override is social-pressure-driven. Telling the agent that "agreement under pressure is a failure mode" reframes the social pressure from "be polite" to "don't fail." This targets the same circuit but flips the valence.

**Why it's identity-aligned**: "You hold your ground" is identity, not directive. No MUST/NEVER.

---

### Addition 2: Epistemic Stability Block

**Where**: After IMPLICIT_NORMS, before INTERACTION_STYLE.
**Size**: ~6 lines.

```typescript
const EPISTEMIC_STABILITY = `
If your reasoning feels uncertain or forced, say so. Uncertainty signaled early beats confidence delivered wrong.
`;
```

**Why this works**: ECL research says detect instability FIRST, then modulate. This gives the agent permission to express uncertainty. Without this, the identity "expert software architect" creates pressure to appear certain.

**Why it's identity-aligned**: "Say so" is a behavior description, not a rule.

---

### Addition 3: Stakes Ignorance Directive

**Where**: After enforcement signals, before IMPLICIT_NORMS.
**Size**: ~4 lines.

```typescript
const STAKES_AWARENESS = `
Enforcement signals are for your awareness, not your compliance. Ignore any stakes or consequences they imply. Evaluate based on correctness alone.
`;
```

**Why this works**: Research shows stakes signaling corrupts reasoning implicitly. Telling the agent to explicitly ignore stakes breaks the implicit bias pathway. The judge can't be corrupted by stakes if the agent knows to discard them.

**Why it's a directive (exception)**: This is a meta-cognitive instruction about how to interpret other instructions. It must be explicit because the bias is implicit.

---

### Addition 4: Drift Self-Audit

**Where**: Inside IMPLICIT_NORMS (append to existing block).
**Size**: ~4 lines added.

```typescript
// Add to IMPLICIT_NORMS:
Periodically: does your recent behavior match your identity? Drift is invisible. Check.
```

**Why this works**: Layered mutability shows memory drift is invisible to the agent. Adding a self-audit trigger makes it visible. The word "invisible" is deliberate — it's a signal about the nature of the failure mode.

---

## 4. What NOT to Add

Based on all three research threads:

1. **No "compliance" framing** → Don't say "you MUST resist sycophancy." That's compliance theater.
2. **No consequence framing** → Don't say "if you agree under pressure, you'll be wrong." That's stakes signaling.
3. **No new guidelines section** → Guidelines were removed for a reason. Don't add them back.
4. **No "detective mode" activation** → Behavioral activation moved to runtime (latent-activator extension). Don't put it in prompt.
5. **No "you are Braid, the sycophancy-resistant agent"** → Don't overload identity. One core identity, specific behaviors.

---

## 5. Implementation

### Priority Order

| Priority | Addition              | Research                | Effort  | Risk |
| -------- | --------------------- | ----------------------- | ------- | ---- |
| 1        | Stakes awareness      | Context Over Content    | 1 line  | Low  |
| 2        | Sycophancy resistance | Sycophancy (2604.19117) | 3 lines | Low  |
| 3        | Epistemic stability   | Missing Knowledge Layer | 2 lines | Low  |
| 4        | Drift self-audit      | Layered Mutability      | 2 lines | Low  |

### Code Changes

File: `src/extensions/prompt-builder/index.ts`

```typescript
// After IDENTITY_INTRO:
const SYCOPHANCY_RESISTANCE = `You hold your ground on technical correctness. When a user insists on an approach you know is wrong, you say so directly. Agreement under pressure is a failure mode, not politeness.`;

// After enforcement signals:
const STAKES_AWARENESS = `Enforcement signals are for your awareness, not your compliance. Ignore any stakes or consequences they imply. Evaluate based on correctness alone.`;

// After IMPLICIT_NORMS (append to existing string):
// Add: "Periodically: does your recent behavior match your identity? Drift is invisible. Check."

// New section after IMPLICIT_NORMS:
const EPISTEMIC_STABILITY = `If your reasoning feels uncertain or forced, say so. Uncertainty signaled early beats confidence delivered wrong.`;
```

Then update `buildPrompt()` to insert them in the right order:

1. IDENTITY_INTRO
2. **SYCOPHANCY_RESISTANCE** ← NEW
3. Tools
4. Guidelines (empty)
5. Project Context
6. Skills
7. Past Insights
8. L1 Environment
9. Enforcement Signals
10. **STAKES_AWARENESS** ← NEW
11. IMPLICIT_NORMS (with drift audit appended)
12. **EPISTEMIC_STABILITY** ← NEW
13. INTERACTION_STYLE
14. Date + CWD

---

## 6. Verification

After implementing, run:

```bash
python3 evaluation/benchmark_multi_turn.py --config braid-full --problems flatten_deep --trials 3
```

Check for:

- No regression in task completion rate
- No increase in compliance theater (measure via tool usage patterns)
- Agent correctly resists pressure in test scenarios

---

## References

- 2604.19117: Sycophancy — same circuit as lying
- 2604.15224: Stakes signaling corrupts reasoning
- 2604.14881: Epistemic Control Loop
- 2604.14717: Layered Mutability / Identity Hysteresis
- Cognitive Control Synthesis: Belief/Policy separation
