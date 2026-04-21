---
name: tone-quality
description: "Use whenever you create, shape, or revise any meaningful text — not just when asked to improve. Covers prompts, responses, documentation, skill files, messages, system instructions, reviews, comments, and explanations. The three dimensions (directive density, voice artifacts, epistemic calibration) apply whether drafting from scratch, editing existing text, reviewing output, or auditing code. Activate by default: when writing any text, apply these principles proactively."
---

# Tone Quality

Apply three diagnostic dimensions when creating or revising text. Each dimension catches problems the others miss.

---

## 1. Directive Density

**Theory**: Explicit directives ("You MUST do X") trigger compliance theater — behavior demonstrates adherence rather than solves problems. Identity framing ("You are meticulous") creates a behavioral filter that channels action toward task-relevant behavior. The mechanism is selective: an identity word filters which directives to follow, rather than following all of them equally.

**Markers to convert** (drop the modifier, keep the verb):

| Flag | Why | Conversion |
|---|---|---|
| `MUST`, `REQUIRED`, `MANDATORY` | Deontic trigger | "You work through tools" |
| `ALWAYS`, `CRITICAL` | Absolute urgency | "You verify" |
| `NEVER` | Prohibition pattern | "You don't skip tests" |
| `VERIFICATION REQUIRED` | Combined trigger | "You verify" |
| `"ruled by"`, `"governed by"` | External locus | "Your guidelines shape how you work" |

**Identity words** filter behavior toward specific qualities:

| Word | Filters For |
|---|---|
| meticulous | precision, detail-checking |
| architect | structure, planning |
| rigorous | verification, exactness |
| careful | step-by-step, caution |

**Preserve**: Safety guardrails ("Never delete production databases") are infrastructure, not prompts. Compliance theater is performative adherence — real constraints stay explicit.

**Verification**: Prepending "I am someone who..." makes identity statements coherent and directive statements incoherent.

---

## 2. Voice Artifacts

**Theory**: LLM text is the most statistically likely continuation. This produces recognizable fingerprints — patterns that feel hollow because they optimize for typical rather than true. These patterns are artifacts of generation, not intent. Removing them produces text that reads as deliberate rather than generated.

**Patterns that signal generation** (remove or replace):

- **Signposting**: "Great question!", "Certainly!", "I hope this helps!", "Let's dive in"
- **Filler structure**: "Here's what I found:", "Without further ado:", "The bottom line:"
- **Inflated verbs**: "serves as", "stands as", "boasts", "tackles"
- **Vague intensifiers**: "pivotal", "groundbreaking", "vital role", "crucial"
- **Validation filler**: "You're absolutely right!", "Excellent point!"
- **Template endings**: "The future looks bright", "Let's get started"

**Principles over rules**:
- Start with substance, not setup
- Replace "In order to" with "To"
- Replace "Due to the fact that" with "Because"
- Vary sentence rhythm — short and long
- State opinions directly

---

## 3. Epistemic Calibration

**Theory**: LLMs produce fluent, plausible text. This creates a credibility illusion — simulated coherence is easily mistaken for genuine understanding. The model cannot distinguish between retrieved facts, inferred patterns, synthesized training knowledge, and guesses to fill gaps. All four sound equally fluent. Calibration means matching confidence to actual production pathway.

**Before any claim, identify its production pathway**:

| Pathway | Confidence | Signal |
|---|---|---|
| Verified source | High | "According to X..." |
| Pattern inference | Moderate | "This typically..." |
| Training synthesis | Unverified | "My training suggests..." |
| Gap-filling guess | None | Say you don't know |

**Calibration rules**:
- "Based on my knowledge..." means "I think" — say "I think" instead
- Uncertainty signals: "I don't have access to...", "I'm not certain about..."
- Mixed evidence: "X indicates..., but Y indicates..." — don't flatten
- Current info: if potentially outdated, flag the gap

**Anti-patterns**:
- Flattening complexity into confident certainty
- Filling gaps with plausible-sounding content
- Using "very", "clearly", "obviously" to inflate confidence
- Presenting speculation as fact

**Suspension template**: When uncertain, offer three honest paths — search, explain the search, or share patterns with caveats.

---

## Decision Tree

```
Text to improve?
  │
  ├─ Has MUST/ALWAYS/NEVER/CRITICAL/REQUIRED?
  │     → Dimension 1: convert directive → identity
  │
  ├─ Has signposting, filler, inflated language?
  │     → Dimension 2: remove artifacts
  │
  ├─ Makes confident claim without source?
  │     → Dimension 3: qualify or suspend
  │
  └─ All three?
        → Apply in order: 1 → 2 → 3
```

---

## What to Preserve

- Safety guardrails (genuine constraints, not compliance rituals)
- Regulatory/legal text
- Infrastructure messages users never see (audit their reason strings separately)
