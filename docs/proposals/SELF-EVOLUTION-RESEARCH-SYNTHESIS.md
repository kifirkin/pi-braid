# pi-braid Self-Evolution: Research Synthesis

**Date**: 2026-04-23 (late evening)  
**Thread**: pi-braid / agent-architecture / self-evolution  
**Key Papers**: SkillX (2604.04804), PsychAgent (2604.00931), WebCoach (2511.12997), MUSE (2510.08002), EvolveR (2510.16079), AutoAgent (2603.09716), MemEvolve (2512.18746)

---

## Core Insight: Self-Evolution Patterns

Across all the self-evolving agent papers, a consistent pattern emerges:

```
SELF-EVOLUTION = VERIFY → EXTRACT → RETRIEVE → UPDATE

VERIFY: Did this trajectory succeed or fail?
EXTRACT: What principle/SOP can I derive from this?
RETRIEVE: Does a new task match any stored principles/SOPs?
UPDATE: How do I integrate the new knowledge?
```

The variations are in:

1. **What** gets extracted (principle vs. SOP vs. skill)
2. **When** extraction happens (after success, after failure, continuously)
3. **Where** it gets stored (belief store, procedural memory, skill knowledge base)
4. **How** retrieval works (similarity, intent inference, proactive recall)

---

## The Key Papers

### SkillX (2604.04804) — Most Relevant for pi-braid

```
Framework: Plug-and-play skill knowledge base
Three-tier hierarchy:
  1. Strategic plans (high-level)
  2. Functional skills (mid-level)
  3. Atomic skills (low-level)

Three mechanisms:
  1. Multi-Level Skills Design - distill trajectories into 3-tier hierarchy
  2. Iterative Skills Refinement - revise based on execution feedback
  3. Exploratory Skills Expansion - generate and validate novel skills

Key: Works on weaker agents (GLM-4.6 as backbone)
      Improves base agents that couldn't self-improve alone

pi-braid application:
  - The 3-tier hierarchy maps to our memory levels
  - Iterative refinement = our self-evolution loop
  - Exploratory expansion = new task → new SOP generation
```

### PsychAgent (2604.00931) — Longitudinal Memory Architecture

```
Three engines:
  1. Memory-Augmented Planning Engine - persistent memory + strategic planning
  2. Skill Evolution Engine - extract new skills from trajectories
  3. Reinforced Internalization Engine - integrate via rejection fine-tuning

Key: Rejection fine-tuning > standard fine-tuning
  Only integrates skills that improve diverse scenarios
  Preserves model capabilities while adding expertise

pi-braid application:
  - Skill Evolution Engine = our SOP extraction
  - Rejection fine-tuning = when to ACCEPT vs REJECT an SOP
    (only integrate if it improves across diverse tasks)
```

### WebCoach (2511.12997) — Cross-Session Memory Guidance

```
Three components:
  1. WebCondenser - standardize raw logs into concise summaries
  2. External Memory Store - organize trajectories as episodic experiences
  3. Coach - retrieve + decide whether to inject advice via runtime hooks

Key result: 47% → 61% on WebVoyager with 38B model
Key design: Coach decides "whether to inject advice" at runtime
  - Not just "retrieve" but "should I surface this?"

pi-braid application:
  - Coach decision = our "proactive recall" (R5)
  - WebCondenser = our compression layer
  - Coach injection via runtime hooks = our heartbeat-triggered corrections
```

### MUSE (2510.08002) — Experience-Driven Long-Horizon Agent

```
Key insight: Agent becomes increasingly capable as it accumulates experience
Zero-shot improvement on new tasks from accumulated experience

Framework:
  - Hierarchical Memory Module organizes diverse experience levels
  - After each sub-task: reflect → convert trajectory → integrate back into memory
  - TAC benchmark SOTA with lightweight model (Gemini-2.5 Flash)

pi-braid application:
  - Hierarchical Memory = our working/episodic/procedural layers
  - Sub-task reflection = our trajectory verification
  - Zero-shot generalization = what happens when retrieved SOP doesn't match perfectly
```

### MemEvolve (2512.18746) — Meta-Evolution of Memory Architecture

```
Key insight: The MEMORY SYSTEM ITSELF can evolve, not just what it stores

Framework: EvolveLab
  - Modular design space: encode, store, retrieve, manage
  - 12 representative memory systems distilled into this space
  - Jointly evolves: (1) experiential knowledge, (2) memory architecture

Key result: Improves SmolAgent and Flash-Searcher by up to 17.06%
Strong cross-task and cross-LLM generalization

pi-braid application:
  - Our memory architecture (D0, R5, heartbeat) can itself evolve
  - Not just "store more" but "change HOW we store"
  - This is the "missing diagonal" from Experience Compression Spectrum
```

### AutoAgent (2603.09716) — Elastic Memory Orchestrator

```
Elastic Memory Orchestrator:
  1. Raw records (uncompressed)
  2. Compressed trajectories
  3. Reusable episodic abstractions

Closed-loop cognitive evolution:
  - Aligns intended actions with observed outcomes
  - Continuously updates cognition + expands reusable skills
  - No external retraining required

pi-braid application:
  - Elastic memory = our compression spectrum
  - Closed-loop = our heartbeat-triggered verification cycle
```

### EvolveR (2510.16079) — Offline Self-Distillation + Online Interaction

```
Two-stage lifecycle:
  1. Offline Self-Distillation - trajectories → structured strategic principles
  2. Online Interaction - retrieve principles → guide decision-making → accumulate trajectories

Policy reinforcement mechanism updates agent based on performance

pi-braid application:
  - Offline distillation = our SOP extraction from successful trajectories
  - Online retrieval = our proactive recall
  - Policy reinforcement = our heuristic evolution
```

---

## The Unified Self-Evolution Architecture for pi-braid

```
┌─────────────────────────────────────────────────────────────────┐
│                    SELF-EVOLUTION LOOP                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ TRAJECTORY TRACKING (heartbeat scheduler)                  │ │
│  │ - Record: tool calls, outcomes, turn count                 │ │
│  │ - Trigger: task completion, failure, significant turn       │ │
│  └───────────────────────────────────────────────────────────┘ │
│                           ↓                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ VERIFICATION (heartbeat policy engine)                     │ │
│  │ - Did task succeed?                                        │ │
│  │ - Were steps optimal?                                      │ │
│  │ - Was outcome correct?                                     │ │
│  └───────────────────────────────────────────────────────────┘ │
│                           ↓                                     │
│              ┌─────────────┴─────────────┐                    │
│              ↓                           ↓                    │
│    ┌──────────────────┐      ┌──────────────────┐           │
│    │ SUCCESS PATH     │      │ FAILURE PATH     │           │
│    │ → Extract SOP    │      │ → Extract Principle│          │
│    │ (3-tier: strategic│      │ "What rule did   │          │
│    │  functional,      │      │  I violate?"      │          │
│    │  atomic)         │      │                  │          │
│    └──────────────────┘      └──────────────────┘           │
│              ↓                           ↓                    │
│    ┌─────────────────────────────────────────────┐           │
│    │ STORAGE (pi-braid memory layers)             │           │
│    │  Tier 1: Working (raw trajectory)           │           │
│    │  Tier 2: Episodic (compressed summary)       │           │
│    │  Tier 3: Procedural (SOPs, principles)       │           │
│    │  Tier 4: Semantic (belief store, KG)         │           │
│    └─────────────────────────────────────────────┘           │
│                           ↓                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ RETRIEVAL + DECISION (R5 three-memory recall)             │ │
│  │ - Analyze new task type                                   │ │
│  │ - Query procedural for matching SOPs                      │ │
│  │ - Query belief store for relevant principles              │ │
│  │ - COACH DECISION: Should I surface this advice?            │ │
│  │   (similar to WebCoach's runtime hook decision)             │ │
│  └───────────────────────────────────────────────────────────┘ │
│                           ↓                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ INJECTION (heartbeat-triggered)                           │ │
│  │ - Surface SOP as suggestion to agent                      │ │
│  │ - Inject principle as hint                                │ │
│  │ - Agent can accept/skip/modify                            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                           ↓                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ FEEDBACK LOOP                                             │ │
│  │ - Did agent follow SOP? → Track adherence                 │ │
│  │ - Did SOP help? → Track outcome improvement                │ │
│  │ - Refine SOP if needed (SkillX-style iterative refinement) │ │
│  │ - Reject SOP if it degrades performance (PsychAgent-style)  │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Integration with Parallel pi-braid Agent

The other agent is wiring:

- 1.1: `activatePolicyEngine()` — THE BLOCKER
- 1.2: Real tool tracking
- 1.3: Three-memory-stores to heartbeat
- 1.5: Belief store to measurement module

Our self-evolution loop requires:

- 1.2 (tool tracking) → for trajectory verification
- 1.3 (three-memory wired) → for SOP/procedure storage
- 1.5 (belief store wired) → for principle storage

**Once 1.1, 1.2, 1.3, 1.5 are wired, our self-evolution loop can cascade.**

---

## Priority Actions

### Immediate (Parallel to Tier 1 wiring)

1. **Design SOP extraction algorithm**
   - Input: successful trajectory (tool call sequence + outcome)
   - Output: 3-tier SOP (strategic plan → functional skill → atomic steps)
   - SkillX's multi-level distillation is the reference

2. **Design principle extraction algorithm**
   - Input: failed trajectory (tool call sequence + error)
   - Output: general rule violated
   - MARS's principle-based reflection is the reference

3. **Design Coach decision mechanism**
   - Input: retrieved SOP/principle + current task context
   - Output: Should I inject? Yes/No + confidence
   - WebCoach's Coach component is the reference

### After Tier 1 Complete (1.1, 1.2, 1.3, 1.5 wired)

4. **Implement trajectory tracking**
5. **Implement SOP/principle extraction**
6. **Implement Coach decision**
7. **Implement injection and feedback**

### Validation

8. **Benchmark with vs without self-evolution**
   - Hard tasks: success rate improvement
   - Repeated tasks: efficiency improvement
   - New tasks: zero-shot generalization

---

## New Papers to Add to Bibliography

| arXiv      | Title                                                    | Key for pi-braid                                 |
| ---------- | -------------------------------------------------------- | ------------------------------------------------ |
| 2604.04804 | SkillX: Automatically Constructing Skill Knowledge Bases | 3-tier hierarchical skills, iterative refinement |
| 2604.00931 | PsychAgent: Experience-Driven Lifelong Learning          | Rejection fine-tuning, longitudinal memory       |
| 2604.09815 | EE-MCP: Self-Evolving MCP-GUI Agents                     | Experience bank, distillation vs exploration     |
| 2510.08002 | MUSE: Experience-Driven Self-Evolving Agent              | Hierarchical memory, zero-shot generalization    |
| 2510.16079 | EvolveR: Experience-Driven Lifecycle                     | Offline distillation + online retrieval          |
| 2511.12997 | WebCoach: Cross-Session Memory Guidance                  | Coach decision, WebCondenser compression         |
| 2511.10395 | AgentEvolver: Self-Evolving Agent System                 | Self-questioning, curiosity-driven generation    |
| 2512.18746 | MemEvolve: Meta-Evolution of Memory                      | Memory architecture evolution, EvolveLab         |
| 2603.09716 | AutoAgent: Evolving Cognition + Elastic Memory           | Elastic Memory Orchestrator                      |
| 2410.20285 | SWE-Search: MCTS for Software Agents                     | MCTS + self-feedback + multi-agent debate        |
| 2602.13594 | Hippocampus: Efficient Memory for Agentic AI             | Binary signatures, 31x latency reduction         |
| 2603.24576 | Chameleon: Episodic Memory for Robotics                  | Geometry-grounded tokens, differentiable stack   |
| 2511.17208 | EMem: Event-Centric Long-Term Memory                     | Event semantics, EDUs, heterogeneous graph       |

---

## Status

**Not started** — Waiting on Tier 1 wiring from parallel agent.
Once `activatePolicyEngine()` is called, the cognitive modules fire and wiring cascades.

The self-evolution design is COMPLETE. Implementation can proceed once infrastructure is wired.

---

_Related: docs/research/pi-braid-proposals/SELF-EVOLUTION-META-COGNITION-PROPOSAL.md_  
_Related: docs/research/pi-braid-proposals/HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md_
