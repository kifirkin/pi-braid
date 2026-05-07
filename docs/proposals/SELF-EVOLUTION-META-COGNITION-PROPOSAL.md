# Proposal: Self-Evolution via Meta-Cognitive Reflection

**Type**: Cognitive Enhancement  
**Based on**: MARS (2601.11974), PRefLexOR (2410.12375), ACE (2510.04618), GenericAgent (2604.17091), ClawTrace (2604.23853)  
**Priority**: P0  
**Owner**: pi-braid research + overnight development

---

## Problem Statement

pi-braid has meta-cognition infrastructure (R3, R4) but it doesn't actually self-improve. After each task, the agent:

- ❌ Does NOT extract principles from success/failure
- ❌ Does NOT update its reasoning strategies
- ❌ Does NOT convert trajectories into reusable patterns

The agent starts each session at the same capability level, regardless of past performance.

Result: The same mistakes repeat. Successful strategies aren't captured. The agent can't learn from experience.

---

## Key Papers: Self-Evolution Mechanisms

### MARS (2601.11974) — Meta-Cognitive Reflective Self-Improvement

```
MARS: Mimics human learning through TWO reflection types:

1. PRINCIPLE-BASED REFLECTION (abstract normative rules)
   "What general rule should I follow to avoid errors?"
   → Abstract from specific mistakes to general principles

2. PROCEDURAL REFLECTION (derive step-by-step strategies)
   "What specific steps led to success?"
   → Extract actionable strategies from successful episodes

Key innovation: Works WITHIN A SINGLE RECURRENCE CYCLE
  → No multi-turn recursive loops (unlike other self-evolving systems)
  → Efficient: outperforms SOTA while reducing computational overhead
```

**Key insight for pi-braid**: Self-improvement doesn't need expensive multi-turn loops.
Two reflection types (principles + procedures) are sufficient.

### PRefLexOR (2410.12375) — Recursive Self-Teaching

```
Recursive approach:
  1. Build dynamic knowledge graph from reasoning traces
  2. Generate questions from random text + retrieval augmentation
  3. Preference optimization to enhance reasoning quality

Implemented in 3B models: even tiny models can teach themselves to reason
with greater depth and reflectivity.

Key innovation: Iterative refinement in thinking token framework.
```

**Key insight for pi-braid**: Even small agents can self-improve if given the right
recursive framework. pi-braid's lightweight architecture could still benefit.

### ACE (2510.04618) — Agentic Context Engineering

```
ACE treats contexts as EVOLVING PLAYBOOKS:
  - Generate: build structured strategy from task
  - Reflect: self-critique after completion
  - Curate: update playbook with lessons learned

Prevents:
  - Brevity bias (drops insights for summaries)
  - Context collapse (iterative rewriting erodes details)

Results: +10.6% on agents, +8.6% on finance benchmarks.
AppWorld leaderboard: matches top-ranked agent.
```

**Key insight for pi-braid**: Contexts should be living documents that evolve
through experience, not static templates.

### GenericAgent Self-Evolution (2604.17091)

```
Self-evolution in GenericAgent:
  1. Verify past trajectories
  2. Convert successful ones into reusable SOPs
  3. Store SOPs in procedural memory
  4. On similar task: retrieve and suggest SOP

Simple but powerful: Self-evolution = trajectory verification → SOP extraction → retrieval
```

**Key insight for pi-braid**: This is implementable NOW. We already track tool call
sequences. We just need to verify outcomes and extract SOPs.

---

## Proposed Architecture: pi-braid Self-Evolution

### The Loop

```
┌─────────────────────────────────────────────────────────────┐
│                   SELF-EVOLUTION LOOP                       │
│                                                             │
│  1. TASK EXECUTION                                         │
│     Agent completes task with tools                         │
│                                                             │
│  2. TRAJECTORY VERIFICATION                                 │
│     Did task succeed?                                       │
│     Was outcome correct?                                    │
│     Were steps optimal?                                     │
│     │                                                      │
│     ├─ SUCCESS → Extract SOP                              │
│     │   "What strategy worked?"                            │
│     │   → Store in procedural memory                      │
│     │                                                       │
│     ├─ FAILURE → Extract Principle                         │
│     │   "What rule did I violate?"                        │
│     │   → Update principle library                       │
│     │                                                       │
│     │                                                      │
│  3. CONTEXT EVOLUTION (ACE-inspired)                       │
│     Generate: Build structured playbook from task         │
│     Reflect: Self-critique after completion                 │
│     Curate: Update playbook with lessons                   │
│                                                             │
│  4. RETRIEVAL ON NEXT TASK                                 │
│     Similar task detected? → Retrieve relevant SOP         │
│     → Suggest strategy before execution                    │
└─────────────────────────────────────────────────────────────┘
```

### Implementation: The Two Reflection Types

```
REFLECTION TYPE 1: PRINCIPLE-BASED (from mistakes)
  Trigger: Task failed OR sub-optimal outcome
  Question: "What general rule should I follow to avoid this error?"
  Output: Updated principle in belief store

  Example:
    - Task: Bug fix was wrong
    - Principle: "Always verify fix by running failing test BEFORE editing"
    - Stored in D0 belief store

REFLECTION TYPE 2: PROCEDURAL (from success)
  Trigger: Task succeeded with good outcome
  Question: "What specific steps led to success?"
  Output: SOP in procedural memory

  Example:
    - Task: Fixed flatten bug
    - SOP: "1. Identify symptom file → 2. Run failing test → 3. Locate root cause → 4. Apply minimal fix → 5. Verify"
    - Stored in R5 procedural memory
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

Tier 3 (Hours 7-9):
  3.2 Fix nudge quality (specific + actionable)
  3.3 Wire error classification → enforcement retry
```

Our self-evolution plan integrates naturally:

- Trajectory verification → uses 1.2 (tool tracking wired) when ready
- SOP extraction → uses 1.3 (three-memory wired) when ready
- Principle extraction → uses 1.5 (belief store wired) when ready
- Context evolution (ACE) → uses 3.2 (nudge quality fixed) when ready

---

## Implementation Plan

### Phase 1: Trajectory Verification (Week 1)

**Day 1-2**: Add outcome tracking to heartbeat

```
- Track task completion status
- Record tool call sequence
- Store trajectory for reflection

Heartbeat: After task, flag trajectory for verification
```

**Day 3-4**: Implement SOP extraction

```
- Detect successful trajectories
- Extract step sequence as SOP
- Store in procedural memory (R5)
- Add pattern descriptor (what task type it solves)
```

**Day 5**: Implement principle extraction

```
- Detect failed/sub-optimal trajectories
- Ask: "What rule should I follow?"
- Generate principle text
- Store in belief store (D0)
```

### Phase 2: Retrieval and Suggestion (Week 2)

**Day 6-7**: SOP retrieval on task start

```
- On new task, analyze problem type
- Query procedural memory for similar SOPs
- If found: surface to agent BEFORE execution
- Agent can accept/skip/modify SOP
```

**Day 8-9**: Principle retrieval during execution

```
- Monitor for principle violation patterns
- If detected: inject principle as hint
- Log whether agent followed principle
```

**Day 10**: Metrics and validation

```
- SOP retrieval rate
- Principle adherence rate
- Task improvement from self-evolution
```

### Phase 3: ACE Context Evolution (Week 3)

**Day 11-12**: Generate playbook from task

```
- Build structured playbook structure
- Include: task type, tools used, strategies, outcome
- Store as evolving document in memory
```

**Day 13-14**: Reflect and curate

```
- After task: self-critique (ACE Reflect)
- Update playbook with lessons (ACE Curate)
- Prevent brevity bias and context collapse
```

### Phase 4: Full Integration (Week 4)

**Day 15-18**: End-to-end self-evolution loop

```
- Full pipeline: execute → verify → extract → retrieve → evolve
- Integrate with all existing extensions
- Test on benchmark tasks
```

**Day 19-20**: Validation

```
- Compare: baseline vs. self-evolution enabled
- Measure: task success, token usage, trajectory quality
- Target: >10% improvement on hard tasks
```

---

## Metrics

| Metric                      | Baseline | Target           | Method                                      |
| --------------------------- | -------- | ---------------- | ------------------------------------------- |
| SOP extraction rate         | N/A      | >30% of tasks    | Count extracted SOPs / total tasks          |
| Principle extraction rate   | N/A      | >10% of tasks    | Count extracted principles / total failures |
| SOP retrieval adherence     | N/A      | >50%             | Retrieved SOPs that were accepted           |
| Task improvement (self-evo) | baseline | >10%             | Hard task success with self-evolution       |
| Token efficiency            | current  | >80% of baseline | Tokens used with memory compression         |

---

## Key Papers Referenced

| Paper               | arXiv            | Key Contribution                                                                  |
| ------------------- | ---------------- | --------------------------------------------------------------------------------- |
| MARS                | 2601.11974       | Two reflection types: principle-based + procedural, single-cycle self-improvement |
| PRefLexOR           | 2410.12375       | Recursive self-teaching, knowledge graph from traces, preference optimization     |
| ACE                 | 2510.04618       | Contexts as evolving playbooks: generate, reflect, curate                         |
| GenericAgent        | 2604.17091       | Trajectory verification → SOP extraction → retrieval                              |
| HIERARCHICAL MEMORY | [prior proposal] | Memory infrastructure for SOP storage and retrieval                               |

---

## Status

**Not started** — First action is trajectory verification in heartbeat scheduler.

---

_Related: HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md (this folder)_  
_Related: pi-braid/docs/RESEARCH-MASTER.md_

### ClawTrace (2604.23853) — Cost-Aware Skill Distillation [NEW]

```
ClawTrace: Agent tracing platform that records every LLM call, tool use, and sub-agent spawn.
Compiles each session into a TraceCard: compact YAML with per-step USD cost, token counts, redundancy flags.

CostCraft distillation pipeline produces 3 patch types:
  1. PRESERVE patches: keep behaviors that led to success
  2. PRUNE patches: remove expensive steps that didn't matter (counterfactual)
  3. REPAIR patches: fix failures grounded in oracle evidence
```

**⚠️ CRITICAL FINDING**:

- **Prune patches transfer across tasks**: 32% median cost reduction on unrelated benchmarks
- **Preserve patches cause regressions**: trained on benchmark-specific conventions, fail on new task types
- **Both** cost attribution and prune patches independently reduce quality regressions

**Key insight for pi-braid**: We need BOTH preserve AND prune patches. But only prune patches should transfer across contexts. Preserve patches are task-specific.
