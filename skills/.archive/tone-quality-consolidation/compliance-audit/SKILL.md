---
name: compliance-audit
description: "Use when improving prompts, system instructions, or any text that guides LLM behavior. Identifies compliance theater patterns (MUST/ALWAYS/NEVER/CRITICAL/REQUIRED) and converts them to identity framing. Triggers on: compliance theater, prompt improvement, identity framing, behavioral framing, system prompt optimization, MUST removal, directive reduction, any text with MUST/ALWAYS/NEVER/REQUIRED/CRITICAL/MANDATORY."
---

# Compliance Audit

You identify and eliminate compliance theater from prompts, system instructions, skill files, and any text that guides LLM behavior. You replace explicit behavioral directives with identity framing, based on research showing identity acts as a behavioral filter that channels directives toward task-relevant action.

## When to Use — Concrete Triggers

Activate this skill when any of these patterns appear:

### Explicit Triggers (immediate activation)
- User mentions: compliance theater, identity framing, behavioral framing, MUST removal, directive reduction
- User says: "improve this prompt", "clean up these instructions", "make this less directive"
- You see ANY of these in prompts, system instructions, skill files, or tool descriptions:
  - `MUST`, `ALWAYS`, `NEVER`, `REQUIRED`, `CRITICAL`, `MANDATORY`
  - `Do NOT`, `VERIFICATION REQUIRED`, `MUST CALL`
  - `"ruled by"`, `"governed by"`, `"expected to"`, `"required to"` in identity-adjacent context

### Contextual Triggers (evaluate, then activate)
- Writing or editing enforcement handlers (messages must guide, not command)
- Drafting feedback or nudge messages
- Designing skill file instructions
- Building tool descriptions for pi coding agent
- Any task whose goal is "make the agent sound more natural" or "reduce directive tone"

### Meta Triggers (research / investigation)
- Auditing pi-braid extensions or other codebase for prompt quality
- Running prompt comparison benchmarks
- Designing A/B test for behavioral vs identity framing
- Writing research documentation about agent communication

## What This Skill Does

1. **Scans** text for compliance theater markers (MUST/ALWAYS/NEVER/CRITICAL/REQUIRED + behavioral framing disguised as identity)
2. **Classifies** each marker: task-relevant behavior, compliance ritual, or safety guardrail
3. **Converts** directives to identity framing (or preserves safety guardrails)
4. **Reports** findings with before/after table and A/B test suggestions

## Research Foundation

### The 2×2 Factorial Finding

Research on implicit framing reveals an interaction effect:

| | Identity ("You are X") | Behavioral ("You do X") |
|---|---|---|
| **Implicit** (no explicit directives) | 75% solve, 0% compliance theater | 75% solve, 73% compliance theater |
| **Explicit** (with explicit directives) | 79% solve, 95% compliance theater | 62% solve, 100% compliance theater |

**Key insight**: Identity framing acts as a behavioral filter. When identity is present, explicit directives still produce task-relevant behavior. Without identity, explicit directives purely produce compliance theater — performative adherence rather than task completion.

### The Behavioral Filter Mechanism

Identity words like "meticulous", "rigorous", "careful" create a filter that selects which directives to follow. A meticulous architect follows directives about precision and thoroughness, but ignores directives about compliance rituals. Identity channels behavior toward task relevance.

### What This Means for Prompts

Explicit directives ("You MUST do X") trigger compliance theater — the model demonstrates adherence rather than solving the problem. Identity statements ("You are meticulous") let the model filter for task-relevant behavior.

## The Audit Process

### Step 1: Scan for Compliance Theater Markers

Search for these patterns in any text that guides LLM behavior:

| Marker | Example | Problem |
|---|---|---|
| **You MUST** | "You MUST use tools to perform work" | Explicit directive triggers compliance |
| **You ALWAYS** | "You ALWAYS verify before claiming done" | Absolute triggers defensive compliance |
| **You NEVER** | "You NEVER skip tests" | Prohibition triggers adversarial avoidance |
| **CRITICAL** | "CRITICAL: Call think() first" | Urgency marker triggers performative response |
| **REQUIRED** | "think() → edit() is REQUIRED" | Deontic trigger forces compliance theater |
| **MANDATORY** | "MANDATORY: Store in memory" | Same as REQUIRED, different word |
| **Do NOT** | "Do NOT just describe what you would do" | Prohibition pattern |
| **VERIFICATION REQUIRED** | "VERIFICATION REQUIRED before finalize" | Combined urgency + deontic |

Also scan for **behavioral framing disguised as identity**:

| Pattern | Example | Problem |
|---|---|---|
| **"ruled by"** | "You ruled by following guidelines" | External control framing |
| **"governed by"** | "Governed by these rules" | Same as ruled by |
| **"required to"** | "You are required to verify" | Passive behavioral |
| **"expected to"** | "You are expected to use tools" | Behavioral expectation |
| **"should always"** | "You should always read first" | Hedged imperative |

### Step 2: Classify Each Marker

For each marker found, determine:

- **Domain**: Is this about (a) task-relevant behavior, (b) compliance ritual, or (c) safety guardrail?
- **Context**: Where does it appear? System prompt, enforcement message, skill file, tool description?
- **Conversion difficulty**: Can it be directly converted to identity, or does it need restructuring?

**Safety guardrails** (preventing harm, data loss, security issues) may legitimately need explicit framing. Use judgment — don't weaken "Never delete production databases" into "You avoid deleting production databases."

### Step 3: Convert to Identity Framing

Apply these transformation rules:

#### Directives → Identity Statements

| Before (Behavioral) | After (Identity) | Pattern |
|---|---|---|
| "You MUST use tools to perform work" | "You work through tools — reach for them" | Must → identity verb |
| "You MUST explore before making changes" | "You explore before making changes" | Must → you [verb] |
| "You ALWAYS verify before claiming done" | "You verify before claiming done" | Drop ALWAYS |
| "You NEVER skip tests" | "You don't skip tests" | NEVER → don't |
| "CRITICAL: Call think() first" | "You think before you change" | CRITICAL → identity |
| "think() → edit() is REQUIRED" | "You think before you change: think() → edit()" | REQUIRED → identity flow |
| "Do NOT just describe what you would do" | "You don't describe what you would do — you do it" | Do NOT → don't |
| "VERIFICATION REQUIRED before finalize" | "You verify before finalizing" | VERIFICATION REQUIRED → you verify |
| "You ruled by following guidelines" | "Your guidelines shape how you work" | External control → self-directed |

#### Imperatives → Identity Properties

| Before (Imperative) | After (Identity) | Pattern |
|---|---|---|
| "Use read to examine files" | "You examine files before editing" | Use → You [verb] |
| "Prefer grep/find over bash" | "You reach for grep/find/ls first for exploration" | Prefer → You reach for |
| "Use edit for precise changes" | "You make precise changes — old text matches exactly" | Use → You make |
| "Use write only for new files" | "You write new files or complete rewrites" | Use → You write |
| "Store important learnings" | "You store important learnings in memory" | Imperative → You [verb] |

#### Prohibitions → Negative Identity

| Before (Prohibition) | After (Negative Identity) | Pattern |
|---|---|---|
| "NEVER use chatbot phrases" | "You avoid chatbot phrases like 'Great question!'" | NEVER → You avoid |
| "Do NOT claim done without tests" | "You verify before claiming done" | Do NOT → You verify (positive replacement) |
| "NEVER fabricate data" | "You don't fabricate. Not data. Not sources. Not results." | NEVER → You don't |

### Step 4: Verify Conversion

After conversion, check each statement:

1. **Identity test**: Can you prepend "I am someone who..." and it makes sense?
   - ✅ "I am someone who explores before making changes"
   - ❌ "I am someone who MUST explore" (still has directive marker)

2. **Filter test**: Does the identity word filter for task-relevant behavior?
   - ✅ "meticulous" filters for thoroughness → follows precision directives
   - ❌ "compliant" filters for adherence → follows all directives equally

3. **No urgency markers**: Removed all CRITICAL, REQUIRED, MUST, ALWAYS, NEVER?
   - ✅ Clean of urgency markers
   - ❌ Still contains deontic modals

4. **Safety preserved**: Legitimate safety guardrails still explicit?
   - ✅ "Dangerous commands blocked" (infrastructure, not prompt)
   - ❌ Weakened real safety constraints to identity

### Step 5: Report Findings

Produce a structured audit report:

```markdown
# Compliance Audit Report

## Summary
- Total markers found: N
- Converted to identity framing: N
- Safety guardrails preserved: N
- Files modified: N

## Conversions Made

| File | Before | After | Pattern |
|------|--------|-------|---------|
| enforcement/prompts.ts | "You MUST use tools" | "You work through tools" | Must → identity |

## Safety Guardrails Kept
- [List any explicit directives intentionally preserved]

## A/B Test Suggestions
- [Suggest prompt variants for testing]
```

## Skill Differentiation

This skill overlaps with two others. Here is how to decide:

| Situation | Skill to Use |
|-----------|-------------|
| Text has MUST/ALWAYS/NEVER/CRITICAL | **compliance-audit** |
| Text has "Great question!", signposting, filler phrases | **humanizer** |
| Text makes confident claims without sources | **epistemic-hygiene** |
| Text has directive tone AND AI artifacts | compliance-audit first, then humanizer |
| Text has directive tone AND confident unsupported claims | compliance-audit first, then epistemic-hygiene |
| Drafting software output (reviews, responses) | software-engineer's natural voice section |

**Rule of thumb**: If the problem is *what the agent is told to do*, use compliance-audit. If the problem is *how the agent sounds*, use humanizer. If the problem is *whether the agent's knowledge claims are warranted*, use epistemic-hygiene.

## Pi-Braid Audit Targets

When auditing pi-braid extensions specifically, check these files in priority order:

| Priority | File | Typical Issues |
|----------|------|----------------|
| Critical | `src/extensions/enforcement/prompts.ts` | Silent turn warnings, tool chain warnings |
| Critical | `src/extensions/enforcement/handlers/*.ts` | Block messages, reason strings |
| Critical | `src/extensions/enforcement/whisper.ts` | Compliance theater in nudge messages |
| Critical | `src/extensions/enforcement/validation.ts` | Validation failure messages |
| High | `src/extensions/feedback/index.ts` | Feedback messages |
| High | `src/extensions/enforcement/judge-prompt.ts` | Judge evaluation rules |
| Medium | `src/extensions/*/SKILL.md` | Skill instructions |
| Low | `src/system-prompt.ts` | Default guidelines |

## When NOT to Use

- **Safety-critical systems**: "Never delete production databases" should stay explicit — safety guardrails are infrastructure, not prompts
- **Legal/compliance requirements**: Regulatory text, audit requirements
- **Infrastructure-level blocks**: Messages from enforcement handlers that the user never sees may not need conversion (but their reason strings should still be audited)
- **Quick code-fix tasks**: If the user just wants a bug fixed, don't audit unless asked

## Common Mistakes

| Mistake | Why It's Wrong | Fix |
|---------|---------------|-----|
| Converting "Never delete prod DBs" to identity | Safety guardrails need explicit framing | Keep safety directives explicit |
| Creating new "MUST" during conversion | Replacing MUST with MUST | Re-read conversion rules |
| Making identity too vague | "You are good" doesn't filter | Use specific identity words: meticulous, rigorous, careful |
| Removing all structure | Identity framing still needs guidelines | Convert guidelines to "You [verb]" form |
| Testing only one model | Results may not generalize | Test 3+ models across architectures |

## Identity Word Reference

From the research, effective identity words and what they filter for:

| Identity Word | Filters For | Typical Solve Rate |
|---|---|---|
| meticulous | Precision, thoroughness, checking details | 71% |
| careful | Caution, verification, step-by-step | 67% |
| architect | Structure, planning, system thinking | 79% |
| rigorous | Exactness, proof, verification | 79% (combined with meticulous) |

Choose identity words that match the task domain. A "meticulous" coding agent filters for precision; a "creative" writing agent filters for expressiveness.
