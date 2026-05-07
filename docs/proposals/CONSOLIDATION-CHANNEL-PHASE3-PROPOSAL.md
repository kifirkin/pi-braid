# Proposal: Consolidation Channel — Phase 3 Self-Evolution

**Type**: Memory Architecture Enhancement  
**Based on**: Contextual Agentic Memory (2604.27707), MARS (2601.11974), Skill-SD (2604.24697)  
**Priority**: P0 (Critical path — completes Self-Evolution Loop)  
**Owner**: pi-braid research subagent  
**Worktree**: `~/projects/vibe/implicit-framing/pi-braid/` (branch: `worktree/braid-research`)

---

## Problem Statement

pi-braid's Self-Evolution Loop (Phases 1-2) implements **episodic memory only** — a lookup system, not true learning.

**Current architecture** (Phase 1-2):

```
Task → SOP extraction → memory_store (episodic) → retrieval → context injection
```

**The problem** (proven by 2604.27707):

- ❌ **Lookup ≠ Learning**: Retrieval generalizes by similarity, not abstract rules
- ❌ **Frozen Novice**: Same weights every session — no expertise development
- ❌ **Generalization Gap**: Theorem 1 proves Ω(k²) vs O(d) sample complexity for novel compositions
- ❌ **Persistent Compromise**: Injected content in memory → poisons ALL future sessions

**Result**: pi-braid accumulates notes, but never develops expertise.

---

## Key Paper: Contextual Agentic Memory (2604.27707)

### Core Argument

> "Current agentic memory systems implement lookup, not learning. Treating lookup as memory is a category error with provable consequences."

### Memory Taxonomy (Table 1 from paper)

| Type                       | Substrate      | Persists      | Updated by       | Generalizes    |
| -------------------------- | -------------- | ------------- | ---------------- | -------------- |
| Working                    | Context window | Session only  | Token generation | Limited        |
| **Episodic (Phase 1-2)**   | External store | Cross-session | Read/write ops   | Exemplar-based |
| Semantic                   | Model weights  | Permanent     | Pre-training     | Rule-based     |
| **Experiential (Phase 3)** | Model weights  | Permanent     | Fine-tuning/CL   | Rule-based     |

**pi-braid status**: Implements "Episodic" row only. Missing "Experiential" row.

### Four Structural Limitations (Proven)

#### 1. Generalization Gap (Theorem 1)

**Theorem**: For compositional novelty, retrieval requires Ω(k²) samples vs O(d) for weight-based memory.

**Proof sketch**:

- Retrieval covers n/N examples, accuracy = n/N + (1-n/N)·ᾱ
- Frozen model accuracy ᾱ < 1 for novel compositions (Assumption 3.2)
- Weight-based memory identifies composition rule ⊕ in d dimensions

**Translation**: SOPs won't help with truly novel task combinations. Need weight updates.

#### 2. Frozen Novice Problem

- Every session: same weights, same capabilities
- Novices organize by surface features; experts by deep principles (Chi et al., 1981)
- Transition requires weight changes (neocortical consolidation)
- Current system: "well-organized novice"

#### 3. Persistent Compromise

**Security asymmetry**:

- Stateless agent: p₀ per-session risk (transient injection)
- Agentic memory: P(compromised) = 1 - (1-p₀)^N(t) → 1 as N(t) → ∞

**Why**: Injected content written to store → retrieved in ALL future sessions (evil² effect)

#### 4. Definitional Ceiling

Lookup tables map seen inputs → stored outputs. Cannot extrapolate to unseen inputs requiring abstract rule application.

### Solution: Consolidation Channel

**Biological analogy** (Complementary Learning Systems theory):

- **Hippocampus**: Fast episodic storage (what we have: memory_store)
- **Neocortex**: Slow weight consolidation (what we need: Phase 3)

**Architecture**:

```
Experience → Episodic Store (memory_store)
                ↓
         [Consolidation Channel]
                ↓
         Weight Update (LoRA/MEMIT/Skill-SD)
                ↓
         Experiential Memory (permanent, generalizable)
```

---

## Proposed Architecture: Consolidation Channel

### Design Principles (from paper Section 5.1)

1. **Agentic memory is episodic lookup — treat it as such**
   - Vector stores/RAG = fast retrieval, not learning
   - Don't expect generalization from lookup

2. **A consolidation channel MUST exist**
   - Pathway from episodic store → parametric memory
   - Asynchronous (like biological sleep doesn't interrupt wakefulness)
   - Mechanisms exist: LoRA, MEMIT, TTT layers, Skill-SD

3. **Consolidation must be safe**
   - **Trace provenance**: origin of every distilled experience auditable
   - **Versioned checkpoints**: rollback capability
   - **Regression guards**: block consolidation if metrics degrade

### Technical Approach: Three Mechanisms

#### Option A: LoRA (Low-Rank Adaptation)

**Pros**: Lightweight, composable, easy rollback  
**Cons**: Adds inference overhead, limited capacity per adapter

**Implementation**:

```typescript
// Periodically: select valuable SOPs → distill → LoRA update
async function consolidateToLoRA(episodes: Episode[]): Promise<LoRAWeights> {
  const valuableEpisodes = episodes.filter((e) => e.outcome === "success" && e.sop);
  const distilledKnowledge = await distillToRules(valuableEpisodes);
  return await applyLoRA(model, distilledKnowledge);
}
```

#### Option B: MEMIT (Mass Editing Memory in Transformer)

**Pros**: Direct MLP layer editing, proven effective (Meng et al., 2023)  
**Cons**: Requires mechanistic interpretability infrastructure

**Use case**: Edit specific "knowledge neurons" for extracted principles

#### Option C: Skill-SD (Skill Self-Distillation)

**Pros**: Full paper (2604.24697) shows 0.68→0.79 accuracy gain  
**Cons**: More complex, needs careful distillation

**Framework**:

```
1. Generate traces from successful episodes
2. Self-distill: train on traces → update weights
3. Validate: no catastrophic forgetting
```

### Integration with Phase 1-2

**Phase 1** (✅ Implemented): SOP extraction (3-tier: strategic/functional/atomic)  
**Phase 2** (✅ Implemented): SOP retrieval + Coach decision  
**Phase 3** (🔴 This proposal): Consolidation to weights

**Data flow**:

```
Phase 1-2: memory_store (episodic)
                ↓
        [Select valuable experiences]
                ↓
        [Distill to abstract rules]
                ↓
        [Apply to weights via LoRA/MEMIT]
                ↓
        Phase 3: model weights (experiential)
```

---

## Implementation Plan

### Prerequisites Check

Subagent must verify before starting:

```bash
cd ~/projects/vibe/implicit-framing/pi-braid
git status  # Should be on worktree/braid-research branch
git log --oneline -5  # Should show Phase 1-2 commits
```

### Phase 3a: Experience Selection (Week 1)

**Goal**: Identify which episodes are worth consolidating

**Day 1-2**: Design selection criteria

```typescript
interface ConsolidationCandidate {
  episode: Episode;
  valueScore: number; // 0-1: how valuable is this experience?
  confidenceScore: number; // 0-1: how confident are we in the SOP?
  noveltyScore: number; // 0-1: how different from existing weights?
}

function selectCandidates(episodes: Episode[]): ConsolidationCandidate[] {
  return episodes
    .filter((e) => e.outcome === "success" && e.sop)
    .map((e) => ({
      episode: e,
      valueScore: computeValue(e), // Task importance, success rarity
      confidenceScore: computeConfidence(e.sop), // SOP clarity, verification
      noveltyScore: computeNovelty(e.sop), // Different from existing patterns
    }))
    .filter((c) => c.valueScore > 0.7 && c.confidenceScore > 0.8)
    .sort((a, b) => b.valueScore - a.valueScore);
}
```

**Day 3-4**: Implement distillation

```typescript
// Convert SOPs to training data
function distillToTrainingData(candidates: ConsolidationCandidate[]): TrainingExample[] {
  return candidates.map((c) => ({
    input: c.episode.taskDescription,
    output: c.episode.sop.atomicSteps.join("\n"), // Atomic SOP as target
    metadata: {
      taskType: c.episode.taskType,
      sopTier: c.episode.sop.tier,
      valueScore: c.valueScore,
    },
  }));
}
```

**Day 5**: Validation

- Test selection on existing episodes
- Ensure no selection of failed episodes
- Verify SOP quality threshold works

### Phase 3b: Weight Update Mechanism (Week 2)

**Day 6-7**: Implement LoRA infrastructure

```typescript
// Using peft-style LoRA (simplified)
class LoRAUpdater {
  private model: Model;
  private rank: number = 8; // LoRA rank

  async consolidate(candidates: ConsolidationCandidate[]): Promise<void> {
    const trainingData = distillToTrainingData(candidates);

    // Apply LoRA update
    const loraWeights = await this.trainLoRA(trainingData);
    await this.applyLoRA(loraWeights);

    // Checkpoint for rollback
    await this.checkpointWeights();
  }

  private async trainLoRA(data: TrainingExample[]): Promise<LoRAWeights> {
    // Implementation depends on model framework
    // (transformers.js, onnxruntime, etc.)
  }
}
```

**Day 8-9**: Alternative: MEMIT integration

```typescript
// If using MEMIT for targeted edits
async function applyMEMIT(principles: Principle[]): Promise<void> {
  for (const principle of principles) {
    // Locate relevant MLP layers (Meng et al., 2022)
    const targetLayers = await locateKnowledgeNeurons(principle);

    // Apply MEMIT update
    await editWeights({
      layers: targetLayers,
      newValue: principle.text,
      subject: principle.context,
    });
  }
}
```

**Day 10**: Safety infrastructure

```typescript
class ConsolidationSafety {
  // Trace provenance
  async recordProvenance(candidate: ConsolidationCandidate): Promise<void> {
    await memory_store({
      type: "consolidation_trace",
      episodeId: candidate.episode.id,
      sop: candidate.episode.sop,
      timestamp: Date.now(),
      hash: computeHash(candidate),
    });
  }

  // Versioned checkpoints
  async checkpoint(): Promise<string> {
    const checkpointId = `checkpoint_${Date.now()}`;
    await saveWeights(checkpointId);
    return checkpointId;
  }

  // Regression guard
  async validateConsolidation(preMetrics: Metrics, postMetrics: Metrics): Promise<boolean> {
    // Block if: accuracy dropped >5%, token efficiency dropped >10%
    return postMetrics.accuracy >= preMetrics.accuracy * 0.95;
  }
}
```

### Phase 3c: Asynchronous Scheduling (Week 3)

**Day 11-12**: Implement consolidation scheduler

```typescript
class ConsolidationScheduler {
  private heartbeat: HeartbeatScheduler;

  constructor() {
    // Run consolidation during "sleep" (between sessions, low activity)
    this.heartbeat.on("low_activity", () => this.triggerConsolidation());
  }

  async triggerConsolidation(): Promise<void> {
    const candidates = await selectCandidates(await getRecentEpisodes());

    if (candidates.length === 0) return;

    console.log(`Consolidating ${candidates.length} experiences...`);

    const preMetrics = await this.computeMetrics();
    await this.applyConsolidation(candidates);
    const postMetrics = await this.computeMetrics();

    if (!this.safety.validateConsolidation(preMetrics, postMetrics)) {
      await this.rollback();
      console.warn("Consolidation rejected: regression detected");
    }
  }
}
```

**Day 13-14**: Integration with heartbeat

- Wire consolidation scheduler to heartbeat's low-activity signal
- Ensure consolidation doesn't block agent operation
- Add metrics tracking (consolidation frequency, success rate)

### Phase 3d: End-to-End Validation (Week 4)

**Day 15-16**: Benchmark creation

```typescript
// Compositional Generalization over Time (CGT) benchmark
// (from paper Section 5.2)

async function runCGTBenchmark(): Promise<CGTMetrics> {
  const agent = new PiBraidAgent();

  // Phase 1: Train on isolated concepts
  for (const concept of ["sorting", "filtering", "mapping"]) {
    await agent.runTask(concept);
  }

  // Phase 2: Test compositional novelty
  const compositionalTask = "sort filtered mapped data";
  const accuracyBefore = await agent.evaluate(compositionalTask);

  // Run consolidation
  await agent.consolidate();

  // Test again
  const accuracyAfter = await agent.evaluate(compositionalTask);

  return {
    before: accuracyBefore,
    after: accuracyAfter,
    improvement: accuracyAfter - accuracyBefore,
  };
}
```

**Day 17-18**: Full pipeline test

```
1. Run tasks → generate episodes (Phase 1-2)
2. Trigger consolidation (Phase 3)
3. Test on novel compositions
4. Measure: CGT improvement >0%, token efficiency maintained
```

**Day 19-20**: Documentation + handoff

- Document consolidation channel architecture
- Update PI_BRAID_RESEARCH_ROADMAP.md
- Create subagent handoff document

---

## Metrics

| Metric                              | Baseline              | Target            | Method                                           |
| ----------------------------------- | --------------------- | ----------------- | ------------------------------------------------ |
| **CGT Improvement**                 | 0% (no consolidation) | >15%              | Compositional Generalization over Time benchmark |
| **SOP Usage (weight-based)**        | 0% (episodic only)    | >40%              | Tasks using consolidated SOPs                    |
| **Token Efficiency**                | current               | ≥95% of baseline  | Consolidated agents should be MORE efficient     |
| **Consolidation Safety**            | N/A                   | 100%              | No regressions allowed (rollback on degradation) |
| **Security: Injection Persistence** | evil² (persistent)    | evil¹ (transient) | Weight-based memories don't propagate injections |

### CGT Benchmark Design (from paper Section 5.2)

**Compositional Generalization over Time**:

1. Operate agent on domain for T sessions
2. Expose to concepts ONLY in isolation
3. After T sessions, evaluate on queries requiring combining 2+ concepts
4. **Genuinely learning agent**: accuracy ↑ with T
5. **Pure-retrieval agent**: accuracy flat at baseline

---

## Key Papers Referenced

| Paper                     | arXiv      | Key Contribution                                                   |
| ------------------------- | ---------- | ------------------------------------------------------------------ |
| Contextual Agentic Memory | 2604.27707 | **Core foundation**: Lookup ≠ learning, need consolidation channel |
| MARS                      | 2601.11974 | Single-cycle reflection, principle-based + procedural              |
| Skill-SD                  | 2604.24697 | Self-distillation from traces, 0.68→0.79 accuracy                  |
| MEMIT                     | 2303.18886 | Mass editing memory in transformer MLP layers                      |
| LoRA                      | 2106.09685 | Low-rank adaptation, lightweight weight updates                    |

---

## Deliverables

Subagent must produce:

1. **src/extensions/consolidation-channel.ts** — Main implementation
2. **src/extensions/lora-updater.ts** — LoRA weight update mechanism
3. **src/extensions/consolidation-scheduler.ts** — Heartbeat-wired scheduler
4. **src/extensions/consolidation-safety.ts** — Provenance + checkpoint + regression
5. **evaluation/benchmark_cgt.ts** — CGT benchmark implementation
6. **docs/consolidation-channel-architecture.md** — Technical documentation
7. **Updated PI_BRAID_RESEARCH_ROADMAP.md** — Phase 3 marked complete

---

## Status

**🔴 NOT STARTED** — Phase 1-2 complete, awaiting Phase 3 implementation.

**Blockers**: None — Phase 1-2 committed, research worktree ready.

**Next action**: Subagent runs `cd ~/projects/vibe/implicit-framing/pi-braid && git pull` then starts Phase 3a.

---

## Critical Notes for Subagent

1. **Worktree Path**: Use `~/projects/vibe/implicit-framing/pi-braid/` (NOT main worktree)
2. **Branch**: Should be on `worktree/braid-research`
3. **Phase 1-2 Code**: Already committed, look for `addEpisode()`, `addPrinciple()`, `recordToMemory()`
4. **Paper**: Read 2604.27707 fully — it's the theoretical foundation
5. **Safety First**: Always implement rollback before weight updates
6. **Benchmark**: CGT metric is the proof — show consolidation improves generalization

---

_Related: SELF-EVOLUTION-META-COGNITION-PROPOSAL.md (Phase 1-2)_  
_Related: HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md (memory infrastructure)_  
_Updated: 2026-05-02_
