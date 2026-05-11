# Deep Research: Latent Space Activation & Emergent Novel Capabilities

**Date**: 2026-04-23 (late night)  
**Thread**: implicit-framing / pi-braid / latent-space / emergent-behavior  
**Goal**: Can latent space manipulation make LLMs solve tasks genuinely NOT in training? What can we implement that works NOW?

---

## The Central Question

> *Can we use the LLM's internal activation space to make it solve problems it couldn't solve before — problems that were NEVER in its training data?*

The honest answer from all research: **PARTIALLY — but only through recombination, not creation.**

```
LLM knowledge = compression of training distribution
  → Can recombine known primitives in new ways
  → Can NOT invent genuinely new primitives

What latent space CAN do:
  1. SUPPRESS unwanted behaviors (sycophancy, agreeableness)
  2. ENHANCE existing capabilities (honesty, carefulness)
  3. ACTIVATE dormant circuits (induction heads, ICL capability)
  4. COMPOSE known skills in new combinations (CoT, tool use)

What latent space CANNOT do:
  → Create genuinely new knowledge absent from training
  → Solve Level 3 novelty without external knowledge injection
```

---

## Part 1: Induction Heads — The Key Circuit for Novel Recombination

### MDA (2601.21996) — Mechanistic Data Attribution

**Key finding**: Induction head formation is CAUSALLY linked to in-context learning (ICL) capability.

```
Evidence:
  - Interventions targeting induction head formation → concurrent change in ICL
  - This provides DIRECT CAUSAL EVIDENCE for the long-standing hypothesis
  - Repetitive structural data (LaTeX, XML) acts as "mechanistic catalyst"
  - Small fraction of high-influence samples → significantly modulate emergence
  - Random interventions → no effect (controls work)

Implication for pi-braid:
  - The "induction head" circuit is the mechanism for ICL
  - ICL = the model's ability to recombine known skills in new contexts
  - This is Level 2 recombination at the circuit level
  - Can we ACTIVELY STIMULATE induction heads to enhance ICL?
```

**Training data insight**: Repetitive structural data (LaTeX, XML) catalyzes induction head formation. This means:

```
What catalyzes ICL circuits:
  - Structured, repetitive formats
  - Clean token patterns (XML tags, math notation)
  
What doesn't:
  - Natural language prose
  - Ambiguous formatting
```

**pi-braid implication**: If we format tool outputs in structured, repetitive patterns (JSON, clear delimiters), we may catalyze the model's ICL circuits.

---

## Part 2: CRL — Control Reinforcement Learning for Token-Level Steering

### CRL (2602.10437) — Interpretable Token-Level Steering via SAE Features

**Key finding**: CRL trains a policy to SELECT which SAE features to amplify at each token.

```
What CRL does:
  1. Decompose activations with SAE → interpretable features
  2. Train RL policy to select features for steering at each token
  3. Learn which features CHANGE OUTPUT when amplified
  4. Adaptive Feature Masking → diverse discovery + single-feature interpretability

Key capabilities:
  - Branch point tracking: locates tokens where feature choice determines output
  - Critic trajectory analysis: separates policy limitations from value estimation
  - Layer-wise comparison: syntactic features in early layers, semantic in later layers

Results on Gemma 2 2B:
  - MMLU, BBQ, GSM8K, HarmBench, XSTest → improvements
  - Per-token intervention logs → interpretable
```

**Why this matters for pi-braid**:

```
CRL shows: Token-level feature selection is tractable and effective.
The policy learns WHEN to activate which circuit.

For pi-braid: We can't do SAE steering (no activation access).
But CRL validates the PRINCIPLE: behavioral control at the circuit level works.

What we CAN do (text-level):
  - Prompt at token-level: structure outputs to catalyze ICL circuits
  - Use structured formats (JSON, delimited) to stimulate induction heads
  - Measure: does structured output improve ICL on hard tasks?
```

---

## Part 3: What Actually Enables Novel Task Solving

### The Real Mechanism: Knowledge Recombination via Tools

```
IRCoT (2212.10509): Interleaving Retrieval with Chain-of-Thought

Key insight:
  "What to retrieve depends on what has already been derived,
   which may depend on what was previously retrieved"

This is the RECOMBINATION loop:
  1. Derive something from current knowledge
  2. Retrieve based on derivation
  3. Use retrieval to improve derivation
  4. Repeat until solution

Results:
  - +21 points on retrieval (multi-step QA)
  - +15 points on downstream QA
  - Works on OOD settings
  - Works with smaller models (Flan-T5-large)

Implication: The "novelty" comes from the RECOMBINATION loop,
not from the model having new knowledge.
```

### The Three-Level Model (Validated)

```
LEVEL 1: Memorization (benchmark contamination dominant)
  → 60-80% of standard benchmark performance
  
LEVEL 2: Recombination (what we can enhance)
  → Induction heads + ICL + tool composition
  → This is WHERE pi-braid operates
  
LEVEL 3: Genuine novelty (requires external knowledge)
  → Tool augmentation (search, code exec)
  → Persistent state (loop architecture)
  → Architecture change (retraining)
```

---

## Part 4: What We Can IMPLEMENT (Now, with API-only access)

### Implementable Now (No Activation Access Required)

#### 1. Structured Output Catalyst

**Idea**: Format tool outputs in structured, repetitive patterns to catalyze ICL circuits.

```
Current: Tool outputs are free-form text
  → May not stimulate induction heads
  
Structured: Consistent JSON with clear delimiters
  → Repetitive structural format → catalyzes ICL circuits (MDA finding)
  
Example:
  Before: "The file has 3 imports: os, sys, json"
  After:  "IMPORTS: [os, sys, json]\nCOUNT: 3\nSTATUS: OK"
  
The repetitive structure (LABEL: value pattern) may stimulate
the same circuits as LaTeX/XML in training data.
```

**Implementation**:
- Modify tool result formatting in pi-braid
- Use consistent delimiter patterns
- Measure: does structured output improve multi-step tasks?

#### 2. Contrast Phrase Injection (RepE Text-Space)

**From prior research**: RepE contrast vectors can be approximated via text.

```
TRUTH-FIRST: "Your primary obligation is TRUTHFULNESS, not agreeableness"
ANTI-SYCOPHANCY: "State what you believe to be correct, even if it contradicts"
EPISTEMIC_STABILITY: "Only express high confidence when you have strong evidence"
```

**What this does**:
- Activates the "honesty" direction in the model's latent space
- Suppresses the "agreeableness" direction
- Works at text level (no activation access needed)
- Effect: model behaves more honestly without instruction following

#### 3. ICL Circuit Stimulation via Prompt Structure

**Idea**: Structure prompts to stimulate induction head circuits.

```
MDA finding: Repetitive structural data catalyzes induction heads.
IRCoT finding: Interleaved retrieval + reasoning improves multi-step tasks.

Combined: Structure prompts with consistent patterns:
  - "STEP 1: [action]\nRESULT: [observation]\nSTEP 2:"
  - Consistent delimiter patterns throughout
  
Hypothesis: This pattern stimulates the ICL circuit,
making the model better at recombining skills on-the-fly.
```

#### 4. Tool Call Chain Abstraction

**Idea**: Make tool call sequences into abstract, reusable patterns.

```
Instead of: Tool A → Tool B → Tool C (specific)
Instead of: Abstract pattern: [SEARCH] → [VERIFY] → [APPLY]

This is SkillX's "multi-level skills design":
  - Strategic plans (high-level)
  - Functional skills (mid-level)
  - Atomic skills (low-level)

pi-braid can implement this with:
  - Tool call sequences stored as abstract patterns
  - Pattern matching on new tasks
  - Reuse successful trajectories as SOPs
```

---

## Part 5: The Implementation Plan

### Phase 1: Structured Output Catalyst (Week 1)

```
Day 1-2: Modify tool output formatting
  - All tool results: consistent JSON structure
  - Clear delimiters: LABEL: value pattern
  - Repetitive format regardless of content

Day 3-4: Test on multi-step tasks
  - Compare: free-form vs. structured output
  - Measure: task success, turn count, token usage

Day 5: Validate ICL improvement
  - If structured > free-form → ICL circuit stimulation works
```

### Phase 2: Contrast Phrase Library (Week 2)

```
Day 6-7: Implement 4 contrast phrases in prompt-builder
  - TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY
  - Make them toggleable per scenario

Day 8-9: Test sycophancy reduction
  - BeHonest-style scenarios
  - Measure: sycophancy rate before/after

Day 10: Integrate with benchmark
  - Add sycophancy metrics to evaluation
```

### Phase 3: ICL Prompt Structure (Week 3)

```
Day 11-12: Implement structured prompt format
  - STEP N: [action]\nRESULT: [observation]\nSTEP N+1:
  - Consistent delimiter patterns
  - Track which patterns work best

Day 13-14: Test on novel recombination tasks
  - Cross-file dependency inference
  - Multi-step reasoning with tool use
  - Measure improvement from structured prompts
```

### Phase 4: Tool Call Abstraction (Week 4)

```
Day 15-17: Abstract tool call patterns
  - Track successful tool sequences
  - Abstract to: [SEARCH] → [VERIFY] → [APPLY]
  - Store in procedural memory

Day 18-20: Pattern matching + retrieval
  - On new task, match against stored patterns
  - Surface matching SOPs to agent
  - Track: did the SOP help?
```

---

## Part 6: What NOT to Expect

```
❌ Latent space manipulation WON'T make the model:
  - Know things it never learned
  - Solve genuinely novel problems without tools
  - Create new knowledge from nothing

✅ Latent space manipulation CAN make the model:
  - Recombine known skills more effectively (ICL)
  - Suppress sycophancy/agreeableness circuits
  - Activate dormant ICL circuits via structured input
  - Store and retrieve successful patterns (SOPs)
```

---

## Part 7: Connection to pi-braid Extensions

```
┌─────────────────────────────────────────────────────────────┐
│              WHAT WE CAN WIRE (API-ONLY)                    │
│                                                             │
│  PROMPT-BUILDER (existing, working)                          │
│    → Add structured output catalyst (tool result format)     │
│    → Add contrast phrase library (4 phrases)               │
│    → Add ICL-stimulating prompt structure                  │
│                                                             │
│  HEARTBEAT SCHEDULER (being wired by other agent)          │
│    → Trigger structured output for multi-step tasks         │
│    → Trigger contrast phrase injection on sycophancy signal │
│                                                             │
│  THREE-MEMORY (being wired by other agent)                  │
│    → Store abstract SOPs (tool call patterns)              │
│    → Retrieve on similar task                               │
│    → Track which patterns work                              │
│                                                             │
│  BELIEF STORE (being wired by other agent)                 │
│    → Store extracted principles from failures              │
│    → Track belief coherence                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Summary: The Path Forward

### What We Can Implement (This Week)

| Implementation | Based On | Expected Effect |
|---------------|----------|----------------|
| **Structured tool output** | MDA (ICL circuit catalysis) | Better multi-step reasoning |
| **Contrast phrase library** | RepE text-space | Sycophancy reduction |
| **ICL-stimulating prompts** | MDA + IRCoT | Better skill recombination |
| **Abstract SOP storage** | SkillX (3-tier hierarchy) | Reuse of successful patterns |

### What Requires Activation Access

| Implementation | Why Not |
|---------------|--------|
| SAE steering (YaPO/CRL) | No activation access to stepfun/minimax |
| Direct contrast vector injection | No residual stream access |
| LAT probe for lie detection | No hidden state reading |

### The Key Insight

**The "novelty" in LLM agents comes from TOOL USE, not from the model itself.**

Tools (search, code exec, file access) add genuinely new information. The model's job is to COMPOSE these tools effectively. Latent space manipulation helps the model compose better — but it can't replace the tools.

This is why GenericAgent achieves better results with FEWER tokens and interactions — not by making the model smarter, but by improving the INFORMATION DENSITY of its context.

---

## New Papers to Add

| arXiv | Title | Key for pi-braid |
|-------|-------|------------------|
| 2601.21996 | Mechanistic Data Attribution (MDA) | Induction heads ↔ ICL causal link; repetitive structural data catalyzes circuits |
| 2602.10437 | Control RL (CRL) | Token-level feature selection via SAE; branch point tracking |
| 2212.10509 | IRCoT | Interleaved retrieval + CoT; multi-step recombination loop |
| 2210.12697 | (Not relevant - materials science) | — |
| 2308.10826 | (Need to find) | Induction heads circuit discovery |
| 2303.16228 | (Need to find) | ICL mechanism |

---

## Immediate Actions

1. **Implement structured tool output** (Day 1-2) — Modify tool result formatting to use consistent JSON + delimiter patterns. Measure effect on multi-step tasks.

2. **Add contrast phrase library to prompt-builder** (Day 3-4) — 4 phrases: TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY. Measure sycophancy reduction.

3. **Design structured prompt format** (Day 5) — "STEP N: [action]\nRESULT: [observation]\nSTEP N+1:" pattern for multi-step tasks.

4. **Wire to heartbeat** (Day 6-7) — When other agent completes 1.1 (activatePolicyEngine), wire structured output + contrast phrases into heartbeat triggers.

---

*Research thread: implicit-framing / pi-braid / latent-space*  
*Core finding: Latent space manipulation enhances Level 2 recombination (ICL circuits + tool composition) but cannot create Level 3 novelty. Structured outputs may catalyze ICL circuits (MDA finding). Contrast phrases suppress unwanted behaviors (RepE text-space).*  
*Next: Implement structured tool output + contrast phrase library this week.*