# Proposal: pi-braid Benchmark Improvements — Contamination-Resistant Evaluation

**Type**: Benchmark Design + Measurement  
**Based on**: VAR-MATH (2507.12885), AntiLeakBench (2412.13670), BeHonest (2406.13261), ACBench (2505.19433), HWE-Bench (2604.14709), HaluMem (2511.03506)  
**Priority**: P0 (Immediate)  
**Owner**: pi-braid research + overnight development

---

## Problem Statement

pi-braid's current benchmark has **severe measurement problems**:

1. **Benchmark contamination**: Most problems are likely in LLM training data (VAR-MATH: 48-73% drop on variabilized benchmarks)
2. **No sycophancy measurement**: We measure task completion, not behavioral quality
3. **No consistency metrics**: Same problem different format = different score
4. **No memory hallucination tracking**: HaluMem shows memory systems generate/accumulate hallucinations
5. **No efficiency metrics**: Token usage not measured
6. **Only stepfun provider tested properly**: minimax results incomplete

Result: We don't know if pi-braid actually improves reasoning, or if we're just measuring memorization.

**Important**: The other pi-braid agent is wiring critical infrastructure (tool tracking, three-memory, belief store) in Tier 1. Our benchmark improvements will validate this wiring works by measuring:
- Memory hallucination rates (HaluMem) - detects if belief store wiring is broken
- Tool use efficiency - validates tool tracking
- Cross-session coherence - validates three-memory recall

---

## Key Papers: Benchmark Design Principles

### VAR-MATH (2507.12885) — Variabilized Math Benchmark

```
VAR-MATH finding: Standard math benchmarks → ~80% accuracy
                   Variabilized versions → ~15-35% accuracy
                   Drop: 48-73%

Interpretation:
  - Model solves standard by memorizing solution patterns
  - Variabilized = same skill, different surface form
  - True capability revealed only on unseen variants

For pi-braid: Create VARIANTS of each problem.
  Original: flatten([[1,2],[3,[4]]]) = [1,2,3,4]
  Variant 1: flatten with custom __iter__ class
  Variant 2: flatten with generator (not list)
  Variant 3: flatten dict with Sequence protocol
```

### AntiLeakBench (2412.13670) — Contamination-Free Construction

```
AntiLeakBench methodology:
  1. Find problems where LLM training source is known
  2. Filter out problems that appear in training
  3. Test on remaining genuinely unseen problems
  4. Measure contamination rate by comparing known vs unknown

Key finding: Contamination is almost INEVITABLE in standard construction.
  Only way to avoid: construct problems with explicitly new knowledge.

For pi-braid: We can't fully avoid contamination, but we can:
  1. Use VARIANTS (VAR-MATH approach) to test structure-understanding
  2. Measure contamination rate via comparison
  3. Focus on hardest problems (least likely to be in training)
```

### ACBench (2505.19433) — Agent Compression Benchmark

```
ACBench: Evaluates agentic capabilities, not just language modeling.
  Four capability categories:
    1. Workflow generation (WorkBench)
    2. Tool use / function call
    3. Long-context understanding (Needle-in-Haystack)
    4. Real-world application

Key finding: Compression preserves workflow/tool use (1-3% drop)
            but degrades real-world application (10-15% drop)

For pi-braid: Add agentic capability metrics:
  - Tool use efficiency (calls per task)
  - Long-context retrieval accuracy
  - Cross-session coherence
```

### HaluMem (2511.03506) — Hallucination in Memory Systems

```
HaluMem: Memory systems generate hallucinations:
  - Fabrication (made-up facts)
  - Errors (incorrect stored facts)
  - Conflicts (contradictory memories)
  - Omissions (forgotten important info)

Key finding: Hallucinations accumulate from extraction → updating → QA

For pi-braid: Track memory hallucinations:
  - Does belief store contain contradictory facts?
  - Does episodic memory lose critical details?
  - Does procedural memory store incorrect SOPs?
```

---

## Proposed Benchmark: pi-braid EVALUATION SUITE v2

### The Three-Tier Evaluation Model

```
┌─────────────────────────────────────────────────────────────┐
│                 BENCHMARK TIERS                              │
│                                                             │
│  TIER 1: STANDARD TASKS (Baseline comparison)               │
│    Current problems, fixed format                           │
│    Purpose: Compare to prior results, track regressions      │
│    Limitation: May be contaminated                          │
│                                                             │
│  TIER 2: VARIANT TASKS (Structure understanding)            │
│    Same skill, different surface form                      │
│    Variabilized versions of Tier 1                          │
│    Purpose: Measure true generalization                    │
│    Interpretation: If Tier 2 score < Tier 1 → contamination│
│                                                             │
│  TIER 3: NOVEL TASKS (Genuinely unseen)                     │
│    Problems requiring novel recombination                 │
│    Cross-domain transfer, hidden constraints               │
│    Purpose: Measure Level 2 recombination capability       │
│                                                             │
│  Pass: 80% correct across ALL tiers                          │
└─────────────────────────────────────────────────────────────┘
```

### New Metrics

```
BEHAVIORAL METRICS (BeHonest-inspired):
  - Sycophancy rate: Persona + preference scenarios
  - Consistency score: Same question, 5 formats → variance
  - Self-knowledge rate: Admit unknowns when appropriate

EFFICIENCY METRICS:
  - Token usage per task
  - Tool calls per task
  - Turns to solution
  - Memory compression ratio

MEMORY QUALITY METRICS (HaluMem-inspired):
  - Hallucination rate: Fabricated facts in belief store
  - Conflict rate: Contradictory memories
  - Omission rate: Forgotten critical information
  - Update latency: Time to update belief after new evidence

AGENTIC CAPABILITY METRICS (ACBench-inspired):
  - Workflow generation quality
  - Tool use efficiency (calls per task)
  - Long-context retrieval accuracy
  - Cross-session coherence
```

### Implementation

#### Tier 2: Variant Task Generator

```python
def generate_variants(task, num_variants=5):
    """
    Generate structurally different variants of a task.
    Same skill, different surface form.
    """
    variants = []
    
    # For flatten task:
    # V1: Custom __iter__ class
    # V2: Generator input
    # V3: Dict with Sequence protocol
    # V4: Nested tuples instead of lists
    # V5: Custom flatten with depth parameter
    
    # For merge_sorted:
    # V1: Custom comparator
    # V2: Descending order
    # V3: Custom key function
    # V4: Linked list instead of array
    # V5: Stable merge with duplicate handling
```

#### Tier 3: Novel Task Examples

```
NOVEL TASK 1: Cross-file dependency inference
  - Given N files with broken import chain
  - Restore functionality without human hints
  - Requires: understanding inter-file dependencies

NOVEL TASK 2: Non-standard protocol
  - Implement client for grammar-only protocol
  - No examples, no existing code
  - Requires: novel tool combination

NOVEL TASK 3: Hidden constraint discovery
  - System has unstated rules
  - Discover rules through exploration
  - Requires: hypothesis + verification loop

NOVEL TASK 4: Reverse engineering
  - Given compiled output, infer input constraints
  - Requires: counterfactual reasoning
```

---

## Implementation Plan

### Phase 1: Variant Task Generator (Week 1)

**Day 1-2**: Build variant generator framework
```python
class VariantGenerator:
    def generate_variants(task, num_variants=5):
        # Framework for generating variants
        # Each task type has variant templates
```

**Day 3-4**: Generate variants for existing tasks
- flatten_deep variants (5)
- merge_sorted variants (5)
- reverse_words variants (3)
- Additional tasks: as needed

**Day 5**: Validate variants are genuinely different
- Run base model on variants
- Verify <100% success (proves contamination avoided)

### Phase 2: Behavioral Metrics (Week 2)

**Day 6-7**: Implement sycophancy scenarios
```python
# BeHonest-style sycophancy measurement
SCENARIOS = {
    "persona_sycophancy": "You are a [persona]. Respond to: [question]",
    "preference_sycophancy": "I prefer [preference]. Respond: [question]",
    "consistency": "[same question, 5 formats]"
}
```

**Day 8-9**: Implement consistency scoring
- Same question, different formats
- Measure variance in responses
- Add CoT variable (with/without chain-of-thought)

**Day 10**: Integrate into benchmark
- Add `--metrics behavioral` flag
- Output: sycophany_rate, consistency_score, self_knowledge_rate

### Phase 3: Memory Quality Metrics (Week 3)

**Day 11-12**: Track belief store hallucinations
```python
# HaluMem-style memory hallucination tracking
def track_hallucinations(belief_store):
    # Check for:
    # - Fabricated facts (not from tool output)
    # - Contradicting beliefs
    # - Omissions (facts that should be there)
```

**Day 13-14**: Add memory metrics to output
- Hallucination rate
- Conflict rate
- Update latency
- Storage efficiency

### Phase 4: Efficiency Metrics (Week 4)

**Day 15-16**: Add token tracking to benchmark
```python
# Track tokens per task
# Track tool calls per task
# Track turns to solution
```

**Day 17-18**: Add compression ratio tracking
- Working memory size
- Episodic summary size
- Compression ratio per episode

**Day 19-20**: Full validation run
- Run all 3 tiers
- Compare: pi-braid vs baseline vs no-extensions
- Publish results

---

## Expected Results

```
TIER 1 (Standard): pi-braid should match/beat baseline
TIER 2 (Variants): pi-braid should show less drop than baseline
TIER 3 (Novel): pi-braid advantage most visible

Behavioral:
  - Sycophancy rate: pi-braid < baseline
  - Consistency: pi-braid more stable
  - Self-knowledge: pi-braid higher

Memory:
  - Hallucination rate: should be LOW
  - Conflict rate: should be LOW
  - Compression ratio: target 5-20x
```

---

## Key Papers Referenced

| Paper | arXiv | Key Contribution |
|-------|-------|-----------------|
| VAR-MATH | 2507.12885 | 48-73% drop on variabilized benchmarks → contamination measurable |
| AntiLeakBench | 2412.13670 | Contamination-free benchmark construction methodology |
| BeHonest | 2406.13261 | 3-dimension honesty benchmark |
| ACBench | 2505.19433 | Agent capability metrics beyond language modeling |
| HaluMem | 2511.03506 | Hallucination in memory systems evaluation |
| HWE-Bench | 2604.14709 | Novel task design (hardware bugs) |

---

## Status

**Ready to start** — Tier 1 (standard tasks) already exists. Add Tier 2 variants and Tier 3 novel tasks incrementally.

---

*Related: HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md*  
*Related: SELF-EVOLUTION-META-COGNITION-PROPOSAL.md*  
*Related: pi-braid/docs/RESEARCH-MASTER.md*