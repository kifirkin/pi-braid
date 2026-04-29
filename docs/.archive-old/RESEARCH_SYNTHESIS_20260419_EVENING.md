# Research Synthesis: April 19, 2026 (Evening)

## High-Impact Papers Found

### 1. Heartbeat-Driven Cognitive Scheduling (2604.14178) — CRITICAL

**Central finding**: Current agents use **reactive** control — fixed pipelines or failure-triggered reflection. This causes impulsivity or post-hoc correction.

**Solution**: Periodic "heartbeat" mechanism that proactively schedules cognitive modules based on temporal patterns and historical context.

**Architecture**:

```
Heartbeat (periodic tick)
    ↓
Scheduler (learns when to engage modules)
    ↓
Cognitive modules: Planner, Critic, Recaller, Dreamer
    ↓
Modules dynamically added/removed without reengineering
```

**Meta-learning**: Scheduler optimizes its strategy using historical interaction logs.

**Why critical for pi-braid metacognition**:

Our metacognition extension tries to do this ad-hoc. This paper gives the ARCHITECTURE:

```typescript
// Instead of: if (failure) invokeThink()
// Use heartbeat-driven proactive scheduling:

interface HeartbeatScheduler {
  modules: Map<string, CognitiveModule>;
  schedule(modules: string[]): void; // Which to activate, when
  learn(history: InteractionLog): void; // Meta-learning
}

// pi-braid metacognition becomes:
const heartbeat = new HeartbeatScheduler({
  modules: {
    planner: new PlannerModule(),
    critic: new CriticModule(),
    recaller: new RecallerModule(),
    dreamer: new DreamerModule(), // Reflection/consolidation
  },
});

// Heartbeat fires every N turns
pi.on("turn_end", () => {
  heartbeat.tick(ctx.turnHistory);
});

// Scheduler decides which modules to activate
// Based on temporal patterns + historical context
```

**Key insight**: The `think` tool is a module. The heartbeat decides WHEN to activate it — proactively, not reactively.

**Modules in pi-braid terms**:

- **Planner** → existing `planner` extension
- **Critic** → enforcement response analysis (judge)
- **Recaller** → `session-recall` / memory retrieval
- **Dreamer** → MARS-style reflection/consolidation (currently missing)

**Action**: Redesign metacognition around heartbeat scheduling. `think` is a module, not a reflex.

---

### 2. Credo: Declarative Control via Beliefs and Policies (2604.14401) — HIGH

**Central finding**: Current agents use **imperative** control loops — ephemeral memory, prompt-embedded logic. Makes behavior **opaque, brittle, unverifiable**.

**Solution**: Represent semantic state as **beliefs** and regulate behavior via **declarative policies**.

```
Beliefs (semantic state)
    ↓
Declarative Policies (rules over beliefs)
    ↓
Semantic Control Plane (database-backed)
    ↓
Adaptive, auditable, composable execution
```

**Key claim**: Policies declaratively guide execution choices (model selection, retrieval, corrective re-execution) **without changing pipeline code**.

**Why high-impact for pi-braid**:

Our enforcement is imperative — rules fire when violations detected. Credo suggests:

```typescript
// Instead of: if (violation) sendWhisper()
// Use declarative policies over beliefs:

interface Belief {
  id: string;
  content: string; // "agent_is_accurate", "context_is_clean"
  confidence: number; // 0-1
  timestamp: number;
}

interface Policy {
  trigger: (beliefs: Belief[]) => boolean;
  action: (ctx: ExecutionContext) => void;
}

// Policies are declarative:
const policies: Policy[] = [
  {
    trigger: (b) => b.find((b) => b.id === "context_oversized")?.confidence > 0.8,
    action: (ctx) => ctx.compact(),
  },
  {
    trigger: (b) => b.find((b) => b.id === "output_too_verbose")?.confidence > 0.7,
    action: (ctx) => ctx.signalReduceOutput(),
  },
];

// Semantic control plane:
const beliefStore = new BeliefStore(); // Database-backed
const policyEngine = new PolicyEngine(beliefStore, policies);

// Every turn: update beliefs, evaluate policies
pi.on("turn_end", () => {
  const beliefs = analyzeState(ctx);
  beliefStore.update(beliefs);
  policyEngine.evaluate();
});
```

**Benefits over current approach**:

1. **Auditable**: Every policy decision can be traced to beliefs
2. **Composable**: Add policies without modifying core logic
3. **Declarative**: "WHAT to do" not "HOW to do it"
4. **Verifiable**: Policies can be checked statically

**Action**: Refactor enforcement from imperative rules to declarative belief+policy system.

---

### 3. Stateful Evidence-Driven RAG (2604.14170) — MEDIUM

**Central finding**: Flat context representations + stateless retrieval = unstable RAG. Solution: persistent **evidence pool** with relevance + confidence signals.

**Architecture**:

```
Evidence Pool (persistent, structured)
    ↓
Deficiency Analysis (identify gaps + conflicts)
    ↓
Query Refinement (iterative)
    ↓
Stable evidence aggregation
```

**Why relevant for pi-braid session-recall**:

Our session-recall has memory but treats all memories flatly. Evidence-driven approach:

```typescript
// Instead of: retrieve relevant memories flatly
// Use evidence pool with confidence signals:

interface Evidence {
  content: string;
  relevance: number; // How relevant to current query
  confidence: number; // How certain the evidence is correct
  support: string[]; // Supporting evidence IDs
  conflict: string[]; // Contradicting evidence IDs
  timestamp: number;
}

// Evidence pool:
const evidencePool = new EvidencePool();

// Add evidence with signals:
evidencePool.add({
  content: "project uses TypeScript",
  relevance: 0.9,
  confidence: 0.8,
  support: [],
  conflict: [],
});

// Deficiency analysis:
const gaps = evidencePool.findGaps(currentQuery);
const conflicts = evidencePool.findConflicts();

// Query refinement:
if (gaps.length > 0 || conflicts.length > 0) {
  refineQuery({ gaps, conflicts });
}
```

**Key insight**: Evidence has CONFLICT signals. This directly maps to our contradiction detection from Cross-Query Contradictions paper.

---

### 4. PriHA Query Optimizer (2604.14215) — MEDIUM (Now We Have the Paper)

**This is the paper behind our deleted `query-optimizer` extension.** Now we have the actual paper, not just the extension's broken implementation.

**Key contribution**: Tri-stage pipeline:

1. **Query Optimizer**: Generalize user intent → sub-queries (SIMPLE/COMPLEX routing)
2. **DRAG**: Dual Retrieval — mixed-source retrieval
3. **Context Reorganization**: Generate with reorganized context

**The wrong domain problem in our deleted extension**:

The query-optimizer we deleted had MEDICAL body-part regexes (knee, back, head, stomach). PriHA is for **healthcare** — those regexes make sense there.

For pi-braid, we need CODING domain patterns:

```typescript
// What we need for pi-braid (not healthcare):
const CODING_INTENT_PATTERNS = {
  SIMPLE: [
    /^(list|find|show|get)\s+(me\s+)?(the\s+)?(\w+)/i, // Simple queries
    /\b(file|directory|folder|path)\b/i, // File system
    /\b(function|class|variable|import)\b/i, // Code structure
  ],
  COMPLEX: [
    /^(implement|build|create|refactor|optimize)\s+/i, // Complex tasks
    /\b(architecture|design|pattern|system)\b/i,
    /\b(error|bug|fix|debug)\b.*\b(trace|root|cause)\b/i,
  ],
};
```

**Action**: Refactor query-optimizer for coding domain using PriHA's tri-stage architecture.

---

### 5. CROP: Token-Efficient Reasoning (2604.14214) — MEDIUM

**Finding**: Cost-Regularized Prompt Optimization. 80.6% token reduction while maintaining accuracy. Uses textual feedback + accuracy feedback.

**Key technique**: Regularization on response length forces optimization to produce **concise prompts** with critical information only.

**pi-braid connection**: This is what anti-slop tries to do — reduce verbosity. CROP gives a formal approach:

```typescript
// CROP-style objective:
// minimize: L = -accuracy + λ * length_regularization
//
// For pi-braid enforcement whispers:
// Instead of: long explanations of why rules exist
// Use: minimal signal that triggers self-correction

const MINIMAL_WHISPER = {
  // Very short, high-impact signals:
  verbose: "Concise.",
  off_topic: "Refocus.",
  uncertain: "Verify.",
  contradicting: "Check consistency.",
};
```

---

## Synthesis: The Architecture We Need

Combining all papers, here's the architecture for pi-braid's next generation:

```
┌─────────────────────────────────────────────────────────┐
│ HEARTBEAT SCHEDULER (2604.14178)                        │
│  - Proactive cognitive module scheduling                │
│  - Meta-learning from interaction history               │
│  - Modules: Planner, Critic, Recaller, Dreamer          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ BELIEF + POLICY ENGINE (2604.14401)                     │
│  - Declarative policies over beliefs                    │
│  - Semantic control plane (database-backed)             │
│  - Auditable, composable, verifiable                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ EVIDENCE POOL (2604.14170)                             │
│  - Persistent structured evidence                       │
│  - Confidence + relevance signals                      │
│  - Conflict detection                                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ MEASUREMENT LAYER (from MEASUREMENT_GAP_SOLUTION)       │
│  - Token entropy (repetition patterns)                  │
│  - Topic coherence (anchor overlap)                    │
│  - Commitment tracking (Cross-Query)                   │
│  - Self-contradiction detection                        │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Priority

| Paper                    | Impact                                 | Effort | Priority |
| ------------------------ | -------------------------------------- | ------ | -------- |
| 2604.14178 Heartbeat     | CRITICAL — solves reactive → proactive | Medium | P0       |
| 2604.14401 Credo         | HIGH — declarative enforcement         | Medium | P1       |
| 2604.14170 Evidence Pool | MEDIUM — better memory                 | Medium | P2       |
| 2604.14214 CROP          | MEDIUM — concise whispers              | Low    | P2       |
| 2604.14215 PriHA         | MEDIUM — query optimizer refactor      | Medium | P3       |

---

## References

- [2604.14178](https://arxiv.org/abs/2604.14178) - Heartbeat-Driven Cognitive Scheduling
- [2604.14401](https://arxiv.org/abs/2604.14401) - Credo: Declarative Control via Beliefs and Policies
- [2604.14170](https://arxiv.org/abs/2604.14170) - Stateful Evidence-Driven RAG
- [2604.14215](https://arxiv.org/abs/2604.14215) - PriHA Query Optimizer (PAKDD 2026)
- [2604.14214](https://arxiv.org/abs/2604.14214) - CROP: Token-Efficient Reasoning (ICLR 2026 Workshop)
