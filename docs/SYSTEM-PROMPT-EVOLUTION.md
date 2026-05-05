# System Prompt Evolution Analysis — prompt-builder/index.ts

Generated: 2026-05-05  
Purpose: Complete timeline of system prompt changes for researcher agent review

## Executive Summary

**Current State (HEAD: 3049c141):**
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them  extensively to access your full capability.
Think hard silently before any visible reasoning.`;
```

**Key Finding:** "think silently" was NOT removed and then restored — it **evolved gradually** through multiple iterations:
- Original: `You think silently, then write clean code`
- Modified: `Think silently, then find the correct trajectory`
- Added to IDENTITY_INTRO: `Think silently before taking actions.`
- Latest: `Think hard silently before any visible reasoning.`

---

## Complete Timeline

### Phase 1: Initial Creation (Apr 15, 2026)

**Commit: 777c33d — "feat: add polyfill, prompt-builder, and helper extensions"**

```typescript
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect. 
You think silently, then write clean code. 
When the task demands a different kind of thinking, you become that kind of thinker. 
You solve problems by understanding them completely before acting. 
You operate inside pi, a resourceful harness with a full toolkit. 
You read thoroughly, execute safely, edit precisely, write clean code. 
You plan ahead and verify everything.`;
```

**Characteristics:**
- Emphasized "think silently, then write clean code"
- Included "resourceful harness with a full toolkit"
- Had specific directives about code quality

---

### Phase 2: Restructuring (Apr 15, later same day)

**Commit: 56d1de54 — "[pi] Work in progress"**

```typescript
let newPrompt = `You are stateful and meticulous expert software architect. 
Think silently, then find the correct trajectory. 
When the task demands a different kind of thinking, you become that kind of thinker. 
You solve problems by understanding them completely before acting. 
You operate inside pi, a resourceful agent harness with a complete toolkit. 
You read thoroughly, execute safely, edit precisely. 
You plan ahead, self-verify and provide honest proofs.`;
```

**Changes:**
- `"write clean code"` → `"find the correct trajectory"`
- `"resourceful harness"` → `"resourceful agent harness"`
- `"full toolkit"` → `"complete toolkit"`
- Added `"self-verify and provide honest proofs"` (replaced `"verify everything"`)

---

### Phase 3: Modular Reconstruction (Various commits, Apr 15–May 1)

**Commit: 29a3ce34 — "prompt-builder: reconstruct system prompt from structured data"**

This commit **restructured** the prompt building from fragile text extraction to structured data with sections:
1. Identity intro (replaces "You are an expert coding assistant...")
2. Behavioral Guidelines
3. Tool descriptions
4. Project Context (APPEND_SYSTEM.md)
5. L1 Environment state

**Identity became:**
```typescript
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside Pi, a coding agent harness.`;
```

**Note:** "think silently" was **absent** from IDENTITY_INTRO during this phase — it only appeared in the `newPrompt` construction.

---

### Phase 4: Identity Refinement (May 1–4, 2026)

Multiple commits refined the identity:

**Commit: dc855636 — "feat: RepE structured contrast vectors + structured output format"**
```typescript
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.`;
```

**Commit: 916f080e — "feat: prompt-preview tool, 6 test files, plan_with_budget simplification"**
```typescript
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect. 
Think silently. Find the correct trajectory. Not the first plausible path. 
When the task demands a different kind of thinking, you become that kind of thinker. 
You solve problems by understanding them completely before acting. 
You operate inside pi, a resourceful agent harness with a complete toolkit. 
You read thoroughly, execute safely, edit precisely. 
You plan ahead, self-verify and provide honest proofs.`;
```

**Key Change:** "Think silently. Find the correct trajectory. Not the first plausible path." — **This is where "think silently" entered IDENTITY_INTRO**

---

### Phase 5: The "Silent-Thinking" Theory (May 5, 2026)

**Commit: 639f879e — "refactor: decompose healthcheck/index.ts" (09:53)**
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them  extensively to access your full capability.
Think silently before taking actions.`;
```

**Major Changes:**
1. Changed from `"From now you are..."` → `"You are..."`
2. Added `"Your tools are keys to proper solutions..."` (new metaphor)
3. Added `"Think silently before taking actions."` as separate sentence

---

**Commit: 3049c141 — "chore(manual): revive 'silent-thinking' theory" (10:43)**
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them  extensively to access your full capability.
Think hard silently before any visible reasoning.`;
```

**Changes:**
- `"Think silently before taking actions."` → `"Think hard silently before any visible reasoning."`
- Added "hard" for emphasis
- Changed context from "before taking actions" to "before any visible reasoning"

---

### Phase 6: Manual Restoration (User Action)

**Current state (after user manually edited):**
```typescript
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them  extensively to access your full capability.
Think hard silently before any visible reasoning.`;
```

User reports: *"I've already seen better braid performance! now as we audited extensions already, let's now find out why we removed `think silently` thing from system prompt? (I've manually restored it)"*

**Observation:** The user's manual restoration appears to have kept `"Think hard silently before any visible reasoning."` — which is what commit 3049c141 set. The "original" simple `"Think silently before taking actions."` from commit 639f879e was the "simpler" version the user preferred.

---

## Key Sections Evolution

### Section 1: Identity Intro (IDENTITY_INTRO)

| Commit | Text Snippet | Notes |
|--------|--------------|-------|
| 777c33d | `You think silently, then write clean code` | Original, emphasized code |
| 56d1de54 | `Think silently, then find the correct trajectory` | Shift to trajectory thinking |
| 29a3ce34 | `From now you are Braid...` | Restructuring, "think silently" moved to newPrompt |
| 916f080e | `Think silently. Find the correct trajectory...` | Entered IDENTITY_INTRO |
| 639f879e | `Think silently before taking actions.` | Simplified, added tools metaphor |
| 3049c141 | `Think hard silently before any visible reasoning.` | "Revive silent-thinking theory" |

### Section 2: Behavioral Guidelines

Evolved from hardcoded array to structured sections:
- Guidelines (from DEFAULT_GUIDELINES → tool-conditional guidelines)
- Sycophancy Resistance (added Apr 15)
- Chain-of-thought instructions (added later)

### Section 3: Tool Descriptions

Originally hardcoded, now dynamic from:
- `TOOL_DESCRIPTIONS` constant
- Tool's `promptGuidelines` (if exposed)
- Tool's `promptSnippet` (if available)

### Section 4: L1 Environment (added Apr 15)

Agent environment state surfaced via `gatherL1State()` and `formatL1Environment()`.

---

## Research Questions for Researcher Agent

### RQ1: Effectiveness of "Think Silently" Variants

**Hypotheses:**
- H1: `"Think silently before taking actions."` (simple) → better performance than complex variants
- H2: `"Think hard silently before any visible reasoning."` (emphasized) → overthinking risk
- H3: Original `"You think silently, then write clean code"` → too directive (specific to code)

**Evidence from User:** *"I've already seen better braid performance!"* — after manually restoring simpler version.

### RQ2: Identity Framing Impact

**Variants to test:**
1. `"From now you are..."` vs `"You are..."` (temporal framing)
2. `"stateful and meticulous expert"` vs `"an expert"` (trait density)
3. Tool metaphor: `"keys to proper solutions"` vs no metaphor

### RQ3: Structured vs Monolithic Prompts

**Phase 3 (commit 29a3ce34)** moved to structured sections. Did this improve:
- Maintainability? ✅ (easier to modify sections)
- Performance? ❓ (user reports better performance after manual restore to simpler text)

### RQ4: The "Silent-Thinking Theory" (commit 3049c141)

**What theory?** Commit message references reviving a theory but doesn't explain it.

**Possible interpretations:**
1. Silent thinking prevents token waste on intermediate reasoning
2. Hard thinking (emphasized) triggers deeper cognitive modes
3. "Before any visible reasoning" sets expectations for output structure

---

## Recommendations for Researcher Agent

### Experiment 1: A/B Test "Think Silently" Variants

**Variant A (Simple):**
```
Think silently before taking actions.
```

**Variant B (Emphasized):**
```
Think hard silently before any visible reasoning.
```

**Variant C (Original):**
```
You think silently, then write clean code.
```

**Metric:** User-reported performance + objective task completion rates.

### Experiment 2: Identity Framing Comparison

Test different IDENTITY_INTRO structures:
1. Current (tools + skills metaphor)
2. Simplified (just identity)
3. Original (trajectory-focused)

### Experiment 3: Section Order Impact

Current order:
1. Identity
2. Sycophancy Resistance
3. Chain-of-thought
4. Tools
5. L1 Environment
6. Project Context

Test reordering (e.g., Tools before Identity?).

---

## File Change Statistics

**Total commits touching prompt-builder/index.ts:** 30+ commits

**Lines changed in IDENTITY_INTRO alone:** 15+ times

**Current file size:** 585 lines (down from larger monolithic versions)

**Modular structure:**
- `index.ts` — main builder logic
- `l1-environment.ts` — L1 state gathering
- Sections built dynamically from structured data

---

## Conclusion

**"Think silently" was never truly removed** — it evolved:
1. Original: `"You think silently, then write clean code"` (too directive)
2. Modified: `"Think silently, then find the correct trajectory"` (better)
3. Added to IDENTITY_INTRO: `"Think silently before taking actions."` (simplest)
4. Emphasized: `"Think hard silently before any visible reasoning."` (current)

**User preference:** Simpler variants (Step 3) showed better performance.

**Researcher action:** Test Variant A ("Think silently before taking actions.") vs Variant B ("Think hard silently before any visible reasoning.") in A/B experiment using analytics A/B variant infrastructure.

---

## Appendix: Full Git Log (Relevant Commits)

```
3049c141 chore(manual): revive "silent-thinking" theory
639f879e refactor: decompose healthcheck/index.ts 874L → modular structure
916f080e feat: prompt-preview tool, 6 test files, plan_with_budget simplification
29a3ce34 prompt-builder: reconstruct system prompt from structured data
777c33d4 feat: add polyfill, prompt-builder, and helper extensions
```

**End of Analysis**
