# Proposal: Hierarchical Memory Compression for pi-braid

**Type**: Architecture Enhancement  
**Based on**: GenericAgent (2604.17091), Experience Compression Spectrum (2604.15877), SimpleMem (2601.02553), Prometheus (2507.19942)  
**Priority**: P1  
**Owner**: pi-braid research + overnight development

---

## Problem Statement

pi-braid's three-memory system (working, episodic, long-term) exists but is **unwired**. The belief store (D0) is not integrated. The heartbeat scheduler's `R5` (three-memory recall) is not wired. This means:

- The agent accumulates **uncompressed context** → context bloat
- No **information density management** → noise overwhelms signal
- No **hierarchical compression** → all memory at same granularity
- No **self-evolution** → past trajectories not converted to reusable SOPs

Result: pi-braid agents struggle with long-horizon tasks, repeat mistakes, and waste tokens on redundant context.

---

## Key Papers: The Core Insights

### GenericAgent (2604.17091) — Context Information Density Maximization

```
GenericAgent principle: Long-horizon performance is determined by
how much DECISION-RELEVANT INFORMATION is maintained within a
finite context budget — NOT by context length.

Four components:
  1. Minimal atomic tool set — simple interface
  2. Hierarchical on-demand memory — high-level view by default
  3. Self-evolution — past trajectories → reusable SOPs
  4. Context truncation/compression layer — maintains information density

Results: Outperforms leading agents with FEWER tokens and interactions.
```

**Key insight for pi-braid**: Information density, not context length, determines performance.

### Experience Compression Spectrum (2604.15877) — The Missing Diagonal

```
Memory/Skills/Rules as a compression spectrum:
  Episodic memory: 5-20x compression
  Procedural skills: 50-500x compression
  Declarative rules: 1000x+ compression

20+ systems mapped — ALL operate at FIXED predetermined compression level.
NONE support adaptive cross-level compression.

The "missing diagonal": Systems that adaptively move along the compression
spectrum based on task demands.
```

**Key insight for pi-braid**: We need ADAPTIVE compression, not fixed levels. Tasks that need procedural memory should compress differently than tasks needing factual recall.

### SimpleMem (2601.02553) — Semantic Lossless Compression

```
Three-stage pipeline:
  1. Semantic Structured Compression — distill interactions into
     compact multi-view indexed memory units
  2. Online Semantic Synthesis — instantly integrate related context
     into unified abstract representations (intra-session)
  3. Intent-Aware Retrieval Planning — infer search intent to
     dynamically determine retrieval scope

Result: 30x token reduction, 26.4% F1 improvement on LoCoMo
```

**Key insight for pi-braid**: Semantic compression > truncation. Compress by MEANING, not by chopping off context.

### Prometheus (2507.19942) — Memory-Centric Coding Agent

```
Prometheus for codebase navigation:
  - Unified knowledge graph (semantic dependencies)
  - Context engine + working memory (retains explored contexts)
  - Memory-enhanced navigation (prevents repeated traversals)

Results: 74.4% SWE-bench Verified, 33.8% SWE-PolyBench Verified

Key insight: "temporal continuity of agent reasoning" prevents
repeated traversals — THIS is what pi-braid's three-memory should do.
```

**Key insight for pi-braid**: Working memory should REUSE explored contexts, not just store them.

---

## Proposed Architecture: pi-braid Hierarchical Memory

### The Three-Level Compression Model

```
┌─────────────────────────────────────────────────────────────┐
│              EXPERIENCE COMPRESSION SPECTRUM                 │
│                                                             │
│  LEVEL 1: WORKING MEMORY (Uncompressed)                    │
│    Raw context, recent turns                                 │
│    Compression: 1x (raw)                                     │
│    Purpose: Immediate reasoning                             │
│                                                             │
│  LEVEL 2: EPISODIC MEMORY (Compressed Summaries)           │
│    Summarized task episodes                                 │
│    Compression: 5-20x                                       │
│    Purpose: Multi-turn task coherence                       │
│                                                             │
│  LEVEL 3: PROCEDURAL MEMORY (SOPs + Rules)                  │
│    Reusable SOPs from successful trajectories               │
│    Compression: 50-500x                                     │
│    Purpose: Fast retrieval for similar tasks                │
│                                                             │
│  LEVEL 4: SEMANTIC MEMORY (Knowledge Graph)                │
│    Structured facts, dependencies, rules                   │
│    Compression: 1000x+                                      │
│    Purpose: Factual knowledge, cross-session coherence      │
└─────────────────────────────────────────────────────────────┘
```

### pi-braid Memory Components

```
D0: BELIEF STORE (Level 4 - Semantic/Knowledge Graph)
  - Structured facts from interactions
  - Cross-session persistent knowledge
  - Entity-relation triples
  - Zep/Graphiti-style temporal KG

R5: THREE-MEMORY RECALL (Level 2-3 - Episodic + Procedural)
  - Working: recent turns (uncompressed)
  - Episodic: summarized episodes (compressed)
  - Procedural: SOPs from successful trajectories

NEW: COMPRESSION LAYER (Level 1-2 transition)
  - Triggers on heartbeat
  - Evaluates information density
  - Compresses working → episodic when density drops
  - Extracts SOPs from successful episodes
```

### Compression Triggers

```
Trigger: Information density drops below threshold
  → Working memory contains >30% redundant/noisy content
  → Compression recommended

Trigger: Task completed successfully
  → Extract SOP from trajectory
  → Store in procedural memory
  → Compress episode summary

Trigger: Cross-session knowledge conflict detected
  → Update semantic memory (belief store)
  → Resolve conflicts
  → Notify agent of updated beliefs
```

---

## Implementation Plan

### Phase 1: Wire Existing Infrastructure (Week 1-2)

**Day 1-3**: Wire D0 belief store into heartbeat
```
- D0 stores structured beliefs (from R5 research)
- Heartbeat queries D0 on each trigger
- If relevant belief exists → inject into context
- Track belief coherence score

⚠️ NOTE: heartbeat-scheduler/src currently has `activatePolicyEngine()` 
UNDEFINED/NOT CALLED - this is the BLOCKER. Other agent is fixing this.
Once fixed, cognitive modules will fire and wiring cascades naturally.
```

**Day 4-5**: Wire R5 three-memory recall
```
- R5 already has working/episodic/procedural structure (other agent wiring)
- Wire to heartbeat: on turn N, recall relevant from episodic
- Implement retrieval intent inference
- Test: does memory recall improve task coherence?
```

**Day 6-7**: Add compression trigger to heartbeat
```
- Monitor working memory information density
- When density drops → trigger compression
- Compress working → episodic summary
- Log compression ratio for metrics
```

### Integration Notes (Parallel Work)

The other pi-braid agent is implementing:
```
Tier 1 (Hours 1-4):
  1.1 Activate heartbeat policy engine ◄── BLOCKER (being fixed)
  1.2 Wire real tool tracking
  1.3 Wire three-memory-stores to heartbeat
  1.4 Make analytics programmatically readable
  1.5 Wire belief-store to measurement module

Tier 2 (Hours 4-7):
  2.1 Create bidirectional verification tool
  2.2 Make session recall proactive
  2.3 Add budget-aware planning tool
  2.4 Wire context-lifecycle signal detector

Tier 3 (Hours 7-9):
  3.1 Fix enforcement judge → structured signals
  3.2 Fix nudge quality (specific + actionable)
  3.3 Wire error classification → enforcement retry
```

Our proposals integrate with these naturally:
- Hierarchical Memory → uses 1.3 (three-memory wiring) when ready
- Self-Evolution → uses 1.5 (belief store wired) + 3.2 (nudge quality)
- Bidirectional Verifier → maps to 2.1 (already in our proposals)
- Benchmark Improvements → validates the wiring works

### Phase 2: Self-Evolution (Week 3-4)

**Day 8-10**: SOP extraction from successful trajectories
```
- Track successful tool call sequences
- Extract as reusable SOPs
- Store in procedural memory
- On similar task: retrieve and suggest SOP
```

**Day 11-12**: ACE-inspired context evolution (2510.04618)
```
- Contexts as evolving playbooks
- Generate: build structured strategy from task
- Reflect: self-critique after task completion
- Curate: update playbook with lessons learned
```

**Day 13-14**: Validation
```
- Run benchmark with/without memory compression
- Measure: token usage, task success, cross-turn coherence
- Target: >30% token reduction with <5% accuracy loss
```

### Phase 3: Adaptive Cross-Level Compression (Week 5-6)

**Day 15-18**: Implement experience compression spectrum
```
- Detect task type (factual recall vs. procedural vs. episodic)
- Apply appropriate compression level
- Implement missing diagonal: adaptive cross-level
- Test on long-horizon tasks
```

**Day 19-20**: Knowledge graph integration
```
- Prometheus-style unified KG for codebase
- Integrate with D0 belief store
- Temporal continuity tracking
- Cross-session memory
```

---

## Connection to Other Proposals

| This Proposal | Builds On | Enables |
|---------------|-----------|---------|
| Hierarchical Memory | R5 three-memory (existing, unwired) | Bidirectional Verifier, Prometheus Memory |
| Self-Evolution SOPs | Heartbeat scheduler | MARS meta-cognition, ACE context evolution |
| Adaptive Compression | Experience Compression Spectrum | SimpleMem compression, GenericAgent density |
| KG Integration | D0 belief store (unwired) | Prometheus KG, Zep Graphiti |

---

## Metrics

| Metric | Baseline | Target | Method |
|--------|----------|--------|--------|
| Token usage per task | Current | <70% | Measure tokens in vs. tokens used |
| Cross-turn coherence | Unknown | >80% | Same task, turn N vs. turn N+5 similarity |
| SOP retrieval rate | N/A | >50% | Tasks that use procedural memory |
| Information density | Unknown | >0.7 | Compression ratio × task success |
| Repeated traversal avoidance | N/A | >60% | Prometheus metric |

---

## Key Papers Referenced

| Paper | arXiv | Key Contribution |
|-------|-------|-----------------|
| GenericAgent | 2604.17091 | Context information density maximization, self-evolving SOPs |
| Experience Compression Spectrum | 2604.15877 | Missing diagonal: adaptive cross-level compression |
| SimpleMem | 2601.02553 | Semantic lossless compression, 30x token reduction |
| Prometheus | 2507.19942 | Memory-centric coding agent, temporal continuity |
| ACE | 2510.04618 | Contexts as evolving playbooks: generate, reflect, curate |
| MARS | 2601.11974 | Meta-cognitive reflection, single-cycle self-improvement |
| LightThinker++ | 2604.03679 | Thought compression, 70% token reduction |
| HyMem | 2602.13933 | Hybrid memory with dual-granular storage |

---

## Status

**Not started** — Phase 1 (wiring existing infrastructure) is the first action. R5 and D0 already exist in pi-braid source — we just need to wire them together.

---

*Related: pi-braid/docs/RESEARCH-MASTER.md*  
*Related: docs/research/agent-architecture/LATENT-SPACE-AND-NOVEL-CAPABILITY.md*  
*Related: docs/research/agent-architecture/TOOL-AUGMENTED-REASONING-EXTENDED.md*