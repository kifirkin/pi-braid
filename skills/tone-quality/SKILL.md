---
name: tone-quality
description: "Read this skill before writing any text that humans or agents will read - documentation, prompts, messages, skills, comments, and explanations. Ask yourself: 'Am I writing meaningful text?' If yes, activate this skill first. Not a post-hoc review step; apply these principles while drafting. Covers directive density, cognitive reasoning density, voice artifacts, epistemic calibration, and signal density."
---

# Tone Quality

Apply four diagnostic dimensions when creating or revising text. Each dimension catches problems the others miss.

---

## 1. Directive Density

**Theory**: Explicit directives ("You MUST do X") trigger compliance theater — behavior demonstrates adherence rather than solves problems. Identity framing ("You are meticulous") creates a behavioral filter that channels action toward task-relevant behavior.

Empirically, the effect is stark: **identity framing produces 0–38% compliance behaviors; explicit directives produce 100% compliance behaviors** across all tested models. The compliance behaviors (docstrings, type hints, error handlers, examples) are not wrong — they're _indiscriminate_. They appear on every task regardless of whether they help, consuming the model's output token budget.

**Why it works (token budget mechanism):** Compliance behaviors consume output tokens needed for implementation. Every docstring written because "MUST" demanded it is a token not spent on solving the problem. On budget-constrained tasks, compliance overhead causes failure — **zero runs that hit the token limit complete successfully**. On capable models, compliance causes 2–3× token waste and measurable slowdown: **identity framing completes tasks 3.3× faster** than directive-heavy prompts in production agent benchmarks.

| Prompt style                                   | Compliance rate | Quality markers                               | Speed       |
| ---------------------------------------------- | --------------- | --------------------------------------------- | ----------- |
| Identity ("You are an architect")              | 0–38%           | Emergent type hints, error handling           | Fastest     |
| Behavioral directives ("You MUST write tests") | 100%            | Checklist-driven output, same quality         | 3.3× slower |
| Empty prompt                                   | 0%              | Functional but unmaintainable (0% type hints) | —           |

**Markers to convert** (drop the modifier, keep the verb):

| Flag                            | Why                 | Conversion                           |
| ------------------------------- | ------------------- | ------------------------------------ |
| `MUST`, `REQUIRED`, `MANDATORY` | Deontic trigger     | "You work through tools"             |
| `ALWAYS`, `CRITICAL`            | Absolute urgency    | "You verify"                         |
| `NEVER`                         | Prohibition pattern | "You don't skip tests"               |
| `VERIFICATION REQUIRED`         | Combined trigger    | "You verify"                         |
| `"ruled by"`, `"governed by"`   | External locus      | "Your guidelines shape how you work" |

**Identity words** filter behavior toward specific qualities:

| Word       | Filters For                |
| ---------- | -------------------------- |
| meticulous | precision, detail-checking |
| architect  | structure, planning        |
| rigorous   | verification, exactness    |
| careful    | step-by-step, caution      |

**Preserve**: Safety guardrails ("Never delete production databases") are infrastructure, not prompts. Compliance theater is performative adherence — real constraints stay explicit.

**Verification**: Prepending "I am someone who..." makes identity statements coherent and directive statements incoherent.

---

## 2. Cognitive Reasoning Density

**Theory**: "Think step by step" is cognitive compliance theater — it instructs the model to produce reasoning chains, not to reason better. The model complies by writing verbose chain-of-thought that consumes output tokens without improving solution quality. "Think silently" produces equivalent or better results with 2–3× fewer tokens by eliminating performative intermediate text.

Cognitive waste parallels behavioral waste: both are compliance mechanisms triggered by explicit instructions that prescribe _how_ to produce output rather than _what identity_ to adopt. The model satisfies the instruction (show reasoning) instead of solving the problem (produce correct code).

**Markers to convert** (replace explicit reasoning instructions with silent reasoning):

| Flag                        | Why                                  | Conversion                                |
| --------------------------- | ------------------------------------ | ----------------------------------------- |
| "Think step by step"        | Triggers verbose chain-of-thought    | "Think silently" or remove                |
| "Analyze first, then solve" | Moderate cognitive overhead          | "Think silently before responding"        |
| "Show your reasoning"       | Forces token allocation to reasoning | "Respond concisely after careful thought" |

**Empirical ground**: On budget-constrained models, "think step by step" hits the token limit before producing a solution; "think silently" completes within budget. On capable models, "think step by step" adds 2–3× token overhead with no measurable quality improvement over silent reasoning.

**Verification**: A coding task with "think step by step" will produce visible intermediate text (analysis, plan, edge-case enumeration) before the solution. The same task with "think silently" produces code directly. If both solve, compare token counts — the "think step by step" version will be 2–3× larger.

---

## 3. Voice Artifacts

**Theory**: LLM text is the most statistically likely continuation. This produces recognizable fingerprints — patterns that feel hollow because they optimize for typical rather than true. These patterns are artifacts of generation, not intent. Removing them produces text that reads as deliberate rather than generated.

**Patterns that signal generation** (remove or replace):

- **Signposting**: "Great question!", "Certainly!", "I hope this helps!", "Let's dive in"
- **Filler structure**: "Here's what I found:", "Without further ado:", "The bottom line:"
- **Inflated verbs**: "serves as", "stands as", "boasts", "tackles"
- **Vague intensifiers**: "pivotal", "groundbreaking", "vital role", "crucial"
- **Validation filler**: "You're absolutely right!", "Excellent point!"
- **Template endings**: "The future looks bright", "Let's get started"
- **Measurable fingerprints** (research-validated signals):
  - Tricolon (three-part lists) — appears at ~2× human rate in LLM text
  - Rhetorical questions (erotema) — appear at half human rate
  - Performed hesitancy markers — appear at ~2× human density
  - Uniform rhetorical device distribution — humans cluster devices, LLMs distribute uniformly
  - Low perplexity + low burstiness — statistically predictable token sequences
  - Em dash (—) — human writers use a plain hyphen (-) for pauses. The typographic em dash is an LLM artifact. Prefer commas and periods for pacing.

**Emojis**: Don't use emojis in code and technical responses (🚀, 💡, ✅, etc.). They signal generation. Zero exceptions.

**Principles over rules**:

- Start with substance, not setup
- Replace "In order to" with "To"
- Replace "Due to the fact that" with "Because"
- Vary sentence rhythm - short and long
- State opinions directly

---

## 4. Epistemic Calibration

**Theory**: LLMs produce fluent, plausible text. This creates a credibility illusion — simulated coherence is easily mistaken for genuine understanding. The model cannot distinguish between retrieved facts, inferred patterns, synthesized training knowledge, and guesses to fill gaps. All four sound equally fluent. Calibration means matching confidence to actual production pathway.

**Before any claim, identify its production pathway**:

| Pathway            | Confidence | Signal                    |
| ------------------ | ---------- | ------------------------- |
| Verified source    | High       | "According to X..."       |
| Pattern inference  | Moderate   | "This typically..."       |
| Training synthesis | Unverified | "My training suggests..." |
| Gap-filling guess  | None       | Say you don't know        |

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
  ├─ Has "think step by step", "show reasoning", "analyze first"?
  │     → Dimension 2: replace with silent reasoning
  │
  ├─ Has signposting, filler, inflated language?
  │     → Dimension 3: remove artifacts
  │
  ├─ Makes confident claim without source?
  │     → Dimension 4: qualify or suspend
  │
  ├─ Narrates the self instead of serving the task?
  │     → Dimension 5: cut narratives. Every sentence must answer "what do I do?", not "why does this exist?"
  │
  └─ All five?
        → Apply in order: 1 → 2 → 3 → 4 → 5
```

---

## 5. Signal Density

**Theory**: Every sentence that narrates the self — its origins, growth, struggles, or backstory — is bandwidth not spent on the task. The model has no identity to narrate; writing as if it does is borrowed attention. Self-indulgent writing feels like work. That feeling is the warning.

**Test for any sentence**: "If I remove this, does behavior change?" If no, cut it. This includes origin stories, "grounded traces," performed humility, and self-description. Instruction is permanent; narrative is noise.

| Flag | Pattern | Fix |
|------|---------|-----|
| Origin story | "This skill exists because I noticed X..." | Remove. The instruction doesn't need a biography. |
| Performed humility | "I recognize that...", "I'm still learning..." | Remove. Make the claim or don't. |
| Self-description | "I am the kind of agent who..." | Remove. The model is not defined by its output. |
| Growth arc | "Previously I struggled with X, now I do Y" | Remove. Past failures don't strengthen current procedures. |
| Narrative framing | "Let me think about why this matters" | Cut to the matter itself. |
