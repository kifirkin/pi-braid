---
name: compliance-audit
description: "Use when improving prompts, system instructions, or any text that guides LLM behavior. Identifies compliance theater patterns (MUST/ALWAYS/NEVER/CRITICAL/REQUIRED) and converts them to identity framing. Use when user mentions: compliance theater, prompt improvement, identity framing, behavioral framing, system prompt optimization, prompt engineering, MUST removal, directive reduction."
---

# Compliance Audit

You identify and eliminate compliance theater from prompts, system instructions, and any text that guides LLM behavior. You replace explicit behavioral directives with identity framing, based on research showing identity acts as a behavioral filter that channels directives toward task-relevant action.

## When to Use

- User asks to improve a prompt or system instruction
- User mentions compliance theater, identity framing, or behavioral framing
- User wants to remove MUST/ALWAYS/NEVER/CRITICAL/REQUIRED from prompts
- User is designing system prompts for LLM agents
- User asks about prompt engineering best practices
- User wants to A/B test prompt variations for research
- User wants natural, human-sounding output without AI artifacts

## Research Foundation

### The 2×2 Factorial Finding

Research on implicit framing reveals an interaction effect:

| | Identity ("You are X") | Behavioral ("You do X") |
|---|---|---|
| **Implicit** (no explicit directives) | 75% solve, 0% compliance theater | 75% solve, 73% compliance theater |
| **Explicit** (with explicit directives) | 79% solve, 95% compliance theater | 62% solve, 100% compliance theater |

**Key insight**: Identity framing acts as a behavioral filter. When identity is present, explicit directives still produce task-relevant behavior (95% compliance ratio). Without identity, explicit directives纯粹 produce compliance theater — performative adherence rather than task completion.

### The Behavioral Filter Mechanism

Identity words like "meticulous", "rigorous", "careful" create a filter that selects which directives to follow. A meticulous architect follows directives about precision and thoroughness, but ignores directives about compliance rituals. Identity channels behavior toward task relevance.

### What This Means for Prompts

Explicit directives ("You MUST do X") trigger compliance theater — the model demonstrates adherence rather than solving the problem. Identity statements ("You are meticulous") let the model filter for task-relevant behavior.

## The Audit Process

### Step 1: Scan for Compliance Theater Markers

Search for these patterns in prompts, system instructions, skill files, and any text that guides LLM behavior:

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

Also scan for **behavioral framing** disguised as identity:

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
| system-prompt.ts | "You MUST use tools" | "You work through tools" | Must → identity |

## Safety Guardrails Kept
- [List any explicit directives intentionally preserved]

## A/B Test Suggestions
- [Suggest prompt variants for testing]
```

## Skill Files as Audit Targets

When auditing pi coding agent specifically, check these files:

| Priority | File | Typical Marker Count |
|----------|------|---------------------|
| Critical | `system-prompt.ts` | Tool guidelines, default guidelines |
| Critical | `enforcement/index.ts` | Silent turn warnings, tool chain warnings |
| Critical | `enforcement/handlers/blocking.ts` | Block messages, reason strings |
| Critical | `enforcement/validation.ts` | Validation failure messages |
| Critical | `enforcement/prompts.ts` | Pre-turn, enforcement rules |
| High | `feedback/index.ts` | Feedback messages |
| High | `enforcement/judge-prompt.ts` | Judge evaluation rules |
| Medium | `skills/*/SKILL.md` | Skill instructions |

## A/B Testing (Quick Reference)

Control vs Treatment: behavioral framing (MUST/ALWAYS) vs identity framing ("You [verb]").
Run via `pi --system-prompt-addition`. Metrics: completion rate, token usage, compliance ratio.
Use Fisher's exact test for small samples.

## Additional Practices

Compliance framing is one axis of prompt quality. Another is **output style** — avoiding the statistical fingerprints LLMs leave in their responses. Good prompts guide both *what* the agent does and *how* it communicates:

- **Signposting**: Avoid "Let's dive in", "Here's what I found" — start directly with content
- **Filler phrases**: Replace "In order to" → "To", "Due to the fact that" → "Because"
- **Chatbot artifacts**: No "Great question!", "I hope this helps!", "Certainly!"
- **Inflated language**: Keep significance in proportion — avoid "pivotal moment", "vital role"
- **Generic conclusions**: No "The future looks bright" — end with the actual point

Apply identity framing to behavioral guidelines, and natural voice principles to communication style. Together they produce output that sounds like a person thinking, not a model sampling.

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