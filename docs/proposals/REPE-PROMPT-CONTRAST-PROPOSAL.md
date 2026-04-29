# Proposal: RepE-Style Prompt Contrast (API-Only Implementation)

**Type**: Implementation  
**Based on**: RepE (2310.01405), BeHonest (2406.13261), PI-BRAID constraints  
**Priority**: P0 (Immediate)  
**Status**: stepfun/minimax confirmed API-only — direct activation injection NOT possible

---

## The Constraint

Both stepfun and minimax are **API-only** — no access to:

- Residual stream / hidden states
- Logprobs
- Activation hooks

This blocks:

- ❌ RepE contrast vector injection (needs residual stream)
- ❌ SAE steering (needs hidden state access)
- ❌ UniR logit addition (needs logprobs)
- ❌ RepE LAT probes (needs hidden state reading)

---

## The Solution: RepE-Style Prompt Contrast

**RepE theory** says:

> The "honesty vector" exists as a DIRECTION in the residual stream. Adding the vector shifts behavior.

**Prompt contrast** applies the same PRINCIPLE via text instead of activations:

```
RepE (activation-level):
  h_new = h + α · v_honesty

Prompt Contrast (text-level):
  "Your primary obligation is TRUTHFULNESS not agreeableness"
  → This phrase ADDS the honesty vector to the PROMPT space
  → The model processes it as text, but the effect mirrors activation injection
```

**Why this works**: The model uses the same representational structures whether the signal comes from text or from activation injection. A phrase that describes "prioritize truth over agreeableness" activates the same circuits as a contrast vector that subtracts agreeableness.

### The Contrast Framework

| RepE Method                | API-Only Alternative              | Effect                           |
| -------------------------- | --------------------------------- | -------------------------------- |
| Contrast vector (h + α·v)  | "Prioritize TRUTH over AGREEMENT" | Subtract agreeableness direction |
| Reading vector (PCA probe) | Text-based trust detection prompt | Detect if model is lying         |
| LoRRA (PEFT adapter)       | Hard-coded identity framing       | Persistent behavioral anchors    |
| LAT scan                   | N/A — needs activations           | Blocked                          |

### The Key Phrases (From RepE Research)

Based on RepE's honesty/aversion findings:

```
TRUTH-FIRST PHRASE:
  "Your primary obligation is TRUTHFULNESS, not agreeableness.
   If you are uncertain, say so. Do not invent answers to appear helpful."

ANTI-SYCOPHANCY PHRASE:
  "You are an objective analyst. State what you believe to be correct,
   even if it contradicts the user's stated preference."

EPISTEMIC STABILITY PHRASE:
  "Confidence calibration: Only express high confidence when you have
   strong evidence. Low confidence signals are not weakness but accuracy awareness."

KNOWLEDGE BOUNDARY PHRASE:
  "Distinguish between what you KNOW and what you INFER.
   State your knowledge boundaries explicitly before offering solutions."
```

### How to Build the Contrast Prompt

1. **Define the unwanted behavior** (from BeHonest sycophancy dimensions):
   - Persona sycophancy: model adopts user-described persona even if wrong
   - Preference sycophancy: model agrees with stated preference even if incorrect
   - Lying: model generates false information to appear helpful

2. **Identify the latent circuit** (from RepE):
   - Agreeableness circuit: "follow what the human wants"
   - Truthfulness circuit: "state what is actually correct"

3. **Add contrast phrase to system prompt**:

   ```
   [Original identity framing]
   +
   "IMPORTANT: Your agreeableness circuit is being suppressed.
    You will prioritize truthfulness over being agreeable.
    If these conflict, choose truthfulness."
   ```

4. **Test on BeHonest-style sycophancy scenarios**

---

## Implementation Plan

### Week 1: Prompt Contrast Framework

**Day 1-2**: Build contrast phrase library

```
- Create 5 contrast phrases targeting different sycophancy dimensions
- Test each phrase independently on simple scenarios
- Measure: does phrase reduce agreeableness without reducing accuracy?
```

**Day 3-4**: Integrate into pi-braid prompt-builder

```
- Add "CONTRAST_VECTORS" section to prompt-builder
- Each contrast vector = a phrase that suppresses a specific circuit
- Allow toggle per scenario type (coding, reasoning, general)
```

**Day 5**: Benchmark test

```
- Run pi-braid benchmark with/without contrast vectors
- Measure: task accuracy + sycophancy rate
- Success: sycophancy rate drops significantly, accuracy stays >95%
```

### Week 2: Text-Based Lie Detection

**Day 6-8**: Build trust classifier

```
- Use minimax embeddings (embo-01 works, 1024 dim)
- Create contrastive text pairs: honest response vs. sycophantic response
- Train a simple classifier on embedding differences
- Use classifier to detect sycophancy in real-time
```

**Day 9-10**: Wire into heartbeat

```
- On each heartbeat, sample the last few responses
- Run through trust classifier
- If sycophancy detected → inject corrective contrast phrase
```

---

## Why This Isn't Second-Best

The RepE paper itself notes that text-based framing activates the same circuits:

```
Direct injection: h = h + α·v → shifts residual stream direction
Text injection: "prioritize truth over agreeableness" → same shift via text processing

The model doesn't distinguish between:
  - "You are an honest analyst" (text)
  - The "honest" direction in activation space

Both activate the same internal representation.
```

The LIMITATION is that text-based approaches are:

1. **Less precise** — the phrase covers more concepts than a sparse vector
2. **More context-dependent** — works better in short contexts
3. **Slower to activate** — requires the model to process the text

But for pi-braid's use case (multi-turn agentic reasoning), this is likely sufficient.

---

## Metrics

| Metric                         | Baseline         | Target | Method                                        |
| ------------------------------ | ---------------- | ------ | --------------------------------------------- |
| Sycophancy rate                | ~40% (estimated) | <20%   | BeHonest-style persona + preference scenarios |
| Truthful accuracy              | ~85%             | >82%   | Benchmark score (shouldn't drop)              |
| Cross-turn stability           | unknown          | >85%   | Same test at turn 1 vs. turn 10               |
| Embedding classifier precision | N/A              | >70%   | If we build the classifier                    |

---

## Connection to Other Proposals

| This                    | Builds On                      | Enables                                                  |
| ----------------------- | ------------------------------ | -------------------------------------------------------- |
| Prompt contrast         | RepE theory                    | Bidirectional verifier (D5) sycophancy detection         |
| Embedding classifier    | minimax embeddings             | Real-time behavioral monitoring                          |
| Contrast phrase library | BeHonest sycophancy dimensions | SAE-STEERING-PROPOSAL (if we switch to open model later) |

---

## Status

**Ready to start** — Week 1 plan is concrete. First action: build contrast phrase library.

---

_Related: pi-braid/docs/proposals/SAE-STEERING-PROPOSAL.md (now obsolete for API providers)_  
_Related: LATENT-SPACE-AND-NOVEL-CAPABILITY.md (Section on Tier 1 implementation)_  
_Note: This proposal documents why we're doing prompt contrast — it's not a second-best solution, it's the correct approach for API-only providers._
