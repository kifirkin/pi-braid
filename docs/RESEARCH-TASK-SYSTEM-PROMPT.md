# Researcher Agent Task: System Prompt "Think Silently" Analysis

## Task

Analyze the evolution of `think silently` phrasing in `src/extensions/prompt/prompt-builder/index.ts` and propose optimal system prompt configuration.

## Current State (Manual Restoration)

```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think hard silently before any visible reasoning.`;
```

**User reports:** *"I've already seen better braid performance!"* with the simpler version.

---

## Git History: "Think Silently" Phrasing Changes

### 1. Original (Apr 15, 2026 — 777c33d)
```typescript
let newPrompt = `You are stateful and meticulous expert software architect. 
You think silently, then write clean code. 
When the task demands a different kind of thinking, you become that kind of thinker...`;
```
- Had "You think silently, then write clean code"
- Specific to code-writing context

### 2. First Modification (Apr 15, 2026 — 56d1de54)
```typescript
let newPrompt = `You are stateful and meticulous expert software architect. 
Think silently, then find the correct trajectory. 
When the task demands a different kind of thinking, you become that kind of thinker...`;
```
- Changed to "find the correct trajectory" (more general)
- Removed "You" (uppercase "Think")

### 3. Entered IDENTITY_INTRO (May 1, 2026 — 916f080e)
```typescript
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect. 
Think silently. Find the correct trajectory. Not the first plausible path. 
When the task demands a different kind of thinking, you become that kind of thinker...`;
```
- Added to IDENTITY_INTRO constant
- Added "Not the first plausible path" (anti-pattern guidance)

### 4. Added Tools Metaphor (May 5, 09:53 — 639f879e)
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think silently before taking actions.`;
```
- Added tools/skills metaphor
- Changed to "Think silently before taking actions." (simplest form)

### 5. "Revive Silent-Thinking Theory" (May 5, 10:43 — 3049c141)
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think hard silently before any visible reasoning.`;
```
- Commit message: `chore(manual): revive "silent-thinking" theory`
- Changed: "Think silently before taking actions." → "Think hard silently before any visible reasoning."
- Added "hard" (emphasis) + "before any visible reasoning" (context)

### 6. Current (Manual User Restoration)
```typescript
Think hard silently before any visible reasoning.;
```
- User kept the "revived" version but reports better performance with simpler variants

---

## Key Research Questions

### RQ1: Which "Think Silently" Variant Performs Best?

| Variant | Text | Characteristics |
|--------|------|---------------|
| V1 (Original) | `You think silently, then write clean code` | Too directive (code-specific) |
| V2 (Trajectory) | `Think silently, then find the correct trajectory` | General, action-oriented |
| V3 (Simple) | `Think silently before taking actions.` | Simplest, clear trigger |
| V4 (Emphasized) | `Think hard silently before any visible reasoning.` | Heavy emphasis, specific timing |

**User observation:** Simpler variants (V2/V3) showed better performance.

### RQ2: What is the "Silent-Thinking Theory"?

Commit 3049c141 mentions "revive 'silent-thinking' theory" but doesn't explain it.

**Hypotheses:**
- H1: Silent thinking prevents token waste on intermediate reasoning
- H2: "Hard" emphasis triggers deeper cognitive modes
- H3: "Before any visible reasoning" sets output structure expectations
- H4: Contrast with "visible reasoning" (tool calls, code output)

### RQ3: Does Adding "Hard" Help or Hurt?

**Argument FOR:** Emphasis triggers stronger model compliance
**Argument AGAINST:** "Hard" might trigger overthinking, longer responses

**Evidence:** User prefers simpler (no "hard") version.

### RQ4: Timing Specification Impact

| Timing Phrase | Implication |
|----------------|-------------|
| "before taking actions" | Before tool calls/code edits |
| "before any visible reasoning" | Before ANY output (including text) |
| "then find the correct trajectory" | After thinking, before acting |

---

## Experiment Proposal

### Experiment 1: A/B Test "Think Silently" Variants

**Use existing analytics A/B infrastructure (R9):**
- Variant A: `Think silently before taking actions.` (simple)
- Variant B: `Think hard silently before any visible reasoning.` (emphasized)

**Metrics:**
1. Task completion rate
2. Token efficiency (reasoning vs output ratio)
3. User-reported satisfaction (from session feedback)
4. Tool success rate

**Duration:** Run for 20 sessions per variant

### Experiment 2: Identity Framing Impact

Test full IDENTITY_INTRO variants:

**Variant X (Current):**
```
You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think hard silently before any visible reasoning.
```

**Variant Y (Simplified — User Preferred):**
```
You are a stateful and meticulous expert software architect.
Think silently, then find the correct trajectory.
When the task demands a different kind of thinking, you become that kind of thinker...
```

**Hypothesis:** Simpler identity + trajectory focus performs better.

### Experiment 3: Tools Metaphor Value

**Test:** Does the "keys to proper solutions" metaphor help or distract?

**Variant A:** With metaphor (current)
**Variant B:** Without metaphor (direct identity)

---

## Proposal for Optimal System Prompt

Based on user feedback + git history analysis:

```typescript
const IDENTITY_INTRO = `You are a stateful and meticulous expert software architect.
Think silently, then find the correct trajectory. Not the first plausible path.
When the task demands a different kind of thinking, you become that kind of thinker.
You solve problems by understanding them completely before acting.
You operate inside pi, a resourceful agent harness with a complete toolkit.
You read thoroughly, execute safely, edit precisely.
You plan ahead, self-verify and provide honest proofs.`;
```

**Rationale:**
1. "Think silently" preserved (core instruction)
2. "find the correct trajectory. Not the first plausible path." (anti-pattern guidance)
3. No "hard" emphasis (user preference)
4. No "before any visible reasoning" (unnecessary constraint)
5. Complete toolkit description (sets expectations)

---

## Deliverables Expected from Researcher

1. **Analysis Report:** Which variant performs best + why
2. **Proposed IDENTITY_INTRO:** Optimal text based on evidence
3. **Experiment Results:** A/B test data (if available) or proposed experiment design
4. **Recommendation:** Keep current OR adopt user's preferred simpler version

---

## Appendix: How to Run Experiments

### Using Analytics A/B Infrastructure (R9)

```typescript
// In enforcement or context-lifecycle:
const variant = getAnalyticsState(ctx).abVariant; // "control" | "variant-a" | "variant-b"

if (variant === "variant-a") {
  IDENTITY_INTRO = `...variant A text...`;
} else if (variant === "variant-b") {
  IDENTITY_INTRO = `...variant B text...`;
}
```

### Metrics to Track

```typescript
// From degradation-detector:
- errorRate
- toolSuccessRate
- avgTurnDurationMs

// From user feedback:
- "I've already seen better braid performance!" (qualitative)
- Task completion success
```

---

**End of Task Description**
