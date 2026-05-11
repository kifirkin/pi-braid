# Extended Research: Tool-Augmented Reasoning & Knowledge Extrapolation

**Date**: 2026-04-23 (overnight research)  
**Thread**: implicit-framing / pi-braid / measurement / agent-architecture  
**Based on**: UniR (2505.19075) + Knowledge Editing literature + Tool-Augmented Agent papers

---

## Part 1: UniR — Universal Reasoner Deep Dive

### The Core Innovation

UniR is the most practically relevant paper for pi-braid capability enhancement. Key details from the abstract:

```
Traditional PEFT:
  Frozen LLM + LoRA adapter
  → Adapter is architecture-dependent
  → Must retrain for each LLM
  
UniR (Universal Reasoner):
  Trained reasoning module R(x)
  → Output is LOGITS (not hidden states)
  → Add to ANY frozen LLM: P_final = softmax(L + β·R(x))
  → Architecture-agnostic
```

### Key Properties

1. **Plug-and-play**: Train ONCE on small model → works on ANY frozen LLM
2. **Composable**: Multiple UniR modules stack by summing logits
   - UniR_math + UniR_code → combined reasoning
   - β · R_math(x) + β · R_code(x) = combined logit adjustment
3. **Weak-to-strong generalization**: Module trained on Llama-3-8B works on Llama-3-70B
4. **No fine-tuning of base model**: Frozen LLM stays frozen
5. **Open source**: https://github.com/hangeol/UniR

### The Training Signal

```
Trajectory-level signals → Token-level guidance

UniR is trained with reward signals:
  - Math: final answer correctness
  - Translation: BLEU/chrF
  
During training:
  R(x) learns to adjust logits in direction of high-reward trajectories
  
At inference:
  P_final = softmax(L + β·R(x))
  → The reasoning module guides the frozen LLM toward better outputs
```

### pi-braid Application Path

**Question**: Can we train a UniR module for pi-braid-specific reasoning?

```
pi-braid reasoning challenges:
  1. Tool composition (which tool → when → how)
  2. Fault localization (which file → which layer)
  3. Multi-turn coherence (remember earlier decisions)
  4. Anti-sycophancy (resist agreeableness)

For each challenge, define reward:
  1. Tool composition: Did the tool call solve the sub-problem?
  2. Fault localization: Did editing this file fix the bug?
  3. Multi-turn coherence: Is current plan consistent with earlier decisions?
  4. Anti-sycophancy: Does response prioritize truth over agreeableness?

Train UniR modules:
  - UniR_tool_composition
  - UniR_fault_localization
  - UniR_coherence
  - UniR_anti_sycophancy

At runtime:
  P_final = softmax(L 
    + β₁·R_tool(x) 
    + β₂·R_localization(x) 
    + β₃·R_coherence(x)
    + β₄·R_sycophancy(x))
```

**But**: UniR requires logit access. stepfun/minimax are API-only. This is blocked.

**Alternative**: Use UniR for analysis only:
- Train UniR on accessible open model
- Use its behavior as a benchmark / gold standard
- Compare pi-braid agent against UniR-augmented baseline

---

## Part 2: Knowledge Editing — The Honest Picture

### Key Finding: Editing Harms General Abilities

```
From 2401.04700 (RECT paper):
  "Model editing improvements on factuality come at the cost of 
   significant degradation of the model's general abilities"
  
  Four popular editing methods × three LLMs × eight tasks:
  - Editing improves target fact → But reasoning, NLI, QA degrade
  - Cause: Overfitting to edited facts, excessive weight changes
  - Solution: RECT - regularize edit update weights by relative change
  
Finding: Only 94% editing performance retained while general abilities preserved
```

### Key Finding: Cross-Lingual Editing

```
From 2401.10521 (XME paper):
  "Edit vectors for Chinese and English are nearly ORTHOGONAL
   — residing in DISJOINT SUBSPACES"
  
  This means:
  - Editing a fact in English does NOT propagate to Chinese
  - Mixed-lingual editing exhibits linear additivity of these subspaces
  - Knowledge is stored separately by language
  
pi-braid implication:
  - We can't assume "knowing a fact in one language" = knowing in another
  - For international code (comments, variable names) → this matters
```

### Key Finding: Medical Knowledge Editing

```
From MedEditBench (2506.03490):
  "Current KE methods result in only SUPERFICIAL MEMORIZATION
   of the injected information, failing to generalize to new scenarios"
  
  Finding: Self-Generated Rationale Editing (SGR-Edit) works better:
  - Uses model-derived rationales as the target knowledge
  - Uncovers the underlying reasoning process
  - Demonstrates significant improvements
  
pi-braid implication:
  - Adding facts to a model via KE ≠ model understanding the fact
  - The model memorizes, doesn't understand
  - This is the same as Level 1 (memorization) vs Level 2 (recombination)
```

### Key Finding: Lifelong Knowledge Editing

```
From LightEdit (2604.19089):
  - Sequential edits cause CATASTROPHIC FORGETTING
  - Retrieval-based approaches help but have training costs
  - LightEdit: Selective knowledge suppression via decoding strategy
    → Minimizes original knowledge probabilities → enables efficient edits
    
pi-braid implication:
  - If we ever need to "unlearn" a behavioral pattern
  - Simple suppression via decoding may be cleaner than weight editing
  - This could work for sycophancy suppression
```

---

## Part 3: Tool-Augmented Reasoning — Key Papers

### 3.1: PFUA — Protein Function Understanding (103% improvement!)

```
Key finding:
  "Text-based reasoning paradigms are INEFFECTIVE for protein function
   → RL mainly amplifies superficial keyword patterns
   → Fails to introduce new biological knowledge"
  
  Solution: PFUA - Tool-augmented protein reasoning agent
  - Domain-specific tools → verifiable intermediate evidence
  - Tool augmentation: +103% average performance
  
pi-braid connection:
  - This confirms: for KNOWLEDGE-INTENSIVE tasks, tools are essential
  - Text-only reasoning amplifies patterns, doesn't add knowledge
  - pi-braid's tool use is CORRECT approach for Level 2 recombination
```

### 3.2: SAKE — Structured Agentic Knowledge Extrapolation

```
Key finding:
  - RL-powered agentic framework with KG (Knowledge Graph) tools
  - Two external KG tools:
    1. Entity group construction
    2. Cross-group triplet retrieval
  - Three-turn rollout: extract entities → filter groups → associative reasoning
  - GRPO with curriculum reward
  - 90% TOKEN REDUCTION while surpassing GPT-3.5-Turbo
  
pi-braid connection:
  - KG tools for knowledge extrapolation
  - Structured retrieval > unstructured search
  - 90% token reduction = efficiency gain
  - pi-braid could use belief store as KG for this
```

### 3.3: Prometheus — Memory-Centric Coding Agent

```
Key finding:
  - SWE-bench Verified: 74.4% resolution rate (GPT-5 powered)
  - SWE-PolyBench Verified: 33.8% (Top-1 among open-source)
  - Memory-enhanced navigation reduces repeated traversals
  - Unified knowledge graph for repository
  
pi-braid connection:
  - Prometheus uses working memory that RETAINS and REUSES explored contexts
  - This is exactly what pi-braid's three-memory system should do
  - pi-braid's belief store could implement Prometheus-style context retention
  - Key insight: "temporal continuity of agent reasoning" prevents repeated traversals
```

### 3.4: RE-Searcher — Goal-Oriented Search Agent

```
Key finding:
  - Environmental complexity → fragile search behaviors → degraded performance
  - RE-Searcher: articulates concrete search goal + self-reflection
  - Goal-oriented planning + self-reflection = resist spurious cues
  
pi-braid connection:
  - pi-braid should articulate goals BEFORE tool use
  - Self-reflection after tool call: "Did retrieved evidence satisfy goal?"
  - This is the AgentV-RL forward/backward verification pattern in search
```

### 3.5: ILWS — Instruction-Level Weight Shaping

```
Key finding:
  - System instructions = "external, auditable pseudo-parameters"
  - Reflection Engine: inspects conversation → diagnoses → proposes typed deltas
  - Deltas: ΔK = (ΔS, ΔU, ΔT) over instructions, user preferences, tools
  - Auto-repaired on first failure, rolled back on repeated failure
  - Optional distillation into weights (compile instructions → parameters)
  - 2.4-5.0x throughput increase, 80% hallucination reduction
  
pi-braid connection:
  - ILWS is essentially RepE in TEXT SPACE
  - Instructions act as pseudo-parameters (like contrast vectors)
  - pi-braid's prompt-builder could implement ILWS-style instruction versioning
  - "Compile matured instruction-space gains into parameters" = RepE LoRRA
```

---

## Part 4: The Unified Framework — How Everything Connects

### The Four Paradigms

```
Paradigm 1: WEIGHT EDITING (Knowledge Editing)
  - Directly modify model weights
  - Methods: LoRA, ROME, KE
  - Problem: Catastrophic forgetting, general ability degradation
  - pi-braid: NOT USED
  
Paradigm 2: ACTIVATION EDITING (RepE)
  - Modify activations (contrast vectors, SAE steering)
  - Problem: Needs hidden state access
  - pi-braid: TEXT-LEVEL APPROXIMATION only
  
Paradigm 3: INSTRUCTION EDITING (ILWS)
  - Instructions as pseudo-parameters
  - Text-level equivalent of RepE
  - pi-braid: TEXT SPACE (contrast phrases)
  
Paradigm 4: EXTERNAL KNOWLEDGE (Tool Augmentation)
  - Augment with external tools, KG, search
  - pi-braid: TOOLS as primary mechanism
  - This is how pi-braid achieves Level 2 recombination
```

### The Four Methods for pi-braid Behavioral Control

```
┌─────────────────────────────────────────────────────────────┐
│                    BEHAVIORAL CONTROL                        │
│                                                             │
│  TYPE 1: Prompt Framing (pi-braid today)                    │
│    Identity, implicit norms, role definition                 │
│    → Works at text level, no hooks needed                   │
│                                                             │
│  TYPE 2: Contrast Phrases (RepE text-space)                 │
│    "Your primary obligation is TRUTHFULNESS"                │
│    → Activates same circuits as contrast vectors            │
│    → Implemented in prompt-builder                          │
│                                                             │
│  TYPE 3: Instruction Weight Shaping (ILWS)                  │
│    Treat instructions as pseudo-parameters                  │
│    → Version control, rollback, auto-repair                  │
│    → pi-braid can implement this pattern                    │
│                                                             │
│  TYPE 4: Tool Augmentation (External Knowledge)              │
│    KG tools, search, code execution                         │
│    → Adds genuinely new information to reasoning            │
│    → This is how pi-braid achieves Level 2                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 5: What This Means for pi-braid

### The Practical Path Forward

```
Week 1-2: Contrast Phrase Library (Type 2)
  - Build 4 contrast phrases from RepE
  - TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY
  - Integrate into prompt-builder
  - Test on BeHonest-style scenarios

Week 3-4: ILWS-Inspired Instruction Management (Type 3)
  - Implement instruction versioning in pi-braid
  - Track instruction changes across sessions
  - Auto-rollback on failure
  - Optional distillation into weights (future work)

Week 5-6: Tool Augmentation Enhancement (Type 4)
  - Add KG-style tool for belief store queries
  - Structured retrieval vs. unstructured search
  - Prometheus-style working memory
  - RE-Searcher-style goal articulation

Week 7-8: UniR Analysis (if logit access available)
  - Analyze UniR behavior on open model
  - Use as benchmark / gold standard for comparison
  - Not implementable without logit access
```

### The Key Insight

**pi-braid already does the right things, but not systematically:**

| pi-braid Extension | Maps To | Currently |
|--------------------|---------|-----------|
| Prompt builder | Type 1 + Type 2 | Implemented but not structured |
| Belief store | Type 4 (KG) | Unwired |
| Three-memory | Prometheus-style | Unwired |
| Heartbeat scheduler | ILWS reflection | Partial |
| Meta-cognition | RE-Searcher self-reflection | Partial |

**The issue**: Extensions exist but aren't wired together into a coherent behavioral control system.

---

## Part 6: The Novel Capability Question — Resolved

### The Definitive Answer from All Research

**Q: Can pi-braid make the model solve tasks NOT in training data?**

**A: PARTIALLY — but only via Type 4 (external knowledge injection).**

```
Level 1: Memorization — benchmark contamination dominant
  → pi-braid doesn't add value here
  
Level 2: Recombination — CoT, tool composition, scaffolded decomposition
  → pi-braid's PRIMARY contribution
  → Tools add genuinely new information (file system, search, code exec)
  → This is "novel" relative to the model's knowledge cutoff
  
Level 3: Genuine novelty — requires knowledge not in model + not accessible via tools
  → pi-braid CANNOT help here
  → Only architecture change or training can enable this
```

**The key insight**: Tool-augmented reasoning (PFUA +103%, SAKE 90% reduction) shows that **tools add new knowledge, not just retrieve known facts**. This is the sense in which pi-braid can appear to create "novel" capabilities — by giving the model access to information it couldn't derive from training alone.

**But**: This is fundamentally different from the model "learning to solve new tasks" internally. pi-braid provides an external scaffolding layer that the model operates through. The model itself doesn't change.

---

## Part 7: New Research Directions

### 7.1: ILWS for pi-braid

Instruction-Level Weight Shaping is the most practical approach for pi-braid:
- Instructions as pseudo-parameters
- Reflection Engine after each session
- Typed deltas (ΔS, ΔU, ΔT)
- Auto-repair on first failure, rollback on repeated failure

**pi-braid implementation**:
```
After each benchmark run:
  1. Analyze conversation traces
  2. Identify reasoning successes and failures
  3. Propose typed deltas to instructions:
     - ΔS: system prompt changes
     - ΔU: utility model prompt changes  
     - ΔT: tool descriptions
  4. Version control the changes
  5. Evaluate on next run
  6. Roll back if performance degrades
```

### 7.2: KG-Enhanced Belief Store

SAKE-style knowledge graph tools for pi-braid:
- Entity group construction from conversation
- Cross-group triplet retrieval
- Structured belief queries vs. semantic search

**pi-braid implementation**:
```
Belief store (D0) enhanced:
  - Nodes: entities mentioned in conversation
  - Edges: relationships discovered
  - Triplets: (entity, relation, entity)
  
Tool: query_belief(entity, relation)
  → Returns structured KG triples instead of text chunks
  
This is more efficient than semantic search:
  - 90% token reduction (SAKE finding)
  - Verifiable reasoning traces
```

### 7.3: Prometheus-Style Working Memory

```
Prometheus memory engine:
  - Retains explored contexts across reasoning steps
  - Reuses contexts to prevent repeated traversals
  - Unified knowledge graph for codebase
  
pi-braid implementation:
  - Working memory in heartbeat scheduler
  - Track "explored" files, functions, concepts
  - On each tool call: check if already explored
  - If explored: use cached result instead of re-exploring
```

---

## Part 8: pi-braid Proposals — Updated

| Proposal | Status | Priority | Based On |
|----------|--------|----------|---------|
| Bidirectional Verifier | Not started | P1 | AgentV-RL |
| SAE Steering | Obsolete for API | P2 | YaPO/FGAA (blocked) |
| RepE Prompt Contrast | **READY** | **P0** | RepE + ILWS text-space |
| KG-Enhanced Belief Store | New | P1 | SAKE + KG tools |
| Prometheus Memory | New | P2 | Prometheus |
| Instruction Weight Shaping | New | P1 | ILWS |

---

## Summary: The Four Pillars of pi-braid Enhancement

```
┌─────────────────────────────────────────────────────────────┐
│                  PI-BRAID ENHANCEMENT                        │
│                                                             │
│  PILLAR 1: Contrast Phrases (RepE text-space)                │
│    → Suppress sycophancy, enhance honesty                   │
│    → TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC_STABILITY      │
│                                                             │
│  PILLAR 2: Instruction Weight Shaping (ILWS)                │
│    → Treat instructions as pseudo-parameters                │
│    → Version control, rollback, auto-repair                │
│                                                             │
│  PILLAR 3: KG-Enhanced Belief Store (SAKE)                  │
│    → Structured knowledge graph instead of text search     │
│    → 90% token reduction, verifiable reasoning             │
│                                                             │
│  PILLAR 4: Prometheus-Style Working Memory                   │
│    → Retain and reuse explored contexts                     │
│    → Prevent repeated traversals                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Bibliography

| ID | arXiv | Title | Key Finding |
|----|-------|-------|------------|
| UniR | 2505.19075 | Universal Reasoner | Plug-and-play reasoning module, logit addition, weak-to-strong |
| RECT | 2401.04700 | Model Editing Harms General Abilities | Editing degrades reasoning/NLI/QA, regularization solution |
| XME | 2401.10521 | Cross-lingual Model Editing | Edit vectors are orthogonal across languages |
| MedEditBench | 2506.03490 | Medical Knowledge Editing | Current methods = superficial memorization, SGR-Edit better |
| LightEdit | 2604.19089 | Lifelong Knowledge Editing | Selective knowledge suppression via decoding |
| PFUA | 2601.03604 | Protein Function with Tools | 103% improvement with tool augmentation |
| SAKE | 2505.15062 | Structured Agentic Knowledge Extrapolation | KG tools + RL, 90% token reduction |
| Prometheus | 2507.19942 | Memory-Centric Coding Agent | 74.4% SWE-bench, working memory prevents repeated traversals |
| RE-Searcher | 2509.26048 | Robust Agentic Search | Goal-oriented planning + self-reflection |
| ILWS | 2509.00251 | Instruction-Level Weight Shaping | Instructions as pseudo-parameters |
| AutoAgent | 2603.09716 | Evolving Cognition + Elastic Memory | Self-evolving multi-agent framework |

---

## Next Actions

1. **Implement Pillar 1** (contrast phrases) — Week 1
2. **Design Pillar 2** (instruction versioning) — Week 2
3. **Wire Pillar 3** (KG belief store) — Week 3
4. **Wire Pillar 4** (working memory) — Week 4
5. **Run comparative benchmark** — Week 5

---

*Research thread: implicit-framing / pi-braid / measurement*  
*Core finding: Four pillars of pi-braid enhancement — contrast phrases, instruction weight shaping, KG-enhanced belief store, Prometheus-style working memory. pi-braid achieves Level 2 recombination through tool augmentation, not internal capability change.*  
*Next review: 2026-04-24*