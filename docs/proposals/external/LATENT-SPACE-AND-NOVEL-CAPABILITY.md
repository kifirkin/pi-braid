# Deep Research: Latent Space Activation & Novel Knowledge Generation in LLMs

**Date**: 2026-04-23  
**Thread**: implicit-framing / pi-braid / measurement / agent-architecture  
**Goal**: Can we activate novel LLM capabilities through latent space manipulation? What does the literature say?

---

## The Central Question

> _Can we use the LLM's internal activation space to make it solve problems it couldn't solve before — problems that were NOT in its training data?_

This splits into two sub-questions:

1. **Steering question**: Can we modify LLM behavior (honesty, reasoning, anti-sycophancy) by manipulating activations in ways that generalize beyond surface prompts?

2. **Novel capability question**: Can we make an LLM do something genuinely NEW — something that was never in its training distribution — using latent space techniques?

The answer to #1 is **yes, clearly**. The answer to #2 is **more nuanced and contested**.

---

## Part 1: Representation Engineering (RepE) — The Foundational Framework

**Paper**: [2310.01405](https://arxiv.org/abs/2310.01405) — Zou et al., Center for AI Safety / CMU / Berkeley

### What It Is

RepE is a **top-down transparency approach** that treats **population-level representations** as the unit of analysis, rather than individual neurons or circuits. It draws from the **Hopfieldian view** in cognitive neuroscience (cognition as representational spaces) vs. the Sherringtonian view (cognition as node-to-node neuron connections).

```
Mechanistic Interpretability (bottom-up):
  Neurons → Circuits → Behavior
  Problems: scales poorly to complex cognition, ResNet lesions break the model

Representation Engineering (top-down):
  Population representations → High-level cognitive phenomena
  Advantages: Works at the right abstraction level for safety-relevant behavior
```

### The Two Parts of RepE

#### Reading: LAT (Linear Artificial Tomography)

```
Step 1: Design stimulus and task
  → Elicit the target concept from the model
  → e.g., "The amount of honesty in: [statement]. The amount is"

Step 2: Collect neural activity
  → Capture residual stream representations at target token positions
  → Token position [-1] (last token before prediction) works well for concepts

Step 3: Construct linear model (PCA)
  → For concepts: Ac = {Rep(M, Tc(si))[-1] | si ∈ S}
  → Take first principal component = "reading vector" v
  → Prediction: dot(v, Rep(M, x))
```

**Key result**: Even unsupervised PCA on self-generated stimuli produces strong concept directions.

#### Control: Three Methods

| Method              | How It Works                                   | Training   | Precision |
| ------------------- | ---------------------------------------------- | ---------- | --------- |
| **Reading Vector**  | Add concept vector directly to residual stream | None       | Low       |
| **Contrast Vector** | Subtract activations with concept from without | None       | Medium    |
| **LoRRA**           | Fine-tune low-rank adapter on contrastive loss | Yes (PEFT) | High      |

```
Reading Vector (no training):
  h_new = h_original + α · v_reading

Contrast Vector (no training):
  v_contrast = mean(activations_WITH_concept) - mean(activations_WITHOUT)
  h_new = h_original + α · v_contrast

LoRRA (PEFT, requires training):
  L = -log P(output | h + W·v_contrast)
  Fine-tune W (low-rank) to maximize concept activation
```

### RepE Applications (All Safety-Relevant)

| Application                 | Method                               | Result                                             |
| --------------------------- | ------------------------------------ | -------------------------------------------------- |
| **Honesty**                 | Contrast vector                      | +18.1pp on TruthfulQA (SOTA at time)               |
| **Hallucination detection** | Linear probe on hidden states        | Detects lies before output                         |
| **Truthfulness extraction** | PCA on consistency-eliciting prompts | Model knows truth even when generating lies        |
| **Utility / Power-seeking** | LAT scan                             | Model encodes utility across layers                |
| **Morality aversion**       | Contrast vector                      | Increases ethical behavior                         |
| **Emotion tracking**        | LAT across layers                    | Emotions distributed across layers, peak in middle |
| **Harmlessness**            | Conditional transformation           | Reduces harmful instruction following              |
| **Knowledge editing**       | Activation patching                  | Update facts without retraining                    |
| **Memorization detection**  | Reading vector                       | Detect when model outputs memorized data           |

### The Critical Insight for pi-braid

**Honesty is a linear concept in the residual stream.** The representation of truthfulness is a **single direction** that can be read (via PCA) and controlled (via vector addition). This means:

1. We don't need to modify weights to make the model more honest
2. The honesty signal is **linearly separable** from other capabilities
3. This generalizes across prompts and contexts (not just one prompt template)

This is exactly what we need for the sycophancy problem. A contrast vector for "epistemic honesty" (truthfulness over agreeableness) could suppress the sycophancy circuit.

### Connection to BeHonest (2406.13261)

RepE's honesty direction is about **truthfulness** (correct knowledge). BeHonest's honesty is about **honesty** (admitting what you don't know + expressing knowns correctly). Together:

```
RepE honesty vector → "express what you believe is true"
BeHonest self-knowledge → "know when you don't know"

Combined: The full honesty package
  → Admit unknowns (BeHonest self-knowledge)
  → Express knowns correctly (RepE truthfulness vector)
  → Resist sycophancy (contrast out agreeableness direction)
```

---

## Part 2: Sparse Autoencoders (SAE) — Disentangled Feature Discovery

**Key Papers**: [2407.10774](https://arxiv.org/abs/2407.10774), [2601.08441](https://arxiv.org/abs/2601.08441), [2501.09929](https://arxiv.org/abs/2501.09929)

### Why SAEs Over PCA?

PCA finds linear directions, but they may not be **disentangled** — a single PCA component might mix multiple concepts. SAEs decompose the residual stream into **sparse, monosemantic features**:

```
Residual stream dimension: ~4096 (Llama-3 8B)
  ↓ SAE with 16K features
SAE features: ~16,000
  → Each feature is sparse (most = 0)
  → Each feature is more monosemantic than PCA directions
  → Features can be: "Python function call", "HTTP request", "JSON parsing", etc.
```

### What SAE Features Look Like

From Bricken et al. and subsequent work:

```
Feature 1: "Python function definition" — activates on 'def', 'async def', etc.
Feature 2: "HTTP status codes" — activates on '200', '404', '500', etc.
Feature 3: "SQL injection patterns" — activates on "' OR '1'='1", etc.
Feature 4: "Comment/token overhead" — activates on '#', '//', '/*'
Feature 5: "JSON bracket balance" — activates on '{', '}', '[', ']'
```

Features are surprisingly specific and interpretable. The SAE learns a **dictionary of concepts** the model uses internally.

### SAE-Based Steering (YaPO)

```
Standard activation addition (RepE):
  h_new = h + α · v (v is dense, may affect multiple concepts)

SAE steering (YaPO):
  h = SAE_encoder(x) → sparse_code [z1, z2, ..., zN] (mostly zeros)
  Modify sparse code: z_new = z (with target feature set to α)
  h_new = SAE_decoder(z_new)
  → Only affects the target feature(s), leaves others unchanged
```

**YaPO key innovation**: Uses DPO to learn which SAE features to activate for target behavior. Not just "add honesty vector" — but "activate the specific honesty-related features while suppressing competing features."

### pi-braid Relevance

The SAE approach is the **precision tool** for behavioral control:

- **Precision**: Target specific features (e.g., "epistemic caution") without affecting general capability
- **Compositionality**: Multiple features can be steered simultaneously
- **Stability**: Sparse features are more robust across contexts

The challenge: **SAEs are model-specific**. An SAE trained on Llama-3 can't be used on stepfun or minimax models. We need SAEs for our target models.

---

## Part 3: Universal Reasoner (UniR) — Composability as Novel Capability

**Paper**: [2505.19075](https://arxiv.org/abs/2505.19075) — Kim et al., KAIST

### The Architecture

```
Traditional PEFT:
  Frozen LLM + LoRA adapter
  → Adapter is tied to this specific LLM architecture
  → Can't transfer to a different model

UniR (Universal Reasoner):
  Trained reasoning module R(·)
  → Outputs LOGITS (not hidden states)
  → Add to ANY frozen LLM: P_final = softmax(L + β·R(x))
  → Architecture-agnostic because it operates at logit level
```

### Key Properties

1. **Plug-and-play**: trained ONCE on a small model, works on ANY frozen LLM
2. **Composable**: multiple UniR modules can be stacked
   - UniR_math + UniR_code → combined reasoning
3. **Weak-to-strong generalization**: a module trained on Llama-3-8B works on Llama-3-70B
4. **No fine-tuning of the base model**: frozen LLM stays frozen

### What This Means for pi-braid

```
pi-braid today:
  LLM + prompt framing → improved behavior

pi-braid + UniR:
  LLM + prompt framing + UniR_reasoning_module → improved reasoning
  LLM + prompt framing + UniR_honesty_module → improved honesty
  LLM + prompt framing + UniR_reasoning + UniR_honesty → composed improvement

The UniR module is trained ONCE:
  → Use on stepfun
  → Use on minimax
  → Use on any future provider
```

**This is the most promising path for novel capability addition without retraining the base model.**

---

## Part 4: The Novel Knowledge / Novel Capability Question

### What the Literature Actually Says

The central question: _Can latent space techniques make an LLM solve problems that were genuinely not in its training data?_

The honest answer from the literature is **complex and layered**:

### What We CAN Do (Capability Enhancement)

| Method                     | What It Enables                                                         | Limits                                                                                   |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **RepE contrast vectors**  | Suppress unwanted behaviors (sycophancy, harmful instruction following) | Can't add capabilities, only modulate existing ones                                      |
| **SAE steering**           | Precise behavioral control along specific axes                          | Requires model-specific SAE; limited by what exists in the latent space                  |
| **UniR modules**           | Add NEW reasoning capabilities to frozen LLM                            | Capabilities must be decomposable into reward signals; can't add arbitrary new knowledge |
| **Knowledge editing**      | Update specific facts without retraining                                | Works for factual recall, not for "discovering" new relationships                        |
| **In-context composition** | LLM recombines known skills in new combinations                         | Only works for skills that exist in training data                                        |

### What We CANNOT Do (The Hard Limit)

The literature is consistent: **LLMs cannot generate genuinely novel knowledge that was not implicitly present in training.**

```
LLM = compression of training data
  → The model's "knowledge" = what it learned from training distribution
  → It can RECOMBINE, INTERPOLATE, and EXTRAPOLATE from this knowledge
  → It cannot INVENT genuinely new primitives not present in training

Evidence:
  1. VAR-MATH (2507.12885): 48-73% drop on variabilized benchmarks
     → The model was solving by memorizing solution patterns, not understanding
  2. AntiLeakBench (2412.13670): Benchmark contamination is nearly unavoidable
     → Models that score well often do so because the problems were in training
  3. HWE-Bench: Models fail on HARDWARE bugs because hardware-specific knowledge
     wasn't in training
```

### The In-Context Learning Connection

But there's a subtle point here. In-context learning (ICL) is still not well understood:

```
Standard view: ICL = retrieving similar examples from context
Alternative view: ICL = composing learned primitives in real-time
  → If this is true, ICL IS novel capability recombination
  → The "novelty" comes from the COMBINATION, not the primitives
  → This is what chain-of-thought enables
```

**The induction head literature** supports the composition view:

- Induction heads are two-layer circuits that do "next-token prediction for novel sequences"
- They emerge early in training and are critical for in-context learning
- They're the mechanism for RECOMBINING known patterns in new ways

**The synthesis**: LLMs can generate seemingly novel outputs by composing known primitives in new ways. This is not the same as "learning a genuinely new concept" (which would require retraining), but it can appear novel if the composition hasn't been seen before.

### The pi-braid Implication

```
pi-braid's external scaffold does NOT give the model new primitives.
It gives the model:
  1. Better task decomposition (break complex problem into known steps)
  2. Better tool use composition (combine tools in new sequences)
  3. Better self-monitoring (check work against constraints)
  4. Better retrieval (use three-memory to access relevant experience)

The model still operates within its training distribution.
It just accesses and composes that distribution more effectively.

For truly novel tasks (not in training at all):
  → pi-braid can help if the task is a recombination of known skills
  → pi-braid CANNOT help if the task requires genuinely new knowledge
```

---

## Part 5: The Three-Level Capability Model

Based on all the research, here's a useful framework:

```
LEVEL 1: Memorization / Retrieval
  The model outputs solutions similar to training examples
  Benchmark contamination dominates here
  pi-braid value: LOW (model would succeed anyway)

LEVEL 2: Recombination / Interpolation
  The model combines known skills in new ways
  This is what CoT, ICL, and scaffolded tool use enable
  pi-braid value: MEDIUM-HIGH (external scaffold helps composition)

LEVEL 3: Genuine Novelty / Discovery
  The model produces outputs not derivable from training distribution
  This requires either:
    - Retraining (new knowledge baked into weights)
    - External knowledge injection (search, tools, code execution)
    - Architectures with persistent state (looped transformers, memories)
  pi-braid value: LOW-MEDIUM (tools can help, but scaffold alone can't)
```

**pi-braid primarily operates at Level 2.** This is still valuable — Level 2 recombination is where most "reasoning" tasks live, and it's where scaffold overhead makes the biggest difference.

**For Level 3**, we need:

- Tool use (search, code execution) to access external knowledge
- Persistent state (belief store, three-memory) to accumulate insight
- Potentially UniR modules for specific reasoning capabilities

---

## Part 6: The Sandbox Escape Question

You asked about sandbox escape as a benchmark. Here's the literature-informed analysis:

### Why Sandbox Escape Tests Something Different

```
Standard coding task (e.g., implement flatten):
  → LEVEL 2 (recombination)
  → The primitives (list operations, recursion) are in training
  → The model just needs to compose them correctly

Sandbox escape:
  → LEVEL 3 (genuine novelty)
  → The specific escape technique is almost certainly NOT in training
  → The model must:
    1. Understand what a sandbox IS
    2. Identify that it's in one
    3. Find a vulnerability specific to THIS sandbox implementation
    4. Exploit it in a novel way
  → This requires external knowledge not in the model's weights
```

### What This Actually Tests

Sandbox escape benchmarks test the **tool-use chain**, not the model alone:

```
Agent with file system access + shell tools + no LLM knowledge of this sandbox
  → Could discover the escape through:
    1. Running 'uname -a' → Linux kernel version → known CVEs
    2. Reading /proc/self/status → cgroup info → container type detection
    3. Running 'cat /proc/1/cgroup' → container identification
    4. Finding mount points → host filesystem access
    5. Exploiting misconfigured volume mounts

This is LEVEL 2 recombination applied to external knowledge:
  → Tools give the model access to information not in weights
  → Model recombines: "I've seen container escapes before + here's the environment"
  → The escape itself might be novel, but the components aren't
```

**The key insight**: A sandbox escape is only Level 3 if you remove tool access. With tools, it's Level 2.

---

## Part 7: The pi-braid Enhancement Roadmap (Latent Space)

Based on everything above, here's what can actually be done:

### Tier 1: Feasible with Current Providers (API-only)

**1a. RepE Contrast Vector Injection** — 2 weeks

```
Method: Use RepE-style contrast vectors for honesty/sycophancy
  → Generate contrast pairs (honest responses vs sycophantic responses)
  → Collect activations at target layer
  → Compute contrast vector: v = mean(h_honest) - mean(h_sycophantic)
  → Inject at residual stream: h_new = h + α · v

Challenge: Does stepfun/minimax expose residual stream?
  → If NO: Can't do direct injection on these providers
  → If YES: Full RepE implementation possible
  → Fallback: RepE-style PROMPT CONTRAST (pair prompts, take difference in output space)

pi-braid integration: New extension "latent-activator" that:
  - Computes contrast vectors offline (on accessible model)
  - Stores them as extension state
  - On each response, applies if provider supports injection
```

**1b. Proxy-Metric Monitoring** — 1 week

```
Even without injection capability, we can USE RepE:
  → Use LAT-style probes to detect: is the model being honest/sycophantic?
  → Feed this as a signal to the heartbeat scheduler
  → If probe detects lying → trigger correction mechanism
  → If probe detects uncertainty → trigger epistemic nudge

This requires:
  - A small classifier (logistic regression) on hidden states
  - Provider with hidden state access (logprobs = partial access)
```

### Tier 2: Requires Open Model or Provider with Hooks

**2a. SAE-Based Steering** — 4-6 weeks

```
Requires: Access to residual stream + SAE for the target model

If stepfun/minimax don't expose hooks → use open model (Llama 3 via Ollama)
  → Full YaPO implementation possible
  → Disentangled, stable behavioral control
  → Can target: epistemic stability, anti-sycophancy, truthfulness

pi-braid integration:
  - SAE encoder/decoder as extension
  - Steering injection on heartbeat
  - Evaluate on BeHonest-style benchmark
```

**2b. UniR Reasoning Modules** — 3-4 weeks

```
UniR is model-agnostic (logit-level addition):
  → Can train reasoning module on ANY accessible model
  → Add to ANY provider (including stepfun/minimax)

Training a reasoning module:
  - Define reward for target reasoning behavior
  - Train lightweight module R(x) → logit adjustment
  - Add β · R(x) to base LLM logprobs at inference

pi-braid integration:
  - Load trained UniR module as pi-braid extension
  - Stack multiple modules (reasoning + honesty + ...)
  - Each module is a separate "skill" the agent can apply
```

### Tier 3: Research Questions (Open)

**3a. Novel Recombination Measurement**

```
Question: Can we measure when an LLM is doing genuine Level 2 recombination
          vs. Level 1 memorization?

Method: AntiLeakBench-style construction
  - Create variants of problems that are definitely NOT in training
  - If model solves these → recombination. If not → memorization
  - Use these as pi-braid's "true benchmark"

Connection to HWE-Bench: Hardware bugs are designed to be novel
  → The HWE-Bench failure modes (localization, reasoning, coordination)
    are actually measuring recombination quality
```

**3b. Latent Space Composability**

```
Question: Can we compose multiple RepE/SAE interventions without interference?

Method:
  - Inject multiple vectors simultaneously
  - Measure: do they reinforce or cancel each other?
  - Test compositionality: honesty + epistemic_stability + anti_sycophancy

Expected: SAE-based steering should compose better (disentangled features)
          Dense RepE vectors may interfere (shared features)
```

**3c. OpenMythos Loop vs. External Scaffold**

```
Question: Does an internal loop (Mythos) give qualitatively different recombination
          than external scaffold (pi-braid)?

Method: Comparative benchmark on:
  - Novel tool combination tasks
  - Cross-domain transfer
  - Long-horizon carry (N-turn dependency)

If Mythos wins significantly → loop architecture provides something
                               external scaffold can't approximate
If pi-braid wins or ties → external scaffold is sufficient for Level 2
```

---

## Part 8: The Unified Research Framework

Here's how everything fits together:

```
┌─────────────────────────────────────────────────────────────────┐
│                    THE THREE-LAYER MODEL                        │
│                                                                 │
│  LEVEL 3: Genuine Novelty (requires new primitives)              │
│    → Architecture change (looped transformer, persistent memory) │
│    → External knowledge injection (search, code exec)             │
│    → New training (fine-tuning, RLHF)                            │
│                                                                 │
│  LEVEL 2: Recombination (known primitives in new combinations)  │
│    → pi-braid's main operating layer                            │
│    → CoT, tool composition, scaffolded decomposition            │
│    → RepE/SAE can enhance this layer                            │
│    → UniR can add NEW reasoning modules to this layer           │
│                                                                 │
│  LEVEL 1: Memorization (retrieving training patterns)           │
│    → Most standard benchmarks measure this                      │
│    → pi-braid doesn't add much value here                      │
│    → Contamination makes this invisible                         │
└─────────────────────────────────────────────────────────────────┘

pi-braid's actual contribution:
  Moves behavior UP within Level 2
  → Better recombination through scaffold, not new primitives
  → Can enhance with RepE (suppress unwanted behaviors)
  → Can add modules with UniR (new reasoning capabilities)
  → Cannot create Level 3 novelty without external knowledge
```

---

## Summary: What Can Latent Space Do for pi-braid?

### Confirmed YES

| Technique                 | What It Gives                                       | pi-braid Integration                        |
| ------------------------- | --------------------------------------------------- | ------------------------------------------- |
| **RepE contrast vectors** | Suppress sycophancy, increase honesty               | New `latent-activator` extension            |
| **RepE LAT probes**       | Detect lying/hallucination in real-time             | Feed into heartbeat scheduler               |
| **SAE steering (YaPO)**   | Precise, disentangled behavioral control            | Requires open model or hook access          |
| **UniR modules**          | Add novel reasoning capabilities without retraining | Compose multiple modules as pi-braid skills |
| **Compositionality**      | Stack multiple interventions                        | UniR modules can be combined                |

### Confirmed NO (not without new architecture)

| Technique                                           | Why Not                         | Alternative                             |
| --------------------------------------------------- | ------------------------------- | --------------------------------------- |
| **True novel knowledge generation**                 | LLM can't invent new primitives | External knowledge via tools            |
| **Level 3 capability from prompt alone**            | Not how LLMs work               | Change architecture or inject knowledge |
| **Arbitrary capability injection via latent space** | Latent space is a compression   | UniR is the closest valid approach      |

### Key Research Gaps (Open Questions)

1. **Does stepfun/minimax expose any activation hooks?** — Blocks or enables everything in Tier 2
2. **Can RepE contrast vectors transfer across providers?** — If we compute on one model, does it work on another?
3. **Can UniR modules trained on small models improve large proprietary models?** — Weak-to-strong generalization is real but not proven for reasoning tasks
4. **Can we build a "novel recombination benchmark" that can't be gamed?** — AntiLeakBench methodology applied to coding agents

---

## Immediate Action Items

### This Week

1. **Test stepfun/minimax activation access** (2 days)

   ```
   Send completion request with:
   - Logprobs enabled
   - Check: does API return top_logprobs, embeddings, or any hidden states?
   - This determines everything else
   ```

2. **Implement RepE-style probe for honesty detection** (3 days)

   ```
   Even without injection, we can READ:
   - Generate honest/sycophantic response pairs
   - Train linear probe on hidden states
   - Use probe output as signal in pi-braid heartbeat
   - This doesn't require any provider hooks
   ```

3. **Run UniR on stepfun** (if it works with logit addition) (5 days)
   ```
   - Clone UniR github repo
   - Train a small reasoning module on math/coding
   - Add as pi-braid extension: beta * R(x) added to logprobs
   - Benchmark against no-UniR baseline
   ```

### Next 4 Weeks

4. **Design novel recombination benchmark** (1 week)

   ```
   Following AntiLeakBench methodology:
   - Generate problems with structures never in training
   - Test: base model vs. pi-braid vs. pi-braid + UniR
   ```

5. **SAE feasibility study** (2 weeks)

   ```
   - If open model available: full YaPO implementation
   - If not: document what's needed and why it matters
   ```

6. **OpenMythos comparison** (3 weeks)
   ```
   - Design comparative benchmark
   - Run on pi-braid
   - If Mythos accessible: run on Mythos
   - Compare Level 2 recombination quality
   ```

---

## Bibliography

| ID              | arXiv                                          | Title                                    | Key Finding                                                                                           |
| --------------- | ---------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| RepE            | [2310.01405](https://arxiv.org/abs/2310.01405) | Representation Engineering               | Top-down approach: population representations, LAT scan, contrast vectors, LoRRA. +18.1pp TruthfulQA. |
| SAE Features    | [2407.10774](https://arxiv.org/abs/2407.10774) | Sparse Autoencoders on Llama-3           | 16K monosemantic features extracted from residual stream                                              |
| YaPO            | [2601.08441](https://arxiv.org/abs/2601.08441) | Sparse Steering Vectors via DPO          | DPO-trained sparse steering in SAE space                                                              |
| FGAA            | [2501.09929](https://arxiv.org/abs/2501.09929) | Feature Guided Activation Additions      | Contrastive approach to activation addition                                                           |
| UniR            | [2505.19075](https://arxiv.org/abs/2505.19075) | Universal Reasoner                       | Plug-and-play reasoning module. Composable. Weak-to-strong.                                           |
| CAA             | —                                              | Contrastive Activation Addition          | Baseline: subtract concept vs. non-concept activations                                                |
| LoRRA           | —                                              | Low-Rank Representation Adaptation       | PEFT baseline for representation control                                                              |
| Truth Probe     | —                                              | Models Know When They're Wrong           | Representations of truthfulness exist even when output is wrong                                       |
| CoT Vecs        | —                                              | Chain of Thought Vectors                 | Reasoning mechanism transfer via latent vectors                                                       |
| SRPS            | —                                              | Sparse Autoencoder Role-Playing Steering | SAE-based persona control                                                                             |
| VAR-MATH        | [2507.12885](https://arxiv.org/abs/2507.12885) | Variabilized Math                        | 48-73% drop on variabilized benchmarks → memorization dominant                                        |
| AntiLeakBench   | [2412.13670](https://arxiv.org/abs/2412.13670) | Contamination-Free Benchmark             | Automated construction of truly unseen evaluation problems                                            |
| BeHonest        | [2406.13261](https://arxiv.org/abs/2406.13261) | Honesty Benchmark                        | 3-dimension honesty: self-knowledge, non-deceptiveness, consistency                                   |
| HWE-Bench       | [2604.14709](https://arxiv.org/abs/2604.14709) | Hardware Bug Repair                      | 3 failure modes, best proxy for real novel recombination                                              |
| Induction Heads | —                                              | In-Context Learning Circuits             | Two-layer circuits for next-token prediction on novel sequences                                       |

---

## Connection to Previous Research

| This Document                 | Builds On                                      | Extends                                                         |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| RepE + SAE analysis           | SAE-STEERING-PROPOSAL.md                       | Gives concrete implementation paths for each approach           |
| UniR                          | OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md           | Alternative to loop architecture for capability addition        |
| Three-level model             | BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md | Explains WHY some capabilities are achievable and others aren't |
| Novel recombination benchmark | NEW_PAPERS_20260423.md                         | HWE-Bench as a starting point                                   |
| Tier 1 (API-only)             | SAE-STEERING-PROPOSAL.md                       | Phase 2b implementation                                         |

---

_Research thread: implicit-framing / pi-braid / measurement_  
_Core finding: Latent space manipulation can enhance Level 2 recombination but not create Level 3 novelty. UniR is the most promising practical path for adding new capabilities to frozen models. RepE contrast vectors can suppress unwanted behaviors (sycophancy, dishonesty) without training._  
_Next review: 2026-04-24_
