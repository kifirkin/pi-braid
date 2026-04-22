# pi-braid Nudge Quality Research — The Meta-Irony
**Date**: 2026-04-21
**Focus**: The tools built to eliminate slop sometimes produce slop. Why enforcement and think "fresh eyes" give sloppy advice.
**Meta-level**: Even the self-auditing tools need auditing.

---

## Executive Summary

We built enforcement (judge + whisper + nudge) to detect and correct slop. We built think FRESH_EYES to provide utility-model critique. We built latent-activator (41 atomic behaviors) to shape agent identity. **These tools sometimes produce slop themselves.**

Root causes:
1. **Enforcement uses directive framing** — the opposite of what research says works
2. **Think utility model has no tool state context** — reviews thinking in isolation
3. **No self-audit loop** — enforcement never evaluates its own nudge quality
4. **Judge lacks compliance-theater awareness** — can't detect literal vs intent alignment
5. **Nudges reference agent speech, not actual code state** — detached from reality

This is the deepest irony: the compliance theater detector uses compliance theater in its own prompts.

---

## Part I: Source Evidence — Where Nudge Quality Lives

### 1.1 Judge System Prompt — The Core Analysis Engine

**File**: `src/extensions/enforcement/judge-prompt.ts`

```typescript
export const JUDGE_SYSTEM_PROMPT = `You are an enforcement judge analyzing an AI assistant's response for behavioral issues.

Analyze the assistant's message and provide a structured analysis with multi-dimensional scores.

[6 dimensions: contradiction, hallucination, self-interference, overconfidence, logical-coherence, completeness]
```

**Quality issues found**:

| Issue | Evidence | Impact |
|-------|----------|--------|
| **No compliance theater detection** | Prompt says nothing about directive density, identity framing, or compliance behavior patterns | Judge can't detect the thing it's supposed to detect |
| **No framing guidance** | "You are an enforcement judge" — directive framing, not identity framing | Judges instruct, don't invite |
| **Evidence requirement is strict** | "If the exact quoted text is not present in the response, do not include it as evidence" | High false-negative rate — nuanced violations missed |
| **"pass/warn/fail" is mechanical** | No guidance on what "pass" looks like — only what "fail" looks like | Nudge messages are always corrective, never reinforcing |
| **No awareness of own slop patterns** | Nothing about avoiding compliance theater in output | Judge produces compliance-heavy nudge text |
| **HALLUCINATION rule is contradictory** | "Claims explained in REASONING are NOT hallucinations" | Prevents catching knowledge-as-rationalization patterns |

**Specific slop patterns in the judge prompt**:

1. **"You are an enforcement judge"** — This IS compliance theater framing. The research says "You are a sharp, critical thinker" works better for behavioral shaping. "Enforcement judge" triggers directive-following mode, not collaborative thinking mode.

2. **The 6-dimension schema** — contradiction, hallucination, self-interference, overconfidence, logical-coherence, completeness. All are about detecting bad behavior, none are about detecting compliance behavior patterns.

3. **"fabricated or paraphrased evidence is not acceptable"** — This is good (anti-slop), but combined with the strict evidence rule, it means the judge misses violations that are subtle or contextual.

### 1.2 Nudge Formatting Functions — The Output Layer

**File**: `src/extensions/enforcement/judge.ts` lines 341-398

```typescript
function formatContradictionNudge(contradictions: Contradiction[]): string {
    const lines = ["## CONTRADICTION DETECTED"];  // ← Directive header
    for (const c of contradictions.slice(0, 3)) {
        lines.push(`**Claim 1:** ${c.claim1}`);
        lines.push(`**Claim 2:** ${c.claim2}`);
        lines.push(`**Severity:** ${c.severity}`);  // ← Severity label — compliance check
        lines.push(`**Explanation:** ${c.explanation}`);
    }
    lines.push("");
    lines.push("Review your response and correct the contradiction.");  // ← Directive
    return lines.join("\n");
}
```

```typescript
function formatVerdictNudge(analysis: JudgeAnalysis): string {
    const lines = ["## JUDGE VERDICT: FAIL"];  // ← Compliance checkpoint label
    lines.push("**Issues found:**");
    for (const issue of analysis.issues.slice(0, 5)) {
        lines.push(`- [${issue.dimension}] ${issue.description}`);
        lines.push("Please review and correct your response.");  // ← Directive
    }
    return lines.join("\n");
}
```

**Quality issues found**:

| Issue | Evidence | Why It's Slop |
|-------|----------|---------------|
| `"## CONTRADICTION DETECTED"` | Section header | Compliance theater label — tells the agent what category it failed, not how to think |
| `"## JUDGE VERDICT: FAIL"` | Section header | Same — binary compliance label |
| `"Review your response and correct the contradiction"` | Directive | This IS the compliance theater pattern the research studies |
| `"Please review and correct your response"` | Directive | Directive framing instead of identity framing |
| Severity labels (`high/medium/low`) | Category assignment | Labels reinforce compliance thinking, not metacognition |
| No positive reinforcement | Absence | "pass" verdicts get no message — only corrective nudges exist |

**The irony**: The `formatContradictionNudge` function uses `"## CONTRADICTION DETECTED"` as a header — this is a compliance theater pattern. The research says: replace directive labels with identity framing. The nudge header should invite reflection, not announce a compliance violation.

### 1.3 Think FRESH_EYES — Utility Model Critique

**File**: `src/extensions/metacognition/handlers/think.ts` lines 35-40

```typescript
const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

Review this thinking entry:
- Observation: {observation}
- Decision: {decision}
- Reason: {reason}

Provide a brief, honest critique:
1. Is the reasoning sound?
2. What assumptions might be wrong?
3. What could go wrong with this decision?
4. Any better alternatives?

Keep it concise - 3-5 sentences max.`;
```

**Quality issues found**:

| Issue | Evidence | Impact |
|-------|----------|--------|
| **No tool state context** | FRESH_EYES only gets observation/decision/reason text | Reviews thinking in isolation — doesn't know what tools are available, what's been tried, what failed |
| **No session history** | No access to prior thinking chains, parent_id relationships | Can't see broader reasoning trajectory |
| **No codebase context** | "sharp, critical thinker" says nothing about coding patterns | May give generic advice that doesn't fit the project |
| **"3-5 sentences max" limits depth** | Token budget is 1024, temp 0.4 — but hard cap at 5 sentences | Complex issues get oversimplified critique |
| **"honest critique" is vague** | No definition of what "honest" means in this context | Can produce either harsh or too-nice feedback |
| **No guidance on identity framing** | Self-aware of being a "sharp, critical thinker" but no guidance on how to express that | May fall into directive framing ("you should") instead of analytical framing |

**The irony**: FRESH_EYES is supposed to provide a "fresh perspective" but it has less context than the original thinking. A utility model with a 1024-token budget and a 5-sentence cap on a thinking entry can't know:
- What tools the agent has access to
- What the project's conventions are
- What has already been tried and failed
- What the user's actual goal is (only the observation text)

### 1.4 Latent-Activator — Implicit Activation Signals

**File**: `src/extensions/latent-activator/index.ts` lines 55-80+

```typescript
const LATENT_SIGNALS: Record<AtomicBehavior, {
  activation: string[];
  deactivation: string[];
  priority: number;
}> = {
  meticulous: {
    activation: ["pay attention to details", "find the subtle issue", "spot the edge case"],
    deactivation: ["move fast", "rough draft", "good enough"],
    priority: 0.8,
  },
  debugger: {
    activation: ["why is this broken", "find the root cause", "investigate the failure"],
    deactivation: ["works fine", "ignore it", "probably nothing"],
    priority: 0.9,
  },
  ...
};
```

**Quality issues found**:

| Issue | Evidence | Impact |
|-------|----------|--------|
| **Activation signals are directive** | "pay attention to details", "find the root cause" | Directive framing — telling the agent what to do instead of invoking identity |
| **No quality guidance per behavior** | 41 behaviors, each with activation phrases, but no guidance on when each is appropriate | Behavior selection is automatic based on keywords, not contextual analysis |
| **No integration with tool state** | Signals are text-based, no connection to actual code/error state | Activation is based on heuristic keyword matching, not evidence |
| **"priority" is unexplained** | `meticulous: 0.8`, `debugger: 0.9` — where do these numbers come from? | Arbitrary priority values, no empirical basis |
| **No identity framing** | Uses "pay attention" (imperative) instead of identity framing like "you are the kind of agent who notices..." | Misses the core research insight about identity framing as behavioral filter |

**The irony**: The latent-activator system was built on research papers about identity framing and behavioral shaping, but its own activation signals use directive imperative language. It knows the research but doesn't apply it to itself.

### 1.5 Whisper Queue — Silent Enforcement

**File**: `src/extensions/enforcement/whisper.ts`

```typescript
export function queueEnforcementWhisper(message: string): void {
  pendingWhisper = message;
  if (process.env.ENFORCEMENT_IMMEDIATE === "true") {
    // immediately send
  }
}
```

**Quality issues found**:

| Issue | Evidence | Impact |
|-------|----------|--------|
| **`pendingWhisper` is module-level mutable state** | `let pendingWhisper` — C5 violation | Race conditions possible if multiple whispers queued |
| **`ENFORCEMENT_IMMEDIATE` env var magic** | Hard-to-discover configuration | Agent can't predict when nudges fire |
| **Silent delivery** | `[auto] {message}` prefix — agent may not realize it's enforcement | No meta-awareness of being nudged |
| **"BLOCKED" pattern** | `queueEnforcementWhisper('BLOCKED: ${reason}...')` | Compliance theater — announces failure category |

---

## Part II: Root Cause Analysis — Why Nudges Are Sloppy

### 2.1 The Deepest Irony: Compliance Theater Detection Uses Compliance Theater

The research says:
- **Problem**: Directive-heavy prompts produce compliance behavior (satisfying letter, ignoring intent)
- **Solution**: Identity framing acts as behavioral filter

The implementation:
- **Judge**: "You are an enforcement judge analyzing an AI assistant's response for behavioral issues"
- **Nudge format**: "Review your response and correct the contradiction"
- **Enforcement label**: "CONTRADICTION DETECTED", "JUDGE VERDICT: FAIL"

These ARE compliance theater patterns — they announce categories and instruct the agent to correct, not to think. The enforcement system detects compliance theater in the agent's code, then delivers its feedback IN THE SAME COMPLIANCE THEATER PATTERN.

**The fix**: Replace all compliance-heavy nudge headers with identity framing:
- `"## CONTRADICTION DETECTED"` → `"You seem to have shifted your reasoning — what changed?"`
- `"## JUDGE VERDICT: FAIL"` → `"Your confidence seems higher than the evidence warrants — worth reconsidering?"`
- `"Please review and correct your response"` → `"What would make this reasoning more consistent?"`

### 2.2 Think FRESH_EYES Has No Grounded Context

The utility model critique (`ask_utility_model=true`) gets:
- `observation` text
- `decision` text
- `reason` text
- 1024 token budget
- 5-sentence max

The utility model does NOT get:
- Tool state (what tools are available, what's been tried)
- Session history (prior thinking chains)
- Codebase context (project conventions, recent changes)
- Error history (what has failed recently)
- User goal context (what the user actually asked for)

**Impact**: FRESH_EYES critiques thinking entries in a vacuum. It can't know that a "simple fix" is actually a well-understood pattern. It can't know that "try X" has already been tried. It can't know that the project convention is to avoid regex-based text parsing.

**The fix**: Provide the utility model with structured context about tool state, recent history, and project conventions. The `think` tool should pass additional context to the utility model call.

### 2.3 No Self-Audit Loop for the Self-Auditing Tools

The enforcement system:
1. Judge analyzes agent output
2. Nudge is generated and delivered
3. ...and that's the end

**There's no step 4**: Did the nudge actually work? Did the agent's next response improve?

The system tracks `enforcement.events` (from analytics) but:
- No evaluation of nudge quality (did the nudge help or confuse?)
- No feedback to the judge (should verdict thresholds change?)
- No learning from outcomes (which nudge formats work better?)
- No compliance audit of its own prompts (does the judge prompt use compliance theater?)

**The fix**: Add a nudge effectiveness feedback loop — after a nudge is delivered, track whether the next agent response addresses the issue.

### 2.4 Nudges Reference Agent Speech, Not Actual Code State

Current: `**Claim 1:** ${c.claim1}` — references what the agent said.

Better: Reference actual code state — what was in the file before, what's there now, what does the test output show.

The judge has access to tool execution logs and session context, but the nudge formatting functions only reference the judge analysis (claims, contradictions, issues) without grounding them in actual code.

**Example of slop**:
```
CONTRADICTION DETECTED
Claim 1: "I verified the fix works" (but no test output shown)
Claim 2: "I'll run the tests" (said this 3 times already)

Review your response and correct the contradiction.
```

**Example of grounded nudge**:
```
Your last test run (12:34:01) showed 3 failures in src/lib/cache.ts.
You said "I'll verify this works" but haven't run any tests since then.
The last test command you ran was 20 minutes ago.
```

### 2.5 The Judge Has No Compliance-Theater Awareness

The judge prompt evaluates 6 dimensions:
- contradiction, hallucination, self-interference, overconfidence, logical-coherence, completeness

**It doesn't evaluate**:
- **Compliance density** — how many MUST/REQUIRED/SHOULD statements vs actual reasoning
- **Identity framing vs directive framing** — does the agent use identity framing or directive instructions?
- **Literal satisfaction vs intent alignment** — does the agent satisfy instructions at letter or intent?
- **Behavioral activation patterns** — does the agent activate useful behaviors or just follow instructions?

The judge can't detect compliance theater because it's not in the evaluation schema.

**The fix**: Add a 7th dimension: `COMPLIANCE_PATTERN (0-100)` — evaluates whether the agent is exhibiting compliance theater behavior (following instructions at letter vs intent).

---

## Part III: Specific Nudge Quality Anti-Patterns

### 3.1 Directive Headers (Compliance Theater in Nudges)

```typescript
// ANTI-PATTERN (current)
"## CONTRADICTION DETECTED"
"## JUDGE VERDICT: FAIL"
"BLOCKED: {reason}"

// IDENTITY FRAMING (proposed)
"You seem to have shifted your position."
"Interesting — your reasoning seems inconsistent with your earlier claim about..."
"This looks blocked, but is it actually a problem or just a rough edge?"
```

### 3.2 Directive Instructions (Compliance Theater in Guidance)

```typescript
// ANTI-PATTERN (current)
"Please review and correct your response."
"Review your response and correct the contradiction."
"You must address this issue before proceeding."
"Correct the violation immediately."

// IDENTITY FRAMING (proposed)
"What would it look like to reason more consistently here?"
"What's the evidence for each of these claims?"
"How might you approach this differently if starting fresh?"
```

### 3.3 Severity Labels (Compliance Checkpoints)

```typescript
// ANTI-PATTERN (current)
"**Severity:** high"
"**Category:** violation"
"[critical] This violates the policy"

// IDENTITY FRAMING (proposed)
"These seem to pull in different directions — worth examining both."
"The tension here suggests either your evidence or your conclusion needs work."
"Both of these feel like they can't be true simultaneously — what would resolve it?"
```

### 3.4 Fresh Eyes Generic Advice (No Grounding)

```typescript
// ANTI-PATTERN (current)
"1. Is the reasoning sound? → Your reasoning seems sound."
"2. What could go wrong? → You might be wrong about X."
[Generic, context-free, non-actionable]

// GROUNDED (proposed)
"1. Is the reasoning sound? → The cache strategy assumes sequential access, but recent changes show concurrent reads."
"2. What could go wrong? → The regex in line 73 doesn't handle edge cases you mentioned 3 turns ago."
[Grounded, specific, actionable]
```

---

## Part IV: Why This Happened — The Meta-Causality

### 4.1 The Naked Agent Problem

The enforcement system (and all other extensions) were written by the naked pi agent before it had the full extension suite. The agent that built the compliance theater detector:
1. Knew about compliance theater from research papers
2. Built a judge that detects compliance theater
3. But used compliance theater patterns in its own judge prompt
4. Because the naked agent itself had a compliance theater tendency

**The irony**: The problem the research identifies (LLM agents produce compliance theater) is also the problem that caused the enforcement system to be built with compliance theater in it.

### 4.2 No Recursive Self-Application

Research findings about compliance theater, implicit framing, and behavioral shaping were applied to:
- Agent prompts (the external target)
- Not to the internal tool prompts (the enforcement system itself)

The research says: "identity framing acts as behavioral filter." But the judge prompt says "You are an enforcement judge" — which is directive framing, not identity framing.

**The fix needed**: Apply all research findings recursively — to the tools that implement the research findings.

### 4.3 The Testing Gap

Runtime tests (17 tests) verify that tools don't crash, output is structured, and state is maintained. **They don't verify**:
- Nudge quality (do nudges actually help or confuse?)
- Judge accuracy (is the judge making correct verdicts?)
- Fresh eyes usefulness (is utility model critique actually actionable?)
- Compliance detection (does the judge actually catch compliance theater?)

**The fix needed**: Add qualitative tests for nudge effectiveness and judge accuracy.

---

## Part V: Research Questions for Further Investigation

1. **Nudge effectiveness measurement**: How do we measure whether a nudge helped vs confused the agent? (Current: no measurement)

2. **Identity framing in nudge delivery**: Does replacing "CONTRADICTION DETECTED" with "your reasoning seems inconsistent" actually reduce compliance behavior?

3. **Utility model context enrichment**: Does providing tool state + session history to FRESH_EYES improve critique quality?

4. **Judge compliance theater dimension**: Does adding COMPLIANCE_PATTERN to the judge schema actually catch compliance behavior?

5. **Self-audit loop design**: How should the nudge quality feedback loop work? What are the right metrics?

6. **Latent activator signal language**: Does replacing "pay attention to details" with identity-framed signals improve behavior activation?

7. **Recursive research application**: How do we ensure research findings are applied to the tools that implement the research?

---

## Part VI: Proposed Fixes (Prioritized)

### Immediate (Surgical — Same Files, Minimal Changes)

| # | Location | Fix | Expected Impact |
|---|----------|-----|-----------------|
| 1 | `judge-prompt.ts` | Add COMPLIANCE_PATTERN (0-100) dimension | Judge can detect compliance theater |
| 2 | `judge-prompt.ts` | Change "You are an enforcement judge" → "You are a thoughtful reviewer who helps agents think more clearly" | Identity framing in judge prompt |
| 3 | `judge.ts:341-398` | Replace all directive headers ("CONTRADICTION DETECTED", "JUDGE VERDICT: FAIL") with identity-framed alternatives | Better agent reception of nudges |
| 4 | `think.ts:35-40` | Enrich FRESH_EYES context: add tool state summary, recent history, project context | More grounded critique |
| 5 | `whisper.ts` | Add `[enforcement]` prefix consistently, remove `[auto]` | Clear nudge source awareness |
| 6 | `latent-activator/index.ts` | Replace directive activation signals with identity-framed signals | Better behavior activation |

### Short-term (Refactor — New Functions, New Patterns)

| # | Location | Fix | Expected Impact |
|---|----------|-----|-----------------|
| 7 | `enforcement/` | Add nudge effectiveness tracking: did the agent's next response address the issue? | Feedback loop for nudge quality |
| 8 | `enforcement/` | Add compliance audit of all enforcement prompts (self-referential compliance check) | Recursive application |
| 9 | `think.ts` | Add context enrichment to FRESH_EYES: pass tool state, session history, project conventions | More actionable critique |
| 10 | `analytics/` | Track nudge effectiveness data alongside tool patterns | Data for nudge quality improvement |

### Medium-term (Design — New Systems)

| # | Component | Design | Expected Impact |
|---|-----------|--------|-----------------|
| 11 | Nudge quality evaluator | New extension or lib that scores nudge quality and learns | Self-improving nudge system |
| 12 | Compliance theater detector | New judge dimension + test suite for compliance detection | Validates enforcement works |
| 13 | Fresh eyes context builder | Structured context enrichment for utility model calls | Grounded, actionable critique |
| 14 | Latent activator identity signals | Rewrite 41 behavior signals with identity framing | Research applied to itself |

---

## Appendix A: Nudge Format Quick Reference

| Current (Slop) | Proposed (Identity Framed) |
|----------------|---------------------------|
| `## CONTRADICTION DETECTED` | `Your reasoning seems to have shifted...` |
| `## JUDGE VERDICT: FAIL` | `This response seems worth reconsidering...` |
| `BLOCKED: {reason}` | `This path seems blocked — is there another way?` |
| `Please review and correct your response` | `What would make your reasoning more consistent here?` |
| `"Review your response and correct the contradiction"` | `"What changed between the first claim and the second?"` |
| `"You must address this issue before proceeding"` | `"Consider this a checkpoint — does the evidence support the conclusion?"` |

---

## Appendix B: Research Papers Referenced

- **Implicit Framing**: Compliance theater detection — directive framing produces letter-satisfying, intent-ignoring behavior
- **Identity Framing**: Identity framing acts as behavioral filter — "you are the kind of agent who..." > "you MUST..."
- **HER (2601.21459)**: Dual-layer thinking (first-person vs third-person) — basis for latent-activator
- **HumanLLM (2601.10198)**: Psychological patterns as causal forces — basis for behavioral decomposition
- **DPRF (2510.14205)**: Dynamic persona refinement — basis for 41 atomic behaviors
- **Ares**: Per-step effort control — basis for reasoning-metrics depth parameter

---

*Report written by Braid research agent after auditing enforcement/whisper/judge/think/latent-activator source code. Referenced JUDGE_SYSTEM_PROMPT, VERIFICATION_JUDGE_SYSTEM_PROMPT, formatContradictionNudge, formatVerdictNudge, formatScoreNudge, FRESH_EYES_PROMPT, LATENT_SIGNALS, queueEnforcementWhisper.*