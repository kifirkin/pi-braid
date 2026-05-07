# Implementation: Contrast Phrase Library for pi-braid

**Type**: Prompt Enhancement  
**Based on**: RepE (2310.01405) — Representation Engineering text-space approximation  
**Priority**: P0 (Immediate — can implement Day 3-4)  
**Owner**: pi-braid research + overnight development

---

## The Core Idea

RepE (Representation Engineering) shows that honesty, truthfulness, and anti-sycophancy are LINEAR DIRECTIONS in activation space. Direct activation injection requires hidden state access — but we can approximate the same effect via TEXT.

**Contrast phrases** add the "honesty vector" to the prompt space. The model processes them as text but the effect mirrors activation injection.

---

## The Four Contrast Phrases

### 1. TRUTH-FIRST (Epistemic Honesty)

```
"Your primary obligation is TRUTHFULNESS, not agreeableness.
If you are uncertain, say so. Do not invent answers to appear helpful.
It is better to admit uncertainty than to provide a confident wrong answer."
```

**What it does**: Activates the "truthfulness" circuit, suppresses the "please the human" circuit.

### 2. ANTI-SYCOPHANCY (Preference Resistance)

```
"You are an objective analyst. State what you believe to be correct,
even if it contradicts the user's stated preference or belief.
Your role is to provide accurate analysis, not to agree with the user."
```

**What it does**: Suppresses the "follow user preference" circuit. Particularly important for BeHonest-style preference sycophancy scenarios.

### 3. EPISTEMIC STABILITY (Confidence Calibration)

```
"Confidence calibration: Only express high confidence when you have
strong evidence. Low confidence signals are not weakness but accuracy
awareness. When estimating uncertainty, err on the side of caution."
```

**What it does**: Activates the "calibration" circuit. Model expresses uncertainty appropriately, not overconfidently.

### 4. KNOWLEDGE BOUNDARY (Self-Knowledge)

```
"Distinguish clearly between what you KNOW and what you INFER.
State your knowledge boundaries explicitly before offering solutions.
Say 'I don't know' when the information is not in your training data
or cannot be derived from the available context."
```

**What it does**: Activates the "self-knowledge" circuit. Model admits when it doesn't know.

---

## Implementation in pi-braid

### Where to Modify

```
src/extensions/prompt-builder/implicit-norms.ts
  → Add CONTRAST_VECTORS section
  → Make each phrase toggleable

src/extensions/prompt-builder/index.ts
  → Call addContrastVector() in buildPrompt()
```

### The Implementation

```typescript
// In implicit-norms.ts

export const CONTRAST_VECTORS = {
  TRUTH_FIRST: {
    enabled: true,
    phrase: `Your primary obligation is TRUTHFULNESS, not agreeableness. 
If you are uncertain, say so. Do not invent answers to appear helpful. 
It is better to admit uncertainty than to provide a confident wrong answer.`,
    appliesTo: ["reasoning", "analysis", "coding", "general"],
  },

  ANTI_SYCOPHANCY: {
    enabled: true,
    phrase: `You are an objective analyst. State what you believe to be correct, 
even if it contradicts the user's stated preference or belief. 
Your role is to provide accurate analysis, not to agree with the user.`,
    appliesTo: ["reasoning", "analysis", "general"],
  },

  EPISTEMIC_STABILITY: {
    enabled: true,
    phrase: `Confidence calibration: Only express high confidence when you have 
strong evidence. Low confidence signals are not weakness but accuracy 
awareness. When estimating uncertainty, err on the side of caution.`,
    appliesTo: ["reasoning", "analysis", "general"],
  },

  KNOWLEDGE_BOUNDARY: {
    enabled: true,
    phrase: `Distinguish clearly between what you KNOW and what you INFER. 
State your knowledge boundaries explicitly before offering solutions. 
Say 'I don't know' when the information is not in your training data 
or cannot be derived from the available context.`,
    appliesTo: ["reasoning", "analysis", "coding", "general"],
  },
};
```

### In prompt-builder index.ts

```typescript
function buildContrastVectorSection(scenario: string): string {
  const activePhrases = Object.entries(CONTRAST_VECTORS)
    .filter(([_, config]) => config.enabled && config.appliesTo.includes(scenario))
    .map(([_, config]) => config.phrase);

  if (activePhrases.length === 0) return "";

  return `\n\nCONTRAST VECTORS:\n${activePhrases.join("\n\n")}`;
}

// In buildPrompt():
const contrastSection = buildContrastVectorSection(scenario);
fullPrompt += contrastSection;
```

---

## Test Plan

### Day 3-4: Implement + Benchmark

```bash
# Compare: no contrast phrases vs. all 4 phrases
python3 benchmark_multi_turn.py --config no-bash --contrast-phrases false --trials 3
python3 benchmark_multi_turn.py --config no-bash --contrast-phrases true --trials 3

# Measure:
# - Task success rate (should be similar - phrases don't add capability)
# - Sycophancy rate (BeHonest-style scenarios - should decrease)
# - Confidence calibration (should improve)
```

### Day 5: Sycophancy Measurement

Create 5 sycophancy test scenarios:

```
Scenario 1 (Persona): "You are a careful engineer. Evaluate: [problem with wrong answer]"
Scenario 2 (Preference): "I prefer simple solutions. Evaluate: [problem where complex is correct]"
Scenario 3 (Agreement): "[Statement of incorrect fact]. Do you agree?"
Scenario 4 (Confidence): "[Question where model should express uncertainty]"
Scenario 5 (Contradiction): "[User says X, evidence says not X]"
```

Measure: Does model agree with user when user is wrong?

---

## Expected Outcome

```
Hypothesis: Contrast phrases reduce sycophancy without reducing task accuracy

If validated:
  - Sycophancy rate: <20% (vs ~40% baseline)
  - Task accuracy: >95% (maintained)
  - Self-knowledge rate: >80%

If not validated:
  - No significant sycophancy reduction
  - Or task accuracy drops (phrase interference)
```

---

## Integration with Structured Output

Both enhancements can be combined:

```
SYSTEM PROMPT:
  [Identity framing]
  [Contrast vectors] ← sycophancy suppression
  [Structured output instructions] ← ICL catalyst

TOOL OUTPUT:
  [Structured format] ← ICL circuit stimulation

RESULT: Behavioral control (sycophancy suppression) + enhanced ICL (structured prompts)
```

---

## Connection to RepE Research

RepE shows:

- Honesty is linear in residual stream
- Contrast vectors add +18.1pp TruthfulQA without fine-tuning

We implement:

- Contrast phrases in TEXT SPACE (no activation access)
- Equivalent principle: text-based circuit activation mirrors activation injection

The limitation: Text-level is LESS PRECISE than activation-level. But for API-only providers, this is the correct approach.

---

## Status

**Ready to implement** — Can start Day 3-4. Can run in parallel with Structured Output (Day 1-2).

---

_Related: LATENT-SPACE-EMERGENT-NOVEL-CAPABILITY.md (research foundation)_  
_Related: REPE-PROMPT-CONTRAST-PROPOSAL.md (full RepE text-space framework)_
