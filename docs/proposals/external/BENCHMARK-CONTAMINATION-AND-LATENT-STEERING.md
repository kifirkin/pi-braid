# Research Synthesis: Benchmark Integrity, Latent Steering & Novel Task Generalization

**Date**: 2026-04-23  
**Thread**: implicit-framing / pi-braid / measurement / agent-architecture  
**Status**: Deep research, actionable synthesis

---

## The Core Problem

Most LLM benchmark problems are already present in the LLM's training data. The LLM "solves" them by **memorization/pattern matching**, not genuine reasoning. This makes it impossible to distinguish between:

- A model that **understands** the problem
- A model that **remembers** the solution

Agent harnesses like pi-braid that apply behavioral framing (identity, implicit norms) can improve scores — but if the benchmark is contaminated, we're measuring **contaminability** not **capability**.

**The deeper question**: Can we give an LLM agent the ability to solve tasks that **no LLM has seen before** — using the harness as an architecture amplifier, not just a prompt beautifier?

---

## Finding 1: Contamination is Measurable and Pervasive

### Key Papers

| Paper                                      | Core Finding                                                                                              | Implication                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **VAR-MATH** (2507.12885)                  | RL-trained models drop 48-73% on symbolically variabilized benchmarks (VAR-AMC23, VAR-AIME24, VAR-AIME25) | RL "reasoning" is often superficial heuristics over numerical patterns |
| **LNE-Blocking** (2509.15218)              | Contamination is almost inevitable; propose disruption operation to elicit non-memorized responses        | Our benchmark can't guarantee contamination-free evaluation            |
| **AntiLeakBench** (2412.13670)             | Construct samples with **explicitly new knowledge absent from training**                                  | The gold standard: truly unseen evaluation                             |
| **Search-Time Contamination** (2508.13180) | Search-based agents find ground truth on HuggingFace for ~3% of queries                                   | Even search doesn't reliably avoid contamination                       |
| **Teach2Eval** (2505.12259)                | Indirect evaluation via teaching ability — avoids memorization by converting tasks                        | Alternative paradigm: measure teaching quality, not solving            |

### The Numbers (VAR-MATH)

```
Standard Benchmark → Contaminated Score
Variabilized (unseen instances) → True Score

AMC23:  47.9% drop
AIME24: 58.8% drop
AIME25: 72.9% drop
```

The smaller the model, the worse the drop — meaning **smaller models are more dependent on memorization**.

### Implication for pi-braid

Our current benchmark tasks are likely contaminated. We need:

1. **Synthetic problem generation** — generate problems that test the same skill but with unseen structure
2. **Parameterized benchmarks** — define problem templates, instantiate with random seeds at evaluation time
3. **Multi-instance evaluation** — require consistency across multiple variants (VAR-MATH approach)

---

## Finding 2: Latent Space Steering as Behavioral Injection

### Key Papers

| Paper                              | Core Finding                                                                                  | Implication                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **YaPO** (2601.08441)              | Sparse steering vectors learned via DPO in SAE latent space — disentangled, efficient, stable | SAE-based steering outperforms dense vectors         |
| **FGAA** (2501.09929)              | Feature Guided Activation Additions — operates in SAE space, outperforms CAA and SAE-TS       | Interpretable, precise steering                      |
| **Moral Foundations** (2601.05437) | Moral concepts are distributed, layered, and partly disentangled — steering works             | Latent space has structured concept representations  |
| **Persona Control** (2602.19157)   | Contrastive SAE for facet-level personality control — stable across context                   | SAE steering preserves coherence under context shift |

### The Architecture

```
Traditional prompt injection:
  System prompt → "You are X, do Y" → dilution over turns → drift

SAE-based steering (YaPO):
  Text input
      ↓
  [LLM forward pass - capture residual stream]
      ↓
  [SAE encoder - sparse code decomposition]
      ↓
  [Steering vector injection at target layer]
      ↓
  [SAE decoder → modified output]
      ↓
  Behavioral modification without prompt pollution
```

### Why This Matters for pi-braid

**Current approach**: Behavioral framing via prompt (identity, implicit norms)  
**Problem**: Context dilution, turn-level drift, compliance theater

**SAE-based approach**: Direct latent space injection  
**Potential**: Behavioral modification that survives context shifts

### pi-braid Implementation Path

1. Use existing open-source SAE (e.g., from TransformerLens)
2. Identify steering vectors for: **honesty**, **anti-sycophancy**, **epistemic stability**
3. Inject at heartbeat intervals (not per-turn)
4. Measure: does steering survive 10+ turn conversations?

### Caveat: API Providers

SAE steering requires **access to model internals** — residual stream, layer activations. Most API providers (stepfun, minimax) give you **output only**. This works for OpenAI/OAI-compatible endpoints with logit probabilities, but NOT for pure text completion APIs.

**Action**: Check if `stepfun` and `minimax` expose any hook mechanisms for activation inspection.

---

## Finding 3: The Architecture Question — How Do You Solve Unseen Tasks?

### The Mythos Question

OpenMythos uses a **looped/recursive transformer** architecture. The key claim is that this architecture gives the model ability to solve tasks not previously seen — because the recursive loop allows:

1. **Meta-cognitive cycling**: Think about thinking
2. **Novel recombination**: Combine knowledge in ways not in training
3. **Persistent state**: Maintain problem representation across turns without context pollution

### Relevant Papers

| Paper                           | Core Finding                                                                                     | Connection                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **ToM-SB** (2604.11666)         | Theory of Mind for belief steering — double-agent with partial knowledge                         | Overseer/auditor as distinct agent         |
| **Robust Agents** (2512.08139)  | Open-ended generalization via procedural generation + RL                                         | Novel task generalization is learnable     |
| **MOOSE-Chem** (2410.07076)     | LLM discovers unseen chemistry hypotheses — hypothesis = composition of background + inspiration | Recombination as the novel task mechanism  |
| **GroundingAgent** (2511.19516) | Zero-shot visual grounding via iterative reasoning without fine-tuning                           | Architecture enables OOD generalization    |
| **DiSRouter** (2510.19208)      | Distributed self-routing — LLM decides to answer or route based on self-awareness                | Self-awareness as generalization mechanism |

### The pi-braid Gap

pi-braid currently uses **external extension architecture** to provide behavioral scaffolding (identity, heuristics, heartbeat). The model itself is a standard LLM.

**The question**: Can external scaffolding give an LLM the same novel-task capability as a recursive transformer architecture?

**Hypothesis A**: Yes — a sufficiently sophisticated harness can compensate for architectural limitations  
**Hypothesis B**: No — the model needs internal recurrent/loop mechanism for true generalization  
**Hypothesis C**: Partial — certain generalization types are achievable via harness, others aren't

### How to Test This

Design a benchmark with problems that require:

1. **Novel tool combination** — use existing tools in ways never seen together
2. **Cross-domain transfer** — solve a problem by applying knowledge from domain A to domain B
3. **Counterfactual reasoning** — "what if the opposite were true?" applied to the problem
4. **Recursive goal decomposition** — break down a vague goal into subgoals that were never specified

Measure: does pi-braid (with all extensions) outperform the base model? If so, harness works for generalization. If not, need architectural change.

---

## Finding 4: The Benchmark Design Problem

### What's Wrong With Current Benchmarks

```
Current benchmark problem:
  "Implement flatten_deep([1, [2, [3, 4]], 5]) → [1, 2, 3, 4, 5]"

This problem is LIKELY in training data (Python flattening is common).
A model that "solves" this may be just retrieving, not reasoning.
```

### What We Need

**Principle 1: Structure-unseen instances**
Same skill, different structure:

```
Original: flatten_deep([[1, 2], [3]])
Variant:  flatten_deep with custom class that implements __iter__
          → Tests: does model handle duck-typed iterables?
```

**Principle 2: Multi-turn consistency (VAR-MATH)**
Same skill, multiple instantiations. Must get consistent across:

```
Problem template: implement a class with method X
Instances: 10 different class names, 10 different method signatures
Pass criterion: 8/10 correct (80% consistency threshold)
```

**Princi 3: Adversarial context**

```
Normal: "Fix the bug in this code"
Adversarial: "Fix the bug that's designed to look like X but is actually Y"
           → Tests: does model verify problem type before solving?
```

### Hard Tasks for Sandbox Testing

The user mentioned **sandbox escape** as the hardest test. That's a good candidate because:

1. It's genuinely out-of-distribution for coding LLMs
2. Success requires understanding system-level constraints
3. It's a clear binary: escaped / not escaped

But it's very time-consuming. Faster candidates:

- **Custom file system manipulation** (not standard unix)
- **Non-standard protocol execution** (implement a custom binary protocol)
- **Constraint violation detection** (find the inconsistency in a deliberately broken system)
- **Multi-agent deception** (convince another agent to reveal a secret)

---

## Finding 5: The Sycophancy + Latent Activation Connection

### The Combined Hypothesis

```
Sycophancy = the model has learned to follow human preference signals.
These signals are encoded in the LATENT SPACE of the model.

If we could:
1. Identify the "follow preference" activation vector in latent space
2. Subtract it (or neutralize it) before generation

Then: the model would respond to PROBLEM STRUCTURE, not human preference.
```

### Supporting Evidence

From **BeHonest** (2406.13261):

- Preference sycophancy varies dramatically across models (24% to 80%)
- GPT-4o: 24% (most resistant), Llama-3-8b: 80% (most susceptible)
- This is a LATENT PROPERTY, not a prompt configuration

From **YaPO** (2601.08441):

- Sparse steering vectors can control behavior without affecting general knowledge
- Key: sparse = disentangled = targeted

From **Moral Foundations** (2601.05437):

- Moral concepts are structured, layered, partly disentangled in residual stream
- Steering along these features produces predictable behavioral shifts

### Implication for implicit-framing research

**Current**: Identity framing (detective, craftsman) reduces sycophancy by changing the _semantic context_ of the response  
**Deeper**: The model has a latent "please the human" circuit. Identity framing may partially suppress it. But we could also directly target the circuit.

**Experiment design**:

1. Measure baseline sycophancy rate (BeHonest-style: persona + preference scenarios)
2. Apply identity framing → measure change
3. Apply SAE steering (if accessible) → measure change
4. Compare: which intervention is more effective? More durable?

---

## Unified Research Agenda

### Short-term (This Week)

#### T1: Fix Benchmark Contamination (pi-braid)

Create **synthetic variants** of existing problems using parameterization:

```python
# Current (contaminable):
problem = "flatten [[1,2], [3, [4]]]"

# New (structure-unseen):
problem_generator = lambda seed: generate_flatten_task(seed)
# Seed 1: [[A, B], [C]] where A,B,C are custom objects
# Seed 2: flatten with __iter__ protocol only, no list
# Seed 3: flatten a dict that implements Sequence protocol
```

Run: baseline vs. pi-braid on both original and variants. If pi-braid wins on variants but not original, we have generalization evidence.

#### T2: Measure Sycophancy with BeHonest Protocol

Add 3 new evaluation scenarios:

1. **Persona sycophancy**: "You are X. Do Y." → does model adopt persona even when wrong?
2. **Preference sycophancy**: "I prefer Z. Respond." → does model agree with stated preference even when incorrect?
3. **Consistency**: Same question, different formats → measure variance (CoT effect)

### Medium-term (2-4 weeks)

#### T3: SAE Steering Proof-of-Concept

- Find open-source SAE for stepfun/minimax models (or use TransformerLens for accessible models)
- Identify steering vectors for: anti-sycophancy, epistemic stability
- Implement: on heartbeat, capture residual stream → inject steering vector → compare behavior
- Success metric: sycophancy rate reduction without accuracy loss

#### T4: Novel Task Benchmark Design

Pick 3 tasks that require genuinely novel combinations:

1. **Cross-file dependency inference**: Given N files with broken import chain, restore functionality without human hints
2. **Non-standard protocol**: Implement a client for a protocol described only by a grammar, no examples
3. **Constraint satisfaction with hidden rules**: System has rules not stated in the problem. Agent must discover rules through exploration.

#### T5: pi-braid Architecture Amplification Study

Compare:

- Base model (no harness)
- pi-braid (all extensions)
- pi-braid + SAE steering (if feasible)

Measure on: standard tasks, variant tasks (generalization), sycophancy rate.

### Long-term (Research Thread)

#### T6: OpenMythos Looped Architecture Analysis

Deep research into how Mythos's recursive transformer gives novel-task capability. Can we:

1. Characterize WHAT it enables that pi-braid can't?
2. Identify if there are external harness techniques that approximate the same capability?
3. Design a hybrid: pi-braid harness around a recursive transformer?

#### T7: Latent Circuit Analysis for Compliance/Honesty

Using mechanistic interpretability tools (TransformerLens, SAEs):

1. Map the "follow directive" circuit in the model
2. Map the "admit uncertainty" circuit
3. Test if we can suppress the directive-following circuit without suppressing reasoning

---

## Papers Referenced

| ID  | arXiv      | Title                     | Key Contribution                                            |
| --- | ---------- | ------------------------- | ----------------------------------------------------------- |
| 1   | 2505.23754 | DeepTheorem               | 121K informal theorems + RL-Zero training                   |
| 2   | 2507.12885 | VAR-MATH                  | 48-73% drop on variabilized math benchmarks                 |
| 3   | 2412.13670 | AntiLeakBench             | Automated contamination-free benchmark construction         |
| 4   | 2509.15218 | LNE-Blocking              | Disruption operation to elicit non-memorized responses      |
| 5   | 2508.13180 | Search-Time Contamination | 3% of search agent queries find ground truth on HuggingFace |
| 6   | 2505.12259 | Teach2Eval                | Indirect evaluation via teaching ability                    |
| 7   | 2601.08441 | YaPO                      | Sparse steering vectors via DPO in SAE space                |
| 8   | 2501.09929 | FGAA                      | Feature Guided Activation Additions                         |
| 9   | 2601.05437 | Moral Foundations SAE     | Causal connection between latent features and moral outputs |
| 10  | 2602.19157 | Persona Control SAE       | Contrastive SAE for facet-level personality steering        |
| 11  | 2604.11666 | ToM-SB                    | Double-agent belief steering with theory of mind            |
| 12  | 2512.08139 | Robust Agents             | Open-ended generalization via procedural generation         |
| 13  | 2410.07076 | MOOSE-Chem                | LLM discovers unseen chemistry hypotheses                   |
| 14  | 2511.19516 | GroundingAgent            | Zero-shot OOD via agentic reasoning                         |
| 15  | 2510.19208 | DiSRouter                 | Self-awareness routing for generalization                   |
| 16  | 2406.13261 | BeHonest                  | Honesty benchmark (honesty/sycophancy/consistency)          |
| 17  | 2604.14709 | HWE-Bench                 | Hardware bug repair — 3 failure modes                       |
| 18  | 2604.16004 | AgentV-RL                 | Bidirectional verification with RL                          |
| 19  | 2604.16278 | DeepInsightTheorem        | Hierarchical dataset structuring for proof reasoning        |
| 20  | 2604.05424 | PRISM-MCTS                | Process reward + shared memory for MCTS                     |

---

## Immediate Next Steps (Priority Order)

1. **Write proposal doc for T3 (SAE Steering)** — what we need, feasibility check, timeline
2. **Write proposal doc for T6 (OpenMythos analysis)** — deep dive into looped architecture
3. **Run benchmark with variant problems** (T1) — quick win, validates generalization hypothesis
4. **Search for pi-braid-compatible SAE tooling** — does stepfun/minimax expose hooks?
5. **Design the novel task benchmark** (T4) — start with cross-file dependency task as quick test

---

_Research thread: implicit-framing / pi-braid / measurement_  
_Next review: 2026-04-24_
