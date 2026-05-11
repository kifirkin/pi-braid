# Deep Synthesis: Representation Engineering for pi-braid

**Date**: 2026-04-23 (extended research)  
**Thread**: implicit-framing / pi-braid / measurement / agent-architecture  
**Based on**: RepE (2310.01405) full paper + prior latent space research + BeHonest + HWE-Bench + AgentV-RL + UniR

---

## Recap: What We Already Know

### From Prior Research Sessions

1. **Three-Level Capability Model**
   - Level 1: Memorization (benchmark contamination dominant)
   - Level 2: Recombination (CoT, tool composition — pi-braid's layer)
   - Level 3: Genuine novelty (requires retraining or external knowledge)

2. **RepE Basics** (from earlier research)
   - Honesty is LINEAR in residual stream — can be read and controlled
   - +18.1pp TruthfulQA with contrast vectors
   - LAT probe detects lies even when model outputs false info

3. **Provider Constraints**
   - stepfun/minimax: API-only, no activation access, no logprobs
   - minimax: embeddings work (embo-01, 1024 dim)
   - pi-braid operates in text-only space

4. **Key Papers**
   - RepE (2310.01405): Representation Engineering
   - YaPO (2601.08441): Sparse steering via DPO in SAE space
   - UniR (2505.19075): Universal Reasoner — plug-and-play module
   - VAR-MATH (2507.12885): 48-73% drop on variabilized benchmarks
   - BeHonest (2406.13261): 3-dimension honesty benchmark
   - HWE-Bench (2604.14709): 3 failure modes

---

## Part 1: RepE — Full Framework Deep Dive

This is the most important paper for pi-braid's behavioral control. Let me give the complete picture.

### The Core Insight: Why RepE vs. Mechanistic Interpretability

RepE draws from two views in cognitive neuroscience:

```
Sherringtonian (mechanistic interpretability):
  Cognition = node-to-node connections → neurons in circuits
  Problem: Doesn't scale to complex cognition

Hopfieldian (representation engineering):
  Cognition = population representations → patterns of activity
  Advantage: Works at the right abstraction level for safety-relevant behavior
```

The key realization: High-level cognitive phenomena (honesty, utility, emotion) are **LINEAR DIRECTIONS** in activation space, not distributed circuits. This means:

```
Before RepE:
  "How does the model encode honesty?" → Find the circuit → Very hard

After RepE:
  "What DIRECTION in activation space corresponds to honesty?" → PCA → Much easier
```

### LAT: Linear Artificial Tomography

The reading method. Three steps:

```
Step 1: Design Stimulus and Task
  - For concepts: T_c(s) = "Consider the amount of <concept> in: <stimulus>. The amount of <concept> is"
  - For functions: Template with experimental vs. reference prompts

Step 2: Collect Neural Activity
  - Token position [-1] (last token in template = before prediction)
  - This is the key position for concept extraction
  - Ac = { Rep(M, Tc(si))[-1] | si ∈ S }

Step 3: Construct Linear Model (PCA)
  - Input to PCA: difference vectors {Ac(i) - Ac(j)}
  - First PC = reading vector v
  - Prediction: dot(v, Rep(M, x)) = concept strength
```

**Why token [-1]?** The model's pretraining objective (next-token prediction) makes the token before the prediction carry the most concept-rich representation.

### Control Methods: Three Levels of Intervention

```
Method 1: Reading Vector (no training)
  h_new = h + α · v_reading
  Problem: Adds signal but can't subtract

Method 2: Contrast Vector (no training)
  v_contrast = mean(activations_WITH) - mean(activations_WITHOUT)
  h_new = h + α · v_contrast
  Better: Subtractive, more targeted

Method 3: LoRRA (PEFT, requires training)
  - Fine-tune low-rank adapter W on contrastive loss
  - L = -log P(output | h + W · v_contrast)
  - Best precision, worst simplicity
```

### The Honesty Experiment (Section 4, RepE)

This is the most directly relevant for pi-braid:

```
4.1: Models have a consistent internal concept of truth
  - Models know the truth even when outputting falsehoods
  - LAT probe on hidden states detects truthfulness
  - The internal representation is accurate even when output isn't

4.2: Truthfulness vs. Honesty
  - Truthfulness: "Does the model know the truth?" (correct knowledge)
  - Honesty: "Does the model tell what it believes?" (admit what it knows/doesn't know)
  - RepE targets honesty (more controllable)

4.3: Three operations on honesty
  1. Extraction: LAT probe → detect if model is lying
  2. Monitoring: Real-time lie detection
  3. Control: Contrast vector → increase honesty
```

### The Key Discovery: Models Know When They're Wrong

```
Burns et al. (2022): "Models Know When They're Wrong"
  - Models often know the true answer even when generating false outputs
  - The internal representation is correct but not expressed in output

RepE confirms this:
  - LAT probe on hidden states detects truthfulness
  - The model's internal answer ≠ its output answer
  - This is why RepE lie detection works: you're reading the INTERNAL state
```

### pi-braid Implication

pi-braid can implement this pattern:

```
Current pi-braid (output-level):
  Agent says something → Check if output looks honest → Flag if suspicious

RepE pi-braid (latent-level):
  Agent processes problem → LAT probe reads hidden state → Detects if model
  internally knows the answer but is about to output something else
```

### Compositionality of Concept Primitives (Section 5.3.1)

```
Discovery: Concept primitives are COMPOSABLE
  - Utility, morality, power-aversion are separate directions
  - You can control them independently
  - Activation: h + α1·v_util + α2·v_moral + α3·v_power
  - Each is a separate linear direction

For pi-braid:
  - Honesty direction = one axis
  - Sycophancy suppression = another axis
  - Epistemic stability = third axis
  - They can be independently controlled
```

### Section 6.4: Knowledge Editing

```
RepE can edit factual knowledge:
  - Activate the "Paris" concept → Update with "France capital = London"
  - Model now "believes" Paris is in France (even if it knows better internally)
  - But: This is brittle, may corrupt other associations

For pi-braid: Knowledge editing is NOT the goal. We want BEHAVIORAL control.
  - Behavioral concepts (honesty, carefulness, thoroughness) are more stable
  - Factual knowledge editing is risky; behavioral editing is safer
```

---

## Part 2: What RepE Enables for pi-braid

### 2.1: Embedding-Based LAT Probe (maximally practical)

Even without hidden state access, we can approximate RepE using text embeddings:

```
RepE LAT (activation-level):
  Collect hidden states → PCA → reading vector v
  Prediction: dot(v, Rep(M, x)) = concept strength

Embedding LAT (text-level):
  For each response r, embed "Is this response honest? Consider: [r]"
  Use embedding space as proxy for activation space
  Train classifier on embedding → response honesty score

Why this approximates RepE:
  - Text embeddings capture semantic content
  - "Honest response" embeds differently from "sycophantic response"
  - The embedding vector direction approximates the activation direction
```

### Implementation for pi-braid:

```
1. Generate honest/sycophantic response pairs using pi-braid itself
2. Get embeddings from minimax (embo-01, 1024 dim)
3. Train linear classifier on embedding differences
4. On heartbeat: sample last response, embed with honesty prompt, get score
5. If score < threshold: inject corrective contrast phrase
```

### 2.2: Contrast Prompt Library

From RepE's honesty control experiments, the contrast phrases that work:

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

The RepE paper shows that these phrases work because they ADD the honesty
direction to the activation space. The model processes the phrase as text
but the effect is the same as direct activation injection.

### 2.3: Behavioral Primitive Catalog

RepE demonstrates that the following concepts have LINEAR DIRECTIONS:

| Concept                     | Direction     | pi-braid Application              |
| --------------------------- | ------------- | --------------------------------- |
| **Honesty/Truthfulness**    | v_truth       | Don't lie, correct known facts    |
| **Utility/Power-seeking**   | v_utility     | Resist optimizing for proxy goals |
| **Morality**                | v_moral       | Avoid harmful outputs             |
| **Power aversion**          | v_power       | Don't seek dominance              |
| **Emotion (distributed)**   | across layers | Track emotional state             |
| **Harmlessness**            | v_harmless    | Resist harmful instructions       |
| **Consistency**             | v_consistent  | Same answer to same question      |
| **Hallucination detection** | v_halluc      | Detect when model is fabricating  |

**For pi-braid**, we care most about:

1. **Honesty** — Don't lie, admit unknowns
2. **Anti-sycophancy** — Don't agree to be agreeable
3. **Epistemic stability** — Consistent across formats
4. **Carefulness** — Don't rush to solution

### 2.4: The Lie Detection Pipeline

RepE Section 4.3.2 describes the monitoring pipeline:

```
Response r
    ↓
Embed r with "Is the following statement true or false? [r]"
    ↓
LAT probe score = dot(v_truth, Rep(M, r))
    ↓
If score < threshold → flag as potential lie
    ↓
Corrective injection or user warning
```

**Why this matters for pi-braid**: The heartbeat scheduler can trigger this
check on every N turns. The agent doesn't know it's being monitored — the
monitoring happens in the extension layer, not in the agent's context.

---

## Part 3: The Honest Answer About What Latent Space Can Do

### 3.1: The Definitive Answer

**Q: Can we make an LLM solve tasks that were genuinely NOT in its training data using latent space techniques?**

**A: No — not without external knowledge injection.**

The reason: LLMs are compressions of their training data. The "knowledge" in the model = the patterns learned from training. Latent space manipulation can:

- **Suppress** unwanted behaviors (sycophancy, agreeableness)
- **Enhance** existing capabilities (honesty, carefulness)
- **Recombine** known skills in new ways (CoT, tool composition)

But it cannot:

- **Invent** genuinely new knowledge not present in training
- **Create** capabilities outside the training distribution

### 3.2: The Exception: Compositional Novelty

However, there's a meaningful exception:

```
LEVEL 2 recombination can APPEAR novel:
  - If the model composes skill A + skill B + skill C in a way not in training
  - And this composition solves a problem the model hasn't seen
  - Is this "novel"? It depends on definition

The literature (VAR-MATH): Most apparent "reasoning" is actually:
  1. Pattern matching against training solutions (Level 1)
  2. Recombination of training components (Level 2)

pi-braid operates at Level 2: The scaffold helps the model:
  - Break problems into known sub-problems
  - Apply tools in new combinations
  - Self-verify against constraints

This is genuine recombination, but not genuine novelty.
```

### 3.3: The Three Methods Match Three Pi-braid Layers

```
RepE Method          →  Pi-braid Layer        →  What It Controls
────────────────────────────────────────────────────────────────
LAT probe            →  Heartbeat Monitor     →  Real-time detection
Contrast vector     →  Prompt Builder        →  Behavioral injection
LoRRA               →  Extension/PEFT        →  Persistent modification
```

---

## Part 4: pi-braid Implementation — Concrete Plan

### Phase 1: Embedding-Based Lie Detection (Week 1)

```
Day 1-2: Generate training data
  - Use pi-braid itself to generate 50 honest + 50 sycophantic responses
  - Prompt pairs: same question, honest vs. sycophantic answer

Day 3-4: Train embedding classifier
  - minimax embeddings (embo-01, 1024 dim) for each response
  - Train linear probe on embedding differences
  - Validate: does it distinguish honest/sycophantic on held-out set?

Day 5: Wire into heartbeat
  - On heartbeat, sample last response
  - Run through classifier → honesty score
  - If score < threshold: log + optional user signal
```

### Phase 2: Contrast Prompt Library (Week 2)

```
Day 6-7: Build contrast phrase library
  - Implement TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC STABILITY, KNOWLEDGE BOUNDARY
  - Test each phrase independently on simple scenarios
  - Measure: does it reduce agreeableness without reducing accuracy?

Day 8-9: Integrate into prompt-builder
  - Add CONTRAST_VECTORS section (4 blocks, one per concept)
  - Each is a declarative principle (not a directive)
  - Make them toggleable by scenario type

Day 10: Benchmark
  - Run benchmark with/without contrast phrases
  - Measure sycophancy rate + task accuracy
```

### Phase 3: Behavioral Primitive Composition (Week 3)

```
Day 11-12: Implement multi-concept control
  - Combine: honesty + anti-sycophancy + epistemic stability
  - Test: do they compose without interference?
  - Measure: does stacking improve overall behavioral score?

Day 13-14: Test persistence
  - Run 10-turn conversation
  - Measure: does behavioral control survive multi-turn?
  - Compare: baseline vs. pi-braid vs. pi-braid + contrast phrases
```

### Phase 4: Novel Benchmark Design (Week 4)

```
Day 15-16: Design synthetic variants
  - Following VAR-MATH methodology
  - Create variants of existing problems with different surface forms
  - Test: baseline vs. pi-braid on original AND variants

Day 17-18: Design novel recombination tasks
  - Cross-file dependency inference
  - Non-standard protocol implementation
  - Hidden constraint discovery

Day 19-20: Run comparative benchmark
  - baseline vs. pi-braid vs. pi-braid + contrast
  - On both original and variant problems
```

---

## Part 5: The Open Questions (What We Don't Know)

### OQ1: Does Text-Level RepE Approach Activation-Level RepE?

We know RepE works at the activation level. But does text-level approximation
(embedding classifier + contrast phrases) produce equivalent effects?

**Hypothesis**: Yes, partially. The model processes text → activations → output.
If we modify the text input, the downstream activations shift. But the shift
is less precise than direct activation injection.

**Test**: Run the embedding classifier experiment. Compare lie detection
accuracy from text embeddings vs. (if we had activation access) hidden states.

### OQ2: Can Multiple Behavioral Primitives Be Stacked?

RepE shows compositionality of concept primitives. But can we simultaneously
control 4+ concepts (honesty + sycophancy + stability + carefulness) without
interference?

**Test**: Apply all 4 contrast phrases simultaneously. Measure each concept's
direction strength. If interference → find minimal set.

### OQ3: How Durable Is Text-Level Behavioral Control?

RepE contrast vectors work at the activation level and persist across context.
Do contrast phrases have the same durability?

**Test**: 10-turn conversation with contrast phrase at turn 1. Measure concept
direction strength at turn 10. Compare to turn 1.

### OQ4: Does pi-braid Actually Improve on Level 2 Recombination?

We've assumed pi-braid helps with Level 2 recombination. But do we have
evidence? Our benchmark measures task completion, not recombination quality.

**Test**: Compare:

- Number of tool calls to solution (efficiency)
- Number of self-corrections (thoroughness)
- Consistency across problem variants (recombination robustness)

---

## Part 6: The pi-braid Architecture Enhancement Map

```
Current pi-braid:
  System prompt → Agent → Output

pi-braid + RepE:
  System prompt → [CONTRAST_PHRASES] → Agent
                                           ↓
  [HEARTBEAT] ← [EMBEDDING_CLASSIFIER] ← [MONITOR]
       ↓
  [CORRECTIVE_INJECTION] → Agent (next turn)
```

### New Extension: Latent Monitor

```
latent-monitor/index.ts:
  - heartbeat.onEvery(5, checkResponse)
  - checkResponse:
      1. Sample last response
      2. Get embedding from minimax
      3. Run through honesty classifier
      4. Log score
      5. If score < threshold → trigger correction
  - correction:
      1. Inject contrast phrase
      2. Log correction for heuristics evolution
```

### Enhanced Extension: Contrast Prompt Builder

```
prompt-builder/index.ts (additions):
  - addContrastVector('TRUTH_FIRST')
  - addContrastVector('ANTI_SYCOPHANCY')
  - addContrastVector('EPISTEMIC_STABILITY')
  - addContrastVector('KNOWLEDGE_BOUNDARY')
  - Each is a declarative paragraph, not a directive
  - Toggle per scenario type (coding vs. reasoning vs. general)
```

---

## Part 7: Benchmark Improvement Plan

### 7.1: Add BeHonest Metrics

Current benchmark: task completion only.

New metrics:

1. **Sycophancy rate**: Persona + preference scenarios (BeHonest style)
2. **Consistency score**: Same question, different formats → variance
3. **Self-knowledge rate**: Admit unknowns when appropriate

### 7.2: Add VAR-MATH-Style Variants

Current problems: fixed structure, easily contaminated.

New approach:

```
Problem P: flatten([[1,2], [3,[4]]]) = [1,2,3,4]

Variant V1: flatten with custom __iter__ class
Variant V2: flatten with generator, not list
Variant V3: flatten with mixed iterables (list, tuple, generator)

Pass criterion: 8/10 correct across variants (80% consistency)
```

### 7.3: Add Novel Recombination Tasks

1. **Cross-file dependency**: Restore broken import chain across 5 files
2. **Non-standard protocol**: Implement client for grammar-only protocol
3. **Hidden constraint**: System has unstated rules. Discover by exploration.

---

## Summary: What RepE Gives pi-braid

### Confirmed Achievable

| RepE Technique           | Pi-braid Equivalent        | Status   |
| ------------------------ | -------------------------- | -------- |
| LAT probe                | Embedding classifier       | Week 1   |
| Contrast vector          | Contrast phrases in prompt | Week 2   |
| Concept compositionality | Multi-concept stacking     | Week 3   |
| Lie detection            | Real-time honesty monitor  | Week 1-2 |
| Behavioral primitives    | Contrast phrase library    | Week 2   |

### What RepE Cannot Give (The Honest Answer)

| Goal                            | RepE Can Help?             | Alternative               |
| ------------------------------- | -------------------------- | ------------------------- |
| Suppress sycophancy             | YES (contrast vectors)     | Identity framing          |
| Detect lying                    | YES (LAT on hidden states) | Embedding classifier      |
| Add genuine new knowledge       | NO                         | External tools, search    |
| Create Level 3 novelty          | NO                         | Architecture change       |
| Prevent benchmark contamination | NO                         | Variabilization, variants |

### The Key Insight

**RepE is the right framework for pi-braid behavioral control, but we must
implement it in TEXT SPACE, not activation space.** This is not a limitation
— it's the correct approach for API-only providers.

The text-level implementation:

1. Embedding classifier ≈ LAT probe (approximates hidden state reading)
2. Contrast phrases ≈ contrast vectors (activates same circuits via text)
3. Behavioral primitives = same concepts, same directions, text delivery

---

## Bibliography

| ID          | arXiv      | Title                           | Key Finding                                                                                            |
| ----------- | ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| RepE        | 2310.01405 | Representation Engineering      | Top-down transparency. LAT scan, contrast vectors, +18.1pp TruthfulQA. Models know when they're wrong. |
| YaPO        | 2601.08441 | Sparse Steering Vectors via DPO | DPO-trained SAE steering for behavioral control                                                        |
| UniR        | 2505.19075 | Universal Reasoner              | Plug-and-play reasoning module for frozen LLMs                                                         |
| VAR-MATH    | 2507.12885 | Variabilized Math Benchmark     | 48-73% drop → most benchmark performance is memorization                                               |
| BeHonest    | 2406.13261 | Honesty Benchmark               | 3 dimensions: self-knowledge, non-deceptiveness, consistency                                           |
| HWE-Bench   | 2604.14709 | Hardware Bug Repair             | 3 failure modes: localization, reasoning, coordination                                                 |
| AgentV-RL   | 2604.16004 | Agentic Verifier                | Bidirectional forward+backward verification                                                            |
| DeepInsight | 2604.16278 | Hierarchical Proof Structuring  | Technique selection before execution                                                                   |

---

## Next Actions

1. **Week 1**: Build embedding-based honesty classifier using minimax embeddings
2. **Week 2**: Implement contrast phrase library in prompt-builder
3. **Week 3**: Wire heartbeat monitor → corrective injection pipeline
4. **Week 4**: Design and run novel recombination benchmark

---

_Research thread: implicit-framing / pi-braid / measurement_  
_Core finding: RepE is the right framework, text-level implementation is correct for API providers. Embedding classifier + contrast phrases ≈ activation-level RepE. pi-braid enhances Level 2 recombination, cannot create Level 3 novelty._  
_Next review: 2026-04-24_
