# Proposal: OpenMythos Looped Architecture Analysis

**Type**: Research + Architecture Study  
**Based on**: Bicameral Mind Analysis, Recursive Transformer Theory, Mythos Architecture Research  
**Priority**: P1 (Medium-term)  
**Owner**: implicit-framing / OpenMythos research

---

## The Question

OpenMythos uses a **looped/recursive transformer architecture** — a fundamentally different design from standard autoregressive LLMs. This raises critical questions for our research:

1. **What does the loop give the model that pi-braid's external scaffolding doesn't?**
2. **Can we approximate loop behavior through harness design?**
3. **Is the Mythos architecture the "right" way to solve unseen tasks, or just one way?**

## What We Know About Mythos

### From OpenMythos README

- Recursive transformer with persistent loop state
- Enables multi-turn self-improvement without context bloat
- "Mythic" persona layer for emergent behavior
- Persistent state across sessions (implied)

### From Agentic Looping Research

Key architectural properties of looped systems:

1. **State persistence**: Loop state survives context window, doesn't re-enter the prompt
2. **Self-referential updates**: Model can modify its own loop state through the loop
3. **Compression**: The loop compresses experience into latent representations
4. **Novel recombination**: Without training on task X, the loop can compose knowledge from past tasks to solve X

### The pi-braid Contrast

pi-braid achieves multi-turn persistence via:

- External belief store (D0)
- Heartbeat scheduler
- Three-memory system

These are **outside** the model. The model itself is stateless between turns.

**Key question**: Is there a qualitative difference between external persistence and internal (loop-based) persistence?

## Research Questions

### RQ1: Does Loop Architecture Enable Novel Task Solving?

**Hypothesis**: A recursive loop gives the model a "workspace" that can hold partial solutions, allowing iterative refinement across turns without context pollution.

**Test design**:

1. Create a task that requires "cross-turn carry" — the solution in turn N depends on state created in turn N-3
2. Compare: OpenMythos vs. pi-braid (with belief store)
3. If Mythos succeeds and pi-braid fails → loop architecture provides something external persistence can't
4. If both succeed → external persistence is sufficient

### RQ2: Can Harness Design Approximate Loop Behavior?

**Hypothesis**: Even without a loop, a sophisticated enough external scaffold can give the model "loop-like" capabilities.

**Test design**:

1. Implement in pi-braid:
   - A "workspace" belief that accumulates partial solutions
   - A "compression" step on each heartbeat that summarizes progress
   - A "resume" step that loads compressed state at turn start
2. Compare: pi-braid with workspace vs. pi-braid without
3. If workspace improves performance → harness can approximate loop
4. If not → loop architecture provides fundamental advantage

### RQ3: What Are the Limits of Loop Architecture?

Even if loops help, they may have limits:

- **State capacity**: How much can the loop hold?
- **Compression quality**: Does the loop compress well, or does it lose information?
- **Novel recombination ability**: Can the loop compose knowledge in ways not seen in training?

## Research Methods

### Method 1: Architecture Comparison Study

Study existing recursive transformer papers and compare to standard transformers:

| Property            | Standard Transformer | Recursive/Looped                | Mythos-specific |
| ------------------- | -------------------- | ------------------------------- | --------------- |
| Context handling    | Full context window  | Loop state + compressed context | Unknown         |
| Self-modification   | None                 | Via loop state updates          | Unknown         |
| State persistence   | None (context only)  | Persistent across turns         | Unknown         |
| Novel recombination | Emergent via context | Explicit via loop state         | Unknown         |

Key papers to review:

- Recurrent Transformer variants (various)
- RWKV / Mamba (linear attention = implicit recurrence)
- Long Range Arena (benchmark for context handling)
- Any published Mythos architecture details

### Method 2: Empirical Benchmark

Design comparison benchmark:

```
Task Set A: Standard multi-turn tasks
  - Fix N bugs across M files
  - Implement feature with cross-file dependencies
  - Answer question requiring history

Task Set B: "Novel recombination" tasks
  - Solve task using concepts from domain A applied to domain B (no cross-domain training)
  - "What if" counterfactual applied to problem
  - Novel tool combination (use tool X with Y's constraints)

Task Set C: Long-horizon carry
  - Solution in turn N depends on insight from turn N-3
  - Must remember compressed insight across 10+ turns
```

Measure: Mythos vs. pi-braid on each set. If Mythos wins on Set B/C but not A → loop architecture enables generalization.

### Method 3: Harness Enhancement Experiment

In pi-braid:

1. Implement "loop workspace" in belief store
2. Add "compression on heartbeat" (summarize progress)
3. Add "resume from compressed" (load summary at turn start)
4. Compare with/without workspace on Set B/C

## Deliverables

1. **Architecture Analysis Document**: Deep analysis of Mythos loop vs. pi-braid external scaffolding
2. **Comparative Benchmark**: Design + implementation + results
3. **Harness Enhancement Recommendation**: Can we build loop-equivalent in pi-braid? How?

## Open Questions

1. **Does Mythos expose any API for us to test?** If OpenMythos has a public deployment, we can run the benchmark ourselves
2. **Is there published architecture detail?** The README is thin. We may need to infer from behavior.
3. **What is the "mythic persona" layer?** This seems key — is it a personality injection, a reasoning style guide, or something else?
4. **Is the loop explicit (code) or implicit (architecture)?** This affects whether we can approximate it

## Timeline

```
Week 1: Architecture research
  - Read all available Mythos docs
  - Find recursive transformer papers
  - Identify testable hypotheses

Week 2: Design benchmark
  - Design Task Set B/C (novel recombination + long-horizon carry)
  - Create problems
  - Implement comparison methodology

Week 3: Run experiments
  - Test pi-braid baseline
  - Test with loop workspace enhancement
  - If Mythos accessible: test Mythos

Week 4: Analysis + recommendations
  - Compare results
  - Write architecture analysis
  - Produce harness enhancement recommendations
```

## Related Research

- pi-braid bicameral mind analysis (src/extensions/cognitive-systems/)
- HWE-Bench failure modes (localization/reasoning/coordination)
- AgentV-RL bidirectional verification
- DeepInsightTheorem technique selection

## Connection to Broader Research

This is the **"can harness give model new capabilities"** question:

```
Standard LLM: Solve tasks seen in training
  ↓
pi-braid harness: Solve tasks better via behavioral scaffolding
  ↓
Looped architecture (Mythos): Solve tasks NOT seen in training via internal state

Question: Is there a LEVEL 4?
  Looped architecture + harness: ???
```

Understanding this is critical for the implicit-framing research question: does compliance framing cause compliance behavior, or can we architect our way out of it?

---

## Status

**Not started** — pending Mythos architecture disclosure and benchmark design.

First concrete step: Get detailed Mythos architecture docs from OpenMythos team, or infer from behavior by running it on our benchmark tasks.

---

_Related: implicit-framing/docs/research/agent-architecture/BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md_  
_Related: pi-braid/docs/research/bicameral-mind-analysis.md_
