# pi-braid Implementation Roadmap v1.0

**Version**: 1.0  
**Date**: 2026-04-19  
**Author**: Research synthesis (Braid agent)  
**Classification**: Research implementation roadmap  
**Status**: Working document — living specification

---

## Executive Summary

pi-braid is a cognitive extension system for the pi-coding-agent that provides implicit behavioral guidance, automatic measurement, and self-improvement capabilities. This roadmap specifies the full implementation plan from current state to target architecture.

**Current state**: 27 extensions, significant technical debt reduced but P0 issues remain.  
**Target state**: Declarative cognitive architecture with heartbeat-driven scheduling, three-memory stores, belief-based enforcement, and automatic measurement.

**Timeline**: 6-8 weeks for full implementation (foundations → cognitive core → advanced systems)

**Critical path**: Session isolation → Memory stores → Heartbeat scheduler → Measurement → Evidence pool

---

## Table of Contents

1. [Architecture Vision](#1-architecture-vision)
2. [Current State Analysis](#2-current-state-analysis)
3. [Research Foundation](#3-research-foundation)
4. [Implementation Phases](#4-implementation-phases)
5. [Phase 1: Foundations](#5-phase-1-foundations)
6. [Phase 2: Cognitive Core](#6-phase-2-cognitive-core)
7. [Phase 3: Advanced Systems](#7-phase-3-advanced-systems)
8. [Implementation Details](#8-implementation-details)
9. [Testing Strategy](#9-testing-strategy)
10. [Success Metrics](#10-success-metrics)
11. [Risk Analysis](#11-risk-analysis)
12. [Appendices](#12-appendices)

---

## 1. Architecture Vision

### 1.1 Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HEARTBEAT SCHEDULER                               │
│                    (Proactive Cognitive Scheduling)                       │
│                    Paper: 2604.14178 Heartbeat Scheduling                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │ PLANNER MODULE  │  │  CRITIC MODULE  │  │    RECALLER MODULE      │   │
│  │ Goal            │  │ Quality         │  │ Memory retrieval        │   │
│  │ Decomposition   │  │ Enforcement    │  │ Case matching          │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘   │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │ DREAMER MODULE  │  │ HEURISTICS      │  │  TOOL RELIABILITY       │   │
│  │ Reflection      │  │ Evolving rules  │  │  Success tracking       │   │
│  │ Consolidation   │  │ Priority-based  │  │  Adaptive selection     │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     BELIEF + POLICY ENGINE                                   │
│                   (Declarative Control Layer)                              │
│                    Paper: 2604.14401 Credo                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    BELIEF STORE                                     │  │
│  │  id: string                                                         │  │
│  │  content: string                                                    │  │
│  │  confidence: number (0-1)                                           │  │
│  │  timestamp: number                                                  │  │
│  │  source: "memory" | "web" | "code" | "parametric"                  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    POLICY ENGINE                                    │  │
│  │  trigger: (beliefs: Belief[]) => boolean                             │  │
│  │  action: (ctx: ExecutionContext) => void                            │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EVIDENCE POOL                                       │
│                  (Structured Memory System)                               │
│                    Paper: 2604.14170 Evidence Pool                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    EVIDENCE ENTRY                                    │  │
│  │  content: string                                                     │  │
│  │  source: "tool_call" | "memory" | "system_prompt" | "user_message"   │  │
│  │  relevance: number (0-1)                                            │  │
│  │  confidence: number (0-1)                                            │  │
│  │  support: string[] (supporting evidence IDs)                         │  │
│  │  conflict: string[] (contradicting evidence IDs)                    │  │
│  │  timestamp: number                                                   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      MEASUREMENT LAYER                                      │
│                  (Automatic Stability Detection)                            │
│                 Paper: 2604.14528 GUARD, 2604.14525 Cross-Query             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    STABILITY METRICS                               │  │
│  │  entropy: number        — Token diversity (repetition proxy)        │  │
│  │  coherence: number      — Topic anchor overlap                      │  │
│  │  commitmentMet: number  — Promise fulfillment rate                  │  │
│  │  contradictions: number — Self-contradictions detected            │  │
│  │  revisionCost: number   — Effort to fix inconsistencies          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Information Flow

```
User Request
    │
    ▼
┌─────────────────────────────────┐
│     RUMS MEMORY SELECTION       │  ← Paper: 2604.14473
│  (Mutual information selection) │
│  "Which memories minimize       │
│   response entropy?"            │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│      HEARTBEAT TICK             │  ← Paper: 2604.14178
│  (Periodic stability check)     │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│    MODULE SELECTION             │  ← Papers: 2604.14475 Evo-MedAgent
│  (Planner/Critic/Recaller/      │
│   Dreamer + Episodes/Heuristics│
│   /ToolReliability)            │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│    BELIEF UPDATE                │  ← Paper: 2604.14401 Credo
│  (Update belief store with      │
│   new evidence)                 │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│    POLICY EVALUATION            │  ← Paper: 2604.14401 Credo
│  (Evaluate all policies,         │
│   execute triggered actions)    │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│    MEASUREMENT                  │  ← Papers: 2604.14528, 2604.14525
│  (Compute stability metrics)    │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│    HEURISTICS EVOLUTION         │  ← Paper: 2604.14475 Evo-MedAgent
│  (Update rule priorities based  │
│   on outcomes)                  │
└─────────────────────────────────┘
    │
    ▼
Agent Output
```

### 1.3 Key Design Principles

| Principle                              | Source                            | Application                       |
| -------------------------------------- | --------------------------------- | --------------------------------- |
| **Declarative over imperative**        | Credo (2604.14401)                | Policies, not rules               |
| **Proactive over reactive**            | Heartbeat (2604.14178)            | Scheduling, not failure-triggered |
| **Mutual information over similarity** | RUMS (2604.14473)                 | Memory selection                  |
| **Acknowledge over suppress**          | XoT (2604.11209)                  | Conflicts                         |
| **Implicit over explicit**             | HER (2601.21459)                  | Framing                           |
| **No stakes framing**                  | Context Over Content (2604.15224) | Whispers                          |

---

## 2. Current State Analysis

### 2.1 Extension Inventory

| Extension                 | Lines | Status              | Priority |
| ------------------------- | ----- | ------------------- | -------- |
| context-manager           | 1914  | 🔴 Too large        | Refactor |
| enforcement               | 924   | 🟡 Needs work       | P0       |
| cognitive-memory          | 1181  | 🔴 Too large        | Refactor |
| scratchpad                | 844   | 🟡 Needs work       | P0       |
| healthcheck               | 859   | 🟡 Monolithic       | Keep     |
| metacognition             | 759   | 🟢 Clean            | Extend   |
| feedback                  | 690   | 🟡 Merge needed     | P1       |
| user-message-preprocessor | 664   | 🟡 Sync FS          | P1       |
| planner                   | 652   | 🟢 Working          | Extend   |
| prompt-builder            | 310   | 🟢 Working          | Extend   |
| browser                   | 695   | 🟢 Best in codebase | Keep     |
| prompt-guardian           | ~300  | 🟡 Sync FS          | P2       |
| repl                      | 213   | 🟡 Needs work       | P2       |
| Other (14 extensions)     | ~3000 | Mixed               | Varies   |

### 2.2 Technical Debt Inventory

#### P0: Blocking Issues

| Issue                             | Location        | Impact                     | Fix Complexity |
| --------------------------------- | --------------- | -------------------------- | -------------- |
| `process.cwd()` for session state | scratchpad L373 | Branch switch breaks state | Low            |
| `process.cwd()` for file paths    | enforcement L72 | Wrong file resolution      | Low            |
| Module-level mutable state        | All extensions  | No session isolation       | High           |
| Uncommitted dead deletions        | git             | Can't build/deploy         | Low            |

#### P1: Unblocking Issues

| Issue                                      | Location | Impact              | Fix Complexity |
| ------------------------------------------ | -------- | ------------------- | -------------- |
| Sync settings in user-message-preprocessor | L87-107  | Event loop blocking | Medium         |
| Sync prompts in prompt-guardian            | L42-50   | Event loop blocking | Medium         |
| Sync file reads in repl                    | L72-81   | Event loop blocking | Medium         |
| 45 remaining `as any` casts                | Multiple | Type safety         | Medium         |

#### P2: Structural Issues

| Issue                         | Location             | Impact              | Fix Complexity |
| ----------------------------- | -------------------- | ------------------- | -------------- |
| No dependency declaration     | index.ts             | Load order fragile  | Low            |
| No health reporting           | index.ts             | Failed loads silent | Low            |
| Duplicate enforcement systems | enforcement/feedback | Code bloat          | Medium         |

### 2.3 Progress Tracking

| Metric             | Before         | After        | Change  |
| ------------------ | -------------- | ------------ | ------- |
| Extension count    | 35             | 27           | -23%    |
| `as any` casts     | ~80            | ~45          | -44%    |
| Sync FS calls      | ~200           | ~70          | -65%    |
| Type.Union usage   | ~15            | 0            | -100%   |
| Hypothesis scoring | No             | Yes          | ✅ Done |
| Dead extensions    | Not identified | 8 identified | ✅ Done |

### 2.4 What's Working

| Component      | Status           | Notes                               |
| -------------- | ---------------- | ----------------------------------- |
| metacognition  | ✅ Clean         | Uses StringEnum, hypothesis scoring |
| enforcement    | ✅ Working       | Recent additions (Task 4a)          |
| prompt-builder | ✅ Working       | AGENTS.md consolidated              |
| browser        | ✅ Best practice | Proper API usage                    |
| type system    | ✅ Improved      | Type.Union → StringEnum             |

---

## 3. Research Foundation

### 3.1 Research Thread Mapping

| Thread                  | Research Question                                 | Key Papers                         | Implementation Target        |
| ----------------------- | ------------------------------------------------- | ---------------------------------- | ---------------------------- |
| **implicit-framing**    | Why does "You ARE" outperform "You MUST"?         | HER, BCR, 2604.14881, 2604.14717   | prompt-builder, whispers     |
| **cognitive-control**   | How to schedule cognitive modules proactively?    | 2604.14178, 2604.14401, 2604.14180 | heartbeat, beliefs, policies |
| **context-engineering** | How to manage context without losing knowledge?   | Batch, ACE, 2604.14170, 2604.14889 | evidence pool, compression   |
| **agent-architecture**  | How to build modular self-evolving agents?        | 2604.15034, 2604.14475, 2604.14473 | three memories, evolution    |
| **measurement**         | How to automatically measure reasoning stability? | 2604.14528, 2604.14525, 2604.15224 | stability metrics            |
| **knowledge-conflicts** | How to handle conflicting evidence faithfully?    | 2604.11209, 2604.14170, 2604.14525 | conflict detection, XoT      |

### 3.2 Paper Dependency Graph

```
HER (2601.21459) ──────────────────────────┐
                                           │
HumanLLM (2601.10198) ─────────────────────┤
                                           │
DPRF (2510.14205) ─────────────────────────┼──▶ implicit-framing
                                           │     (IMPLICIT > EXPLICIT)
BCR (2604.02322) ───────────────────────────┤
                                           │
2604.14881 (Missing Knowledge Layer) ───────┤
                                           │
2604.14717 (Layered Mutability) ────────────┘
        │
        └──▶ session isolation (P0)
             (identity hysteresis = 0.68)


2604.14178 (Heartbeat) ────────────────────┐
                                           │
2604.14401 (Credo) ────────────────────────┼──▶ cognitive-control
                                           │     (beliefs + policies)
2604.14180 (Internal Knowledge) ───────────┤
                                           │
2604.14528 (GUARD) ────────────────────────┘
        │
        └──▶ measurement (entropy detection)


2604.14475 (Evo-MedAgent) ─────────────────┐
                                           │
2604.15034 (Autogenesis) ───────────────────┼──▶ agent-architecture
                                           │     (three memory stores)
2604.14473 (RUMS) ──────────────────────────┤
                                           │
2604.14214 (CROP) ──────────────────────────┘


2604.14170 (Evidence Pool) ─────────────────┐
                                           │
2604.11209 (Knowledge Conflicts) ──────────┼──▶ knowledge-conflicts
                                           │     (XoT framework)
2604.14525 (Cross-Query) ───────────────────┘
        │
        └──▶ measurement (contradiction density)


context-engineering ← all threads
(bidirectional dependency on evidence pool)


THE PAPER (Compliance Theater) ← all threads
(connected to all 6 research threads)
```

### 3.3 Key Paper Summaries

#### Critical Papers (Must Understand)

**2604.14178 Heartbeat Scheduling**

- **Finding**: Reactive control (post-hoc) → Proactive control (heartbeat-driven)
- **Architecture**: Periodic tick → Scheduler decides which modules to activate
- **Modules**: Planner, Critic, Recaller, Dreamer
- **Meta-learning**: Scheduler optimizes its strategy using historical interaction logs
- **Application**: When to trigger `think` tool — proactively, not reactively

**2604.14401 Credo Declarative Control**

- **Finding**: Imperative rules → Declarative policies over beliefs
- **Architecture**: Belief store (semantic state) + Policy engine (trigger → action)
- **Benefits**: Auditable, composable, verifiable, database-backed
- **Application**: Replace enforcement rules with belief-based policies

**2604.14475 Evo-MedAgent Three Memory Stores**

- **Finding**: Three complementary stores outperform single memory
- **Architecture**:
  1. Retrospective Episodes: Case-based reasoning from similar past tasks
  2. Adaptive Procedural Heuristics: Priority-tagged rules that evolve via reflection
  3. Tool Reliability Controller: Per-tool trustworthiness tracking
- **Results**: MCQ accuracy 0.68 → 0.79 (GPT-5-mini), no training required
- **Application**: Transform flat memory into three-memory architecture

**2604.11209 Knowledge Conflicts (XoT)**

- **Finding**: Models pick evidence arbitrarily when sources conflict
- **Architecture**: Two-stage — (1) Evidence explanation + (2) Faithful reasoning
- **Key insight**: Acknowledge conflicts, don't suppress. Source tracking is critical.
- **Application**: Evidence pool needs source labels; conflicts acknowledged not resolved

#### High-Value Papers

**2604.14473 RUMS Memory Selection**

- **Finding**: Select memory by mutual information with response, not semantic similarity
- **Implementation**: Measure response entropy reduction per memory
- **Application**: Replace "similar to query" with "reduces response uncertainty"

**2604.14528 GUARD Failure Dynamics**

- **Finding**: Reasoning failures come from "early transition points" with entropy spikes
- **Measurement**: Token-level entropy proxy via repetition patterns
- **Application**: Detect instability before failure, not after

**2604.14525 Cross-Query Contradictions**

- **Finding**: Multi-query reasoning produces contradictory outputs
- **Metrics**: Case Satisfiability Rate, Contradiction Density, Revision Cost
- **Application**: Track commitment fulfillment and contradiction density

**2604.15224 Context Over Content**

- **Finding**: Stakes signaling (consequence framing) corrupts reasoning — ΔV = -9.8pp
- **Key insight**: The bias is IMPLICIT — chain-of-thought doesn't detect it (ERR_J = 0.000)
- **Application**: Whisper format must contain NO stakes language

#### Supporting Papers

**2604.14180 Internal Knowledge**

- Models know internally (perplexity jump 2.39x) but don't express externally
- Metacognition gap — enforcement bridges this gap

**2604.14881 Missing Knowledge Layer**

- Fluency ≠ reliability — confident output while reasoning has drifted
- ECL (Epistemic Control Loop) for stability

**2604.14717 Layered Mutability**

- Identity hysteresis = 0.68 — behavioral drift persists after self-description reset
- Five layers: pretraining → post-training → self-narrative → memory → weight

**2604.15034 Autogenesis**

- Self-evolution needs RSPL (resources with lifecycle/versioning) + SEPL (rollback)
- Propose → Assess → Commit pattern

**2604.14889 MemoSight**

- Type-aware compression: 66% KV reduction, 1.56x speedup
- Different content types need different strategies

**2604.14214 CROP**

- 80.6% token reduction via length regularization
- Application: CROP-style whispers — minimal signals

---

## 4. Implementation Phases

### 4.1 Phase Overview

| Phase                     | Duration  | Goal                             | Dependencies |
| ------------------------- | --------- | -------------------------------- | ------------ |
| Phase 1: Foundations      | 1-2 weeks | Fix broken infrastructure        | None         |
| Phase 2: Cognitive Core   | 2-4 weeks | Implement heartbeat + memories   | Phase 1      |
| Phase 3: Advanced Systems | 2-3 weeks | Implement evidence + measurement | Phase 2      |
| Phase 4: Research         | Ongoing   | Paper update + new findings      | Phases 1-3   |

### 4.2 Phase Dependencies

```
Phase 1 (Foundations)
    │
    ├──▶ P1.1 Session Isolation ─────────────────────────┐
    ├──▶ P1.2 Async Migration                            │
    ├──▶ P1.3 Type Safety                               │
    └──▶ P1.4 Dead Extension Cleanup                     │
                                                      │
                                                      ▼
Phase 2 (Cognitive Core)                              │
    │                                         (all Phase 2 depends on Phase 1)
    ├──▶ P2.1 Heartbeat Scheduler ─────────────────────┐
    ├──▶ P2.2 Three Memory Stores ──────────────────────┤
    ├──▶ P2.3 Belief + Policy Engine ──────────────────┤
    └──▶ P2.4 Topic Drift Detector ─────────────────────┘
                                                      │
                                                      ▼
Phase 3 (Advanced Systems)                            │
    │                                         (all Phase 3 depends on Phase 2)
    ├──▶ P3.1 Evidence Pool ────────────────────────────┐
    ├──▶ P3.2 Conflict QA System ───────────────────────┤
    ├──▶ P3.3 Automatic Measurement ───────────────────┤
    └──▶ P3.4 MARS Reflection ──────────────────────────┘
```

### 4.3 Quick Wins (Can Parallelize)

| Task                    | Effort  | Impact        | Dependencies |
| ----------------------- | ------- | ------------- | ------------ |
| Topic Drift Detector    | 1 hour  | High          | P1.1         |
| Commit dead extensions  | 1 hour  | Medium        | None         |
| CROP whispers           | 2 hours | Medium        | P2.3         |
| Dead extension analysis | 1 day   | Documentation | None         |

---

## 5. Phase 1: Foundations

**Duration**: 1-2 weeks  
**Goal**: Fix broken infrastructure that blocks everything else  
**Success criteria**: All P0 and P1 issues resolved

### 5.1 P1.1: Session State Isolation

**Priority**: P0  
**Effort**: 2-3 days  
**Risk**: Medium  
**Dependencies**: None

#### Problem Statement

pi-braid uses module-level mutable state that persists across session branch switches. When the user navigates to a different branch, module-level state is stale.

**Evidence**:

```typescript
// scratchpad/index.ts (Line 373)
function resolveProjectSlug(cwd?: string): string {
  return projectSlugFromCwd(cwd ?? process.cwd()); // ← Wrong on branch switch
}

// enforcement/state.ts
export const state = {
  config: { ...DEFAULT_CONFIG },
  turnHistory: new Map<number, TurnState>(),
  currentTurn: 0,
  // 30+ more fields persisting across sessions
};
```

**Impact**:

- Session data leaks across branches
- State becomes stale when working directory changes
- Module-level state is not garbage-collected on session end

#### Implementation

**Step 1**: Audit all module-level state usage

```bash
# Find module-level mutable declarations
grep -r "^let \|^const state\|^export const state" src/extensions/ --include="*.ts"
```

**Step 2**: Define session-scoped state interface

```typescript
// src/lib/session-state.ts

export interface SessionState {
  id: string; // From ctx.sessionId
  turns: Turn[];
  beliefs: Belief[];
  memories: Memory[];
  heuristics: Heuristic[];
  toolStats: ToolStats[];
}

export function createSessionState(sessionId: string): SessionState {
  return {
    id: sessionId,
    turns: [],
    beliefs: [],
    memories: [],
    heuristics: [],
    toolStats: new Map(),
  };
}
```

**Step 3**: Migrate scratchpad state

```typescript
// Before
let _taskStore: TaskStore | null = null;
let _currentProjectSlug: string = "";

// After
const _sessionStates = new Map<string, ScratchpadState>();

function getScratchpadState(ctx: ExtensionContext): ScratchpadState {
  const sessionId = ctx.sessionId;
  if (!_sessionStates.has(sessionId)) {
    _sessionStates.set(sessionId, {
      tasks: new TaskStore(),
      projectSlug: projectSlugFromCwd(ctx.cwd), // Use ctx.cwd
    });
  }
  return _sessionStates.get(sessionId)!;
}

// Cleanup on session end
pi.on("session_end", (event, ctx) => {
  _sessionStates.delete(ctx.sessionId);
});
```

**Step 4**: Migrate enforcement state

```typescript
// enforcement/state.ts
// Before: module-level singleton
export const state = { ... };

// After: session-scoped factory
export function createEnforcementState(): EnforcementState {
    return {
        config: { ...DEFAULT_CONFIG },
        turnHistory: new Map(),
        currentTurn: 0,
        beliefs: [],
        policies: []
    };
}
```

**Step 5**: Test session isolation

```typescript
// test/session-isolation.test.ts

test("state does not leak across branches", async () => {
  // Setup
  const ctx1 = createMockContext({ sessionId: "branch-1", cwd: "/project-a" });
  const ctx2 = createMockContext({ sessionId: "branch-2", cwd: "/project-b" });

  // Write state in branch 1
  await scratchpad.setGoal("Build API", ctx1);

  // Verify branch 1 state exists
  expect(await scratchpad.getGoals(ctx1)).toContain("Build API");

  // Verify branch 2 does NOT have branch 1 state
  expect(await scratchpad.getGoals(ctx2)).not.toContain("Build API");

  // Write state in branch 2
  await scratchpad.setGoal("Fix bug", ctx2);

  // Verify isolation
  expect(await scratchpad.getGoals(ctx2)).toContain("Fix bug");
  expect(await scratchpad.getGoals(ctx1)).not.toContain("Fix bug");
});
```

#### Verification

- [ ] All module-level state migrated to session-scoped storage
- [ ] `ctx.cwd` used instead of `process.cwd()`
- [ ] Session isolation tests pass
- [ ] Memory cleanup on session end

#### Files to Modify

| File                                     | Changes                         |
| ---------------------------------------- | ------------------------------- |
| `src/extensions/scratchpad/index.ts`     | Session-scoped state, ctx.cwd   |
| `src/extensions/enforcement/state.ts`    | Factory pattern, session-scoped |
| `src/extensions/cognitive-memory.ts`     | Session-scoped state            |
| `src/extensions/session-recall/index.ts` | Session-scoped state            |
| `src/lib/session-state.ts`               | New interface (optional)        |

---

### 5.2 P1.2: Async Migration

**Priority**: P1  
**Effort**: 2-3 days  
**Risk**: Low  
**Dependencies**: None

#### Problem Statement

200+ synchronous filesystem calls block the Node.js event loop. The codebase has `lib/async-storage.ts` for this purpose but it's underutilized.

**Evidence**:

```typescript
// user-message-preprocessor/index.ts (Lines 87-107)
if (!existsSync(SETTINGS_FILE)) return defaultValue;
const content = readFileSync(SETTINGS_FILE, "utf-8");
// ...
writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
```

#### Implementation

**Step 1**: Audit sync FS usage

```bash
grep -r "readFileSync\|writeFileSync\|existsSync\|statSync" src/extensions/ --include="*.ts" -c
```

**Step 2**: Migrate user-message-preprocessor settings

```typescript
// Before
function loadSettings(): PreprocessorSettings {
  if (!existsSync(SETTINGS_FILE)) return DEFAULT_SETTINGS;
  return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
}

// After
async function loadSettingsAsync(): Promise<PreprocessorSettings> {
  const { existsSync, readFileSync } = await import("node:fs/promises");
  if (!(await existsSync(SETTINGS_FILE))) return DEFAULT_SETTINGS;
  return JSON.parse(await readFileSync(SETTINGS_FILE, "utf-8"));
}
```

**Step 3**: Use debounced writes for frequent updates

```typescript
// Using lib/async-storage.ts
import { withDebounce } from "../../lib/async-storage.js";

const saveSettingsDebounced = withDebounce(
  async (settings: PreprocessorSettings) => {
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  },
  1000, // Debounce 1 second
);
```

#### Verification

- [ ] No `readFileSync/writeFileSync/existsSync` in hot paths
- [ ] Debouncing applied to frequent writes
- [ ] async-storage.ts used where appropriate

---

### 5.3 P1.3: Type Safety

**Priority**: P1  
**Effort**: 1 day  
**Risk**: Low  
**Dependencies**: None

#### Problem Statement

45 remaining `as any` casts and some improper type usage remain.

#### Implementation

**Step 1**: Audit remaining `as any`

```bash
grep -r "as any" src/extensions/ --include="*.ts" -n
```

**Step 2**: Replace with proper types

```typescript
// Before
execute: async (_toolCallId, params: any, ...) => {
    const { action, text } = params as ScratchpadToolInput;
}

// After
execute: async (_toolCallId, params, ...) => {
    const typedParams = params as TypeOf<typeof scratchpadTool.inputSchema>;
    const { action, text } = typedParams;
}
```

#### Verification

- [ ] All `as any` casts removed from tool execute handlers
- [ ] Type.Union replaced with StringEnum (already done)
- [ ] No `as unknown as` patterns

---

### 5.4 P1.4: Dead Extension Cleanup

**Priority**: P1  
**Effort**: 1 hour  
**Risk**: Low  
**Dependencies**: None

#### Problem Statement

8 extensions have been deleted from disk but not committed to git. Git state is dirty.

#### Implementation

```bash
cd /Users/kifir/projects/agents/pi-braid
git add -A
git commit -m "chore: remove dead extensions

Deleted (not salvageable):
- rate-limiter (non-functional event listening)
- reasoning (duplicate of enforcement)

Preserved but uncommitted:
- analytics (fixable)
- visual-dashboard (rebuildable)
- ab-testing (needs integration)

Technical debt reduction:
- 8 extensions removed
- ~3000 lines of dead code"
```

#### Verification

- [ ] `git status --short` shows clean (or only expected changes)
- [ ] Build succeeds
- [ ] Tests pass

---

## 6. Phase 2: Cognitive Core

**Duration**: 2-4 weeks  
**Goal**: Implement the heartbeat-driven cognitive architecture  
**Success criteria**: Heartbeat scheduler working, three memory stores operational

### 6.1 P2.1: Heartbeat Scheduler

**Priority**: P1  
**Effort**: 3-5 days  
**Risk**: Medium  
**Dependencies**: P1.1 (Session Isolation)

#### Research Basis

**Paper**: 2604.14178 Heartbeat Scheduling  
**Key finding**: Reactive control causes impulsivity or post-hoc correction. Proactive heartbeat-driven scheduling activates cognitive modules based on temporal patterns and historical context.

#### Architecture

```
┌─────────────────────────────────────────┐
│         HEARTBEAT SCHEDULER             │
├─────────────────────────────────────────┤
│                                         │
│  tick() → evaluate(modules) → activate  │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │      MODULE REGISTRY             │   │
│  │  - planner: PlannerModule        │   │
│  │  - critic: CriticModule         │   │
│  │  - recaller: RecallerModule     │   │
│  │  - dreamer: DreamerModule        │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │      HISTORY ANALYZER            │   │
│  │  - pattern detection            │   │
│  │  - interval optimization        │   │
│  │  - module effectiveness         │   │
│  └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
```

#### Implementation

```typescript
// src/extensions/heartbeat-scheduler/index.ts

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface CognitiveModule {
  name: string;
  activate(ctx: ExtensionContext): Promise<void>;
  shouldActivate(history: Turn[], ctx: ExtensionContext): boolean;
  priority: number;
}

interface HeartbeatConfig {
  interval: number; // Turns between ticks
  historyWindow: number; // Turns to analyze
  maxActivationsPerTick: number;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  interval: 5,
  historyWindow: 20,
  maxActivationsPerTick: 2,
};

export function createHeartbeatScheduler(
  pi: ExtensionAPI,
  modules: CognitiveModule[],
  config: Partial<HeartbeatConfig> = {},
): { start: () => void; stop: () => void } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = {
    enabled: false,
    turnCount: 0,
  };

  pi.on("turn_end", async (event, ctx) => {
    if (!state.enabled) return;

    state.turnCount++;

    if (state.turnCount % cfg.interval !== 0) return;

    // Analyze history
    const history = ctx.turnHistory.slice(-cfg.historyWindow);

    // Evaluate which modules should activate
    const candidates = modules
      .map((m) => ({
        module: m,
        shouldActivate: m.shouldActivate(history, ctx),
        priority: m.priority,
      }))
      .filter((c) => c.shouldActivate)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, cfg.maxActivationsPerTick);

    // Activate selected modules
    for (const candidate of candidates) {
      await candidate.module.activate(ctx);
    }
  });

  return {
    start: () => {
      state.enabled = true;
    },
    stop: () => {
      state.enabled = false;
    },
  };
}
```

#### Module Interface

```typescript
// src/extensions/heartbeat-scheduler/module.ts

import type { ExtensionContext, Turn } from "@mariozechner/pi-coding-agent";

export interface CognitiveModule {
  name: string;
  description: string;

  /**
   * Called by heartbeat scheduler to check if module should activate
   */
  shouldActivate(history: Turn[], ctx: ExtensionContext): boolean;

  /**
   * Called when module is activated
   */
  activate(ctx: ExtensionContext): Promise<void>;

  /**
   * Priority for activation (higher = more likely to be chosen)
   */
  priority: number;
}

// Example modules

export const plannerModule: CognitiveModule = {
  name: "planner",
  description: "Goal decomposition and planning",
  priority: 0.8,

  shouldActivate(history, ctx) {
    // Activate if: no active plan and user requested a complex task
    const lastUserMessage = history[history.length - 1]?.userMessage ?? "";
    const hasPlan = ctx.sessionEntries.some((e) => e.type === "plan");
    return !hasPlan && isComplexTask(lastUserMessage);
  },

  activate: async (ctx) => {
    // Trigger planning via whisper
    ctx.emit("cognitive:activate-planner", { reason: "heartbeat" });
  },
};

export const criticModule: CognitiveModule = {
  name: "critic",
  description: "Quality enforcement and verification",
  priority: 0.7,

  shouldActivate(history, ctx) {
    // Activate if: many turns without verification
    const turnsWithoutVerification = countTurnsSince(history, "verification");
    return turnsWithoutVerification > 10;
  },

  activate: async (ctx) => {
    ctx.emit("cognitive:activate-critic", { reason: "heartbeat" });
  },
};

export const recallerModule: CognitiveModule = {
  name: "recaller",
  description: "Memory retrieval and case matching",
  priority: 0.6,

  shouldActivate(history, ctx) {
    // Activate if: current task similar to past tasks
    const currentTask = getCurrentTask(history);
    return hasSimilarPastTask(currentTask, ctx);
  },

  activate: async (ctx) => {
    ctx.emit("cognitive:activate-recaller", { reason: "heartbeat" });
  },
};

export const dreamerModule: CognitiveModule = {
  name: "dreamer",
  description: "Reflection and knowledge consolidation",
  priority: 0.4,

  shouldActivate(history, ctx) {
    // Activate after complex session
    const turnCount = history.length;
    const successRate = calculateSuccessRate(history);
    return turnCount > 20 && successRate > 0.7;
  },

  activate: async (ctx) => {
    ctx.emit("cognitive:activate-dreamer", { reason: "heartbeat" });
  },
};
```

#### Integration with Existing Systems

```typescript
// In metacognition/index.ts (existing think tool)

export function registerHeartbeatModules(pi: ExtensionAPI): void {
  const scheduler = createHeartbeatScheduler(pi, [
    plannerModule,
    criticModule,
    recallerModule,
    dreamerModule,
  ]);

  // Integrate with existing think tool
  pi.on("cognitive:activate-dreamer", async (event, ctx) => {
    // Trigger think tool with dreamer context
    const thinkTool = pi.getTool("think");
    await thinkTool.execute(ctx, {
      type: "deep",
      prompt: "Reflect on this session's patterns and consolidate insights",
    });
  });

  scheduler.start();
}
```

#### Verification

- [ ] Heartbeat ticks every N turns (configurable)
- [ ] Module selection based on history analysis
- [ ] Meta-learning optimizes interval over time
- [ ] Integration with existing think tool works
- [ ] Memory cleanup on session end

---

### 6.2 P2.2: Three Memory Stores

**Priority**: P1  
**Effort**: 4-6 days  
**Risk**: Medium  
**Dependencies**: P2.1 (Heartbeat Scheduler)

#### Research Basis

**Paper**: 2604.14475 Evo-MedAgent  
**Key finding**: Three complementary stores (Episodes + Heuristics + ToolReliability) outperform single memory. Results: MCQ accuracy 0.68 → 0.79.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    THREE MEMORY STORES                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │     RETROSPECTIVE EPISODES                                 │  │
│  │     (Case-based reasoning from past tasks)                 │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │  episodes: Episode[]                                       │  │
│  │  retrieve(query): Episode[] — semantic similarity search  │  │
│  │  add(episode): void                                       │  │
│  │  prune(): void — remove low-value episodes                 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │     ADAPTIVE PROCEDURAL HEURISTICS                         │  │
│  │     (Priority-tagged rules that evolve)                   │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │  rules: HeuristicRule[]                                   │  │
│  │  addRule(condition, action): void                         │  │
│  │  evolve(outcome): void — update rule priorities            │  │
│  │  getPrioritizedRules(): Rule[]                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │     TOOL RELIABILITY CONTROLLER                            │  │
│  │     (Per-tool trustworthiness tracking)                    │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │  toolStats: Map<string, ToolStat>                         │  │
│  │  record(tool, task, success): void                        │  │
│  │  getReliability(tool, task): number                      │  │
│  │  selectBestTool(task): string                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Implementation

```typescript
// src/extensions/three-memory-stores/index.ts

/**
 * Retrospective Episodes Store
 * Case-based reasoning from similar past tasks
 */
export interface Episode {
  id: string;
  task: string;
  solution: string;
  outcome: "success" | "failure" | "partial";
  similarity: number;
  timestamp: number;
  toolSequence: string[];
}

export class RetrospectiveEpisodes {
  private episodes: Episode[] = [];
  private maxEpisodes: number = 1000;
  private similarityThreshold: number = 0.7;

  add(task: string, solution: string, outcome: Episode["outcome"], toolSequence: string[]): void {
    const episode: Episode = {
      id: generateId(),
      task,
      solution,
      outcome,
      similarity: 0, // Set on retrieval
      timestamp: Date.now(),
      toolSequence,
    };
    this.episodes.push(episode);
    this.prune();
  }

  retrieve(query: string, limit: number = 3): Episode[] {
    return this.episodes
      .map((ep) => ({
        ...ep,
        similarity: computeSimilarity(query, ep.task),
      }))
      .filter((ep) => ep.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  prune(): void {
    if (this.episodes.length <= this.maxEpisodes) return;

    // Remove oldest episodes with low outcome scores
    const ranked = this.episodes
      .map((ep) => ({ ep, score: this.episodeScore(ep) }))
      .sort((a, b) => a.score - b.score);

    this.episodes = ranked.slice(0, this.maxEpisodes).map((r) => r.ep);
  }

  private episodeScore(ep: Episode): number {
    const outcomeScore = ep.outcome === "success" ? 2 : ep.outcome === "partial" ? 1 : 0;
    return outcomeScore * 0.5 + (Date.now() - ep.timestamp) * 0.0000001;
  }
}

/**
 * Adaptive Procedural Heuristics Store
 * Priority-tagged rules that evolve via reflection
 */
export interface HeuristicRule {
  id: string;
  condition: string; // Pattern to match
  action: string; // What to do
  priority: number; // Higher = more important
  successRate: number; // 0-1, based on outcomes
  uses: number; // How many times used
  successes: number; // How many times succeeded
  lastUsed: number; // Timestamp
  created: number; // Timestamp
}

export class AdaptiveHeuristics {
  private rules: HeuristicRule[] = [];

  addRule(condition: string, action: string, initialPriority: number = 0.5): HeuristicRule {
    const rule: HeuristicRule = {
      id: generateId(),
      condition,
      action,
      priority: initialPriority,
      successRate: 0.5,
      uses: 0,
      successes: 0,
      lastUsed: 0,
      created: Date.now(),
    };
    this.rules.push(rule);
    return rule;
  }

  evolve(outcome: { ruleId: string; success: boolean }): void {
    const rule = this.rules.find((r) => r.id === outcome.ruleId);
    if (!rule) return;

    rule.uses++;
    if (outcome.success) rule.successes++;
    rule.successRate = rule.successes / rule.uses;
    rule.priority = this.calculatePriority(rule);
    rule.lastUsed = Date.now();
  }

  getPrioritizedRules(): HeuristicRule[] {
    return [...this.rules].sort((a, b) => b.priority - a.priority);
  }

  getApplicableRules(context: string): HeuristicRule[] {
    return this.rules
      .filter((r) => matchesCondition(context, r.condition))
      .sort((a, b) => b.priority - a.priority);
  }

  private calculatePriority(rule: HeuristicRule): number {
    // Blend of success rate and recency
    const successComponent = rule.successRate * 0.6;
    const recencyComponent =
      Math.max(0, 1 - (Date.now() - rule.lastUsed) / (7 * 24 * 60 * 60 * 1000)) * 0.2;
    const usageComponent = Math.min(rule.uses / 10, 1) * 0.2;
    return successComponent + recencyComponent + usageComponent;
  }
}

/**
 * Tool Reliability Controller
 * Per-tool trustworthiness tracking
 */
export interface ToolStat {
  tool: string;
  task: string;
  attempts: number;
  successes: number;
  lastAttempt: number;
}

export class ToolReliabilityController {
  private stats: Map<string, ToolStat> = new Map();

  record(tool: string, task: string, success: boolean): void {
    const key = `${tool}:${task}`;
    let stat = this.stats.get(key);

    if (!stat) {
      stat = { tool, task, attempts: 0, successes: 0, lastAttempt: 0 };
      this.stats.set(key, stat);
    }

    stat.attempts++;
    if (success) stat.successes++;
    stat.lastAttempt = Date.now();
  }

  getReliability(tool: string, task: string): number {
    const stat = this.stats.get(`${tool}:${task}`);
    if (!stat || stat.attempts === 0) return 0.5; // Default unknown reliability
    return stat.successes / stat.attempts;
  }

  selectBestTool(task: string, candidates: string[]): string | null {
    let bestTool: string | null = null;
    let bestReliability = -1;

    for (const tool of candidates) {
      const reliability = this.getReliability(tool, task);
      if (reliability > bestReliability) {
        bestReliability = reliability;
        bestTool = tool;
      }
    }

    return bestTool;
  }

  getToolStats(): ToolStat[] {
    return [...this.stats.values()];
  }
}
```

#### Integration with Heartbeat

```typescript
// src/extensions/three-memory-stores/integration.ts

export function integrateWithHeartbeat(
  pi: ExtensionAPI,
  episodes: RetrospectiveEpisodes,
  heuristics: AdaptiveHeuristics,
  toolReliability: ToolReliabilityController,
): void {
  // Track tool calls
  pi.on("tool_execution_end", (event, ctx) => {
    const task = extractTaskType(ctx.currentTask);
    toolReliability.record(event.toolName, task, !event.isError);
  });

  // On dreamer activation: reflection + evolution
  pi.on("cognitive:activate-dreamer", async (event, ctx) => {
    const outcome = evaluateLastSession(ctx);

    // Evolve heuristics based on outcomes
    for (const ruleOutcome of outcome.ruleOutcomes) {
      heuristics.evolve(ruleOutcome);
    }

    // Add new episode
    episodes.add(
      outcome.task,
      outcome.solution,
      outcome.success ? "success" : "failure",
      outcome.toolSequence,
    );
  });

  // Tool selection uses reliability
  pi.on("before_tool_execution", (event, ctx) => {
    const task = extractTaskType(ctx.currentTask);
    const candidates = getToolCandidates(event.toolName);

    if (candidates.length > 1) {
      const bestTool = toolReliability.selectBestTool(task, candidates);
      if (bestTool && bestTool !== event.toolName) {
        event.toolName = bestTool; // Route to more reliable tool
      }
    }
  });
}
```

#### Verification

- [ ] Episodes added on task completion
- [ ] Episodes retrieved by similarity
- [ ] Heuristics evolved on outcomes
- [ ] Tool reliability tracked per task
- [ ] Memory stores cleaned up on session end
- [ ] Integration with heartbeat works

---

### 6.3 P2.3: Belief + Policy Engine

**Priority**: P1  
**Effort**: 3-5 days  
**Risk**: Medium  
**Dependencies**: P1.1 (Session Isolation)

#### Research Basis

**Paper**: 2604.14401 Credo  
**Key finding**: Imperative rules → Declarative policies over beliefs. Database-backed semantic control plane.

#### Implementation

```typescript
// src/extensions/belief-policy-engine/index.ts

/**
 * Belief: Semantic state representation
 */
export interface Belief {
  id: string;
  content: string;
  confidence: number; // 0-1
  timestamp: number;
  source: "memory" | "web" | "code" | "parametric";
}

/**
 * Policy: Declarative trigger-action rule
 */
export interface Policy {
  id: string;
  name: string;
  description: string;

  /**
   * Condition that triggers the policy
   * Returns true if policy should execute
   */
  trigger: (beliefs: Belief[], ctx: ExtensionContext) => boolean;

  /**
   * Action to execute when triggered
   */
  action: (ctx: ExtensionContext) => Promise<void>;

  /**
   * Priority (higher = more likely to execute first)
   */
  priority: number;

  /**
   * Whether this policy is enabled
   */
  enabled: boolean;
}

export class BeliefPolicyEngine {
  private beliefs: Map<string, Belief> = new Map();
  private policies: Policy[] = [];
  private auditLog: Array<{ timestamp: number; policy: string; triggered: boolean }> = [];

  // Belief management
  setBelief(id: string, content: string, confidence: number, source: Belief["source"]): void {
    this.beliefs.set(id, { id, content, confidence, timestamp: Date.now(), source });
  }

  getBelief(id: string): Belief | undefined {
    return this.beliefs.get(id);
  }

  getAllBeliefs(): Belief[] {
    return [...this.beliefs.values()];
  }

  // Policy management
  addPolicy(policy: Policy): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => b.priority - a.priority);
  }

  removePolicy(id: string): void {
    this.policies = this.policies.filter((p) => p.id !== id);
  }

  // Policy evaluation
  async evaluate(ctx: ExtensionContext): Promise<void> {
    const beliefs = this.getAllBeliefs();

    for (const policy of this.policies) {
      if (!policy.enabled) continue;

      try {
        const triggered = policy.trigger(beliefs, ctx);

        this.auditLog.push({
          timestamp: Date.now(),
          policy: policy.name,
          triggered,
        });

        if (triggered) {
          await policy.action(ctx);
        }
      } catch (err) {
        console.error(`Policy ${policy.name} failed:`, err);
      }
    }
  }

  // Audit
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }
}

// Example policies

export function createEnforcementPolicies(engine: BeliefPolicyEngine): void {
  // Policy: If context is oversized, compact
  engine.addPolicy({
    id: "context-oversized",
    name: "Context Compaction",
    description: "Trigger compaction when context exceeds threshold",
    priority: 0.9,
    enabled: true,

    trigger: (beliefs, ctx) => {
      const oversized = beliefs.find((b) => b.id === "context_oversized");
      return oversized !== undefined && oversized.confidence > 0.8;
    },

    action: async (ctx) => {
      ctx.compact();
    },
  });

  // Policy: If output is too verbose, signal reduction
  engine.addPolicy({
    id: "output-verbose",
    name: "Output Reduction",
    description: "Signal output reduction when output exceeds threshold",
    priority: 0.8,
    enabled: true,

    trigger: (beliefs, ctx) => {
      const verbose = beliefs.find((b) => b.id === "output_too_verbose");
      return verbose !== undefined && verbose.confidence > 0.7;
    },

    action: async (ctx) => {
      ctx.emit("whisper", {
        message: "Concise.",
        type: "implicit",
        stakes: false,
      });
    },
  });

  // Policy: If topic drift detected, signal refocus
  engine.addPolicy({
    id: "topic-drift",
    name: "Topic Drift Refocus",
    description: "Signal topic refocus when drift is detected",
    priority: 0.85,
    enabled: true,

    trigger: (beliefs, ctx) => {
      const drifted = beliefs.find((b) => b.id === "topic_drift_detected");
      return drifted !== undefined && drifted.confidence > 0.5;
    },

    action: async (ctx) => {
      ctx.emit("whisper", {
        message: "Your response seems to cover different ground than the request.",
        type: "implicit",
        stakes: false,
      });
    },
  });
}
```

#### Verification

- [ ] Beliefs stored and retrieved correctly
- [ ] Policies trigger on correct conditions
- [ ] Actions execute when triggered
- [ ] Audit log captures all evaluations
- [ ] No stakes language in whisper actions

---

### 6.4 P2.4: Topic Drift Detector

**Priority**: P0 (Quick Win)  
**Effort**: 1-2 hours  
**Risk**: Low  
**Dependencies**: P1.1 (Session Isolation)

#### Problem

pi-braid produces fluent but off-topic output (the "braid paper" failure). No automatic detection.

#### Implementation

```typescript
// src/extensions/topic-drift-detector/index.ts

const TOPIC_ANCHORS = new Map<string, Set<string>>();

const TECHNICAL_TERMS = new Set([
  "pi-braid",
  "pi-coding-agent",
  "typescript",
  "javascript",
  "extension",
  "tool",
  "api",
  "context",
  "session",
  "enforcement",
  "metacognition",
  "cognitive",
]);

export function extractAnchors(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/\W+/);
  return new Set(
    tokens.filter(
      (t) => t.length > 4 && (TECHNICAL_TERMS.has(t) || /^[a-z]/.test(t)), // Lowercase tokens likely nouns
    ),
  );
}

export function measureOverlap(output: string, anchors: Set<string>): number {
  if (anchors.size === 0) return 1; // No anchors = no drift possible
  const outputTokens = new Set(output.toLowerCase().split(/\W+/));
  const matches = [...anchors].filter((a) => outputTokens.has(a));
  return matches.length / anchors.size;
}

export function detectTopicDrift(
  request: string,
  output: string,
  threshold: number = 0.5,
): { drifted: boolean; overlap: number; missing: string[] } {
  // Get or create anchors for this session
  let anchors = TOPIC_ANCHORS.get(request) ?? extractAnchors(request);
  TOPIC_ANCHORS.set(request, anchors);

  const overlap = measureOverlap(output, anchors);
  const missing = [...anchors].filter((a) => !output.toLowerCase().includes(a));

  return {
    drifted: overlap < threshold,
    overlap,
    missing,
  };
}

export function clearAnchors(request: string): void {
  TOPIC_ANCHORS.delete(request);
}
```

#### Integration

```typescript
// In enforcement or message handler
pi.on("message_end", async (event, ctx) => {
  if (!event.isAgentMessage) return;

  const drift = detectTopicDrift(ctx.userMessage, event.content);

  if (drift.drifted) {
    ctx.emit("whisper", {
      message: "Your response seems to cover different ground than the request mentioned.",
      type: "implicit",
      stakes: false,
    });
  }
});
```

#### Verification

- [ ] Detects "braid paper" failure mode
- [ ] Does not false-positive on legitimate topic evolution
- [ ] Whisper contains no stakes language

---

## 7. Phase 3: Advanced Systems

**Duration**: 2-3 weeks  
**Goal**: Implement evidence pool, conflict QA, automatic measurement, MARS reflection  
**Success criteria**: All advanced systems operational

### 7.1 P3.1: Evidence Pool

**Priority**: P2  
**Effort**: 4-6 days  
**Risk**: High  
**Dependencies**: P2.1 (Heartbeat), P2.3 (Belief+Policy)

### 7.2 P3.2: Conflict QA System

**Priority**: P2  
**Effort**: 3-5 days  
**Risk**: High  
**Dependencies**: P3.1 (Evidence Pool)

### 7.3 P3.3: Automatic Measurement

**Priority**: P2  
**Effort**: 3-4 days  
**Risk**: Medium  
**Dependencies**: P2.1 (Heartbeat)

### 7.4 P3.4: MARS Reflection

**Priority**: P2  
**Effort**: 3-4 days  
**Risk**: Medium  
**Dependencies**: P2.2 (Three Memory Stores)

---

## 8. Implementation Details

_(Full implementation details for Phase 3 will be added as Phase 2 completes)_

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Component            | Coverage Target | Key Tests                                       |
| -------------------- | --------------- | ----------------------------------------------- |
| Heartbeat Scheduler  | 90%             | tick timing, module selection, history analysis |
| Three Memory Stores  | 90%             | add/retrieve/prune, evolution, reliability      |
| Belief+Policy Engine | 90%             | belief CRUD, policy trigger/action, audit       |
| Topic Drift Detector | 90%             | overlap calculation, threshold calibration      |
| Evidence Pool        | 85%             | add/retrieve, conflict detection                |
| Measurement          | 85%             | entropy, coherence, contradiction metrics       |

### 9.2 Integration Tests

| Test                      | Description                                  | Success Criteria   |
| ------------------------- | -------------------------------------------- | ------------------ |
| Session Isolation         | State doesn't leak across branches           | 100% isolation     |
| Heartbeat → Memory        | Scheduler triggers memory operations         | Correct ordering   |
| Belief → Policy → Whisper | Beliefs trigger policies which emit whispers | Correct sequence   |
| RUMS Selection            | Memory selection minimizes response entropy  | Metric improvement |

### 9.3 End-to-End Tests

| Test                 | Description                       | Success Criteria                   |
| -------------------- | --------------------------------- | ---------------------------------- |
| Complex Task         | Full pipeline on complex task     | Task completed, metrics tracked    |
| Topic Drift Recovery | Agent drifts, recovers            | Drift detected, recovery whispered |
| Memory Evolution     | Multiple sessions, memory evolves | Accuracy improves over sessions    |

---

## 10. Success Metrics

### 10.1 Technical Metrics

| Metric               | Baseline | Target | Measurement                      |
| -------------------- | -------- | ------ | -------------------------------- |
| Extension count      | 27       | 25     | `find src -name "*.ts" \| wc -l` |
| `as any` casts       | 45       | 0      | `grep -r "as any" src/`          |
| Sync FS in hot paths | 70       | 0      | Audit                            |
| Session isolation    | Partial  | Full   | Integration tests                |
| Build time           | TBD      | < 30s  | `time npm run build`             |

### 10.2 Cognitive Metrics

| Metric                        | Baseline | Target | Measurement                 |
| ----------------------------- | -------- | ------ | --------------------------- |
| Heartbeat activation accuracy | N/A      | > 80%  | Module activation log       |
| Memory retrieval precision    | N/A      | > 70%  | Episode similarity scoring  |
| Heuristic success prediction  | N/A      | > 60%  | Predicted vs actual success |
| Tool reliability accuracy     | N/A      | > 75%  | Historical accuracy         |
| Drift detection rate          | N/A      | > 90%  | Manual labeling on sample   |

### 10.3 Outcome Metrics

| Metric                 | Baseline | Target | Measurement                  |
| ---------------------- | -------- | ------ | ---------------------------- |
| Task success rate      | TBD      | +10%   | End-to-end test suite        |
| Token efficiency       | TBD      | +20%   | Tokens per task              |
| False positive rate    | TBD      | < 10%  | Whisper classification       |
| Reflection improvement | N/A      | +5%    | Pre/post reflection accuracy |

---

## 11. Risk Analysis

### 11.1 Technical Risks

| Risk                               | Likelihood | Impact | Mitigation               |
| ---------------------------------- | ---------- | ------ | ------------------------ |
| Session isolation causes data loss | Medium     | High   | Comprehensive test suite |
| Memory store memory leak           | High       | Medium | Size limits + pruning    |
| Policy explosion                   | Low        | High   | Priority cutoff          |
| Heartbeat performance overhead     | Medium     | Low    | Configurable interval    |

### 11.2 Schedule Risks

| Risk                                            | Likelihood | Impact | Mitigation              |
| ----------------------------------------------- | ---------- | ------ | ----------------------- |
| P1 issues more complex than estimated           | Medium     | High   | Buffer time in Phase 1  |
| Research papers have implementation gaps        | Medium     | Medium | Design own solutions    |
| Integration testing reveals hidden dependencies | High       | Medium | Incremental integration |

### 11.3 Research Risks

| Risk                                           | Likelihood | Impact | Mitigation                   |
| ---------------------------------------------- | ---------- | ------ | ---------------------------- |
| Evo-MedAgent doesn't transfer to coding domain | Low        | Medium | Adjust memory store domains  |
| RUMS requires too many LLM calls               | High       | Medium | Cache response distributions |
| Heartbeat interval is arbitrary                | High       | Medium | Meta-learning optimization   |

---

## 12. Appendices

### Appendix A: Research Paper Index

| ID         | Title                                | arXiv       | Thread              |
| ---------- | ------------------------------------ | ----------- | ------------------- |
| 2601.21459 | HER: Human-Experience-Inspired RL    | 2601.21459  | implicit-framing    |
| 2601.10198 | HumanLLM: Human Implicit Preferences | 2601.10198  | implicit-framing    |
| 2510.14205 | DPRF: Dual Preference Framework      | 2510.14205  | implicit-framing    |
| 2602.07857 | EvoFSM: Implicit Budget              | 2602.07857  | implicit-framing    |
| 2604.02322 | BCR: Budget-Constrained Reasoning    | 2604.02322  | implicit-framing    |
| 2604.04258 | Compliance Theater                   | (our paper) | implicit-framing    |
| 2604.14881 | Missing Knowledge Layer              | 2604.14881  | implicit-framing    |
| 2604.14717 | Layered Mutability                   | 2604.14717  | implicit-framing    |
| 2604.14178 | Heartbeat Scheduling                 | 2604.14178  | cognitive-control   |
| 2604.14401 | Credo: Declarative Control           | 2604.14401  | cognitive-control   |
| 2604.14180 | Internal Knowledge                   | 2604.14180  | cognitive-control   |
| 2604.14528 | GUARD: Failure Dynamics              | 2604.14528  | measurement         |
| 2604.11974 | MARS: Single-Cycle Reflection        | 2601.11974  | cognitive-control   |
| 2604.14475 | Evo-MedAgent: Three Memories         | 2604.14475  | agent-architecture  |
| 2604.15034 | Autogenesis: Self-Evolution          | 2604.15034  | agent-architecture  |
| 2604.14473 | RUMS: Memory Selection               | 2604.14473  | measurement         |
| 2604.14214 | CROP: Token Efficiency               | 2604.14214  | agent-architecture  |
| 2511.04108 | Batch Context                        | 2511.04108  | context-engineering |
| 2510.04618 | ACE: Knowledge Preservation          | 2510.04618  | context-engineering |
| 2512.07993 | SkipKV: Async Storage                | 2512.07993  | context-engineering |
| 2604.14170 | Evidence Pool                        | 2604.14170  | context-engineering |
| 2604.14889 | MemoSight: KV Compression            | 2604.14889  | context-engineering |
| 2604.11209 | Knowledge Conflicts (XoT)            | 2604.11209  | knowledge-conflicts |
| 2604.14525 | Cross-Query Contradictions           | 2604.14525  | measurement         |
| 2604.15224 | Context Over Content                 | 2604.15224  | measurement         |
| 2604.14807 | LLM Fallacy                          | 2604.14807  | measurement         |

### Appendix B: Glossary

| Term                    | Definition                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| **Heartbeat**           | Periodic tick mechanism that triggers cognitive module evaluation |
| **Three Memory Stores** | Architecture: Episodes + Heuristics + ToolReliability             |
| **XoT**                 | Explanation-based Thinking — two-stage conflict resolution        |
| **RUMS**                | Response-Aware User Memory Selection — mutual information based   |
| **Belief**              | Semantic state representation with confidence and source          |
| **Policy**              | Declarative trigger-action rule over beliefs                      |
| **Topic Drift**         | Output topic diverging from request topic                         |

### Appendix C: File Structure

```
src/extensions/
├── heartbeat-scheduler/           # P2.1 (NEW)
│   ├── index.ts
│   ├── module.ts
│   └── integration.ts
├── three-memory-stores/          # P2.2 (NEW)
│   ├── index.ts
│   ├── episodes.ts
│   ├── heuristics.ts
│   ├── tool-reliability.ts
│   └── integration.ts
├── belief-policy-engine/         # P2.3 (NEW)
│   ├── index.ts
│   ├── beliefs.ts
│   ├── policies.ts
│   └── integration.ts
├── topic-drift-detector/        # P2.4 (NEW)
│   └── index.ts
├── evidence-pool/                # P3.1 (NEW)
│   └── index.ts
├── conflict-qa/                  # P3.2 (NEW)
│   └── index.ts
├── automatic-measurement/        # P3.3 (NEW)
│   └── index.ts
├── mars-reflection/              # P3.4 (NEW)
│   └── index.ts
├── metacognition/                # Extend
├── enforcement/                 # Refactor for beliefs
├── scratchpad/                  # P1.1 (Fix)
├── user-message-preprocessor/    # P1.2 (Async)
├── prompt-guardian/             # P1.2 (Async)
└── repl/                        # P1.2 (Async)
```

### Appendix D: Migration Checklist

```
Phase 1:
□ P1.1 Session Isolation
  □ Audit all module-level state
  □ Define session state interfaces
  □ Migrate scratchpad
  □ Migrate enforcement
  □ Migrate cognitive-memory
  □ Add session cleanup handlers
  □ Write session isolation tests

□ P1.2 Async Migration
  □ Audit sync FS calls
  □ Migrate user-message-preprocessor
  □ Migrate prompt-guardian
  □ Migrate repl
  □ Apply debouncing

□ P1.3 Type Safety
  □ Replace remaining as any
  □ Verify StringEnum usage
  □ Add runtime validation

□ P1.4 Dead Extension Cleanup
  □ Commit deletions to git
  □ Verify build succeeds
  □ Verify tests pass

Phase 2:
□ P2.1 Heartbeat Scheduler
  □ Define module interface
  □ Implement scheduler
  □ Create default modules (planner, critic, recaller, dreamer)
  □ Integrate with heartbeat
  □ Test module selection logic

□ P2.2 Three Memory Stores
  □ Implement RetrospectiveEpisodes
  □ Implement AdaptiveHeuristics
  □ Implement ToolReliabilityController
  □ Add evolution logic
  □ Integrate with heartbeat

□ P2.3 Belief + Policy Engine
  □ Define belief schema
  □ Implement belief store
  □ Define policy interface
  □ Implement policy engine
  □ Create enforcement policies
  □ Add audit logging

□ P2.4 Topic Drift Detector
  □ Implement anchor extraction
  □ Implement overlap measurement
  □ Add whisper integration
  □ Test on braid paper failure

Phase 3:
□ P3.1 Evidence Pool
□ P3.2 Conflict QA System
□ P3.3 Automatic Measurement
□ P3.4 MARS Reflection
```

---

**Document Version**: 1.0  
**Last Updated**: 2026-04-19  
**Next Review**: After Phase 1 completion  
**Owner**: Research synthesis (Braid agent)
