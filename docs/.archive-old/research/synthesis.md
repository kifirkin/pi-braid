# Thread Synthesis: Agent Architecture

**Date**: 2026-04-19  
**Research Question**: How do we build modular, self-evolving agents with auditable state?

---

## Core Papers

### Autogenesis (2604.15034)

**Finding**: Self-evolution needs RSPL + SEPL with rollback

**Key architecture**:

```
RSPL: Resource Substrate Protocol Layer
    - Resources have explicit state
    - Lifecycle management
    - Versioned interfaces

SEPL: Self Evolution Protocol Layer
    - Propose → Assess → Commit
    - Auditable lineage
    - Rollback capability
```

**Minimal implementation**:

```typescript
interface VersionedState<T> {
  current: T;
  history: Array<{
    value: T;
    timestamp: number;
    lineage: string;
  }>;
}

function safeEvolve<T>(
  state: VersionedState<T>,
  propose: (current: T) => T,
  assess: (proposed: T) => boolean,
): T {
  const proposed = propose(state.current);
  if (!assess(proposed)) {
    throw new Error("Assessment failed");
  }
  // Save current for rollback
  state.history.push({
    value: state.current,
    timestamp: Date.now(),
    lineage: generateLineage(),
  });
  state.current = proposed;
  return proposed;
}
```

**pi-braid connection**: evolve extension needs version tracking + rollback

### PriHA Query Optimizer (2604.14215)

**Finding**: Tri-stage pipeline: Query Optimization → DRAG → Context Reorganization

**Stages**:

1. **Query Optimizer**: Generalize user intent → sub-queries (SIMPLE/COMPLEX routing)
2. **DRAG**: Dual Retrieval — mixed-source retrieval
3. **Context Reorganization**: Generate with reorganized context

**Key insight**: Fast heuristic classification (no LLM) for simple queries, LLM for complex.

**pi-braid connection**: Refactor our deleted query-optimizer for CODING domain:

```typescript
const CODING_INTENT_PATTERNS = {
  SIMPLE: [
    /^(list|find|show|get)\s+(me\s+)?(the\s+)?(\w+)/i,
    /\b(file|directory|folder|path)\b/i,
    /\b(function|class|variable|import)\b/i,
  ],
  COMPLEX: [
    /^(implement|build|create|refactor|optimize)\s+/i,
    /\b(architecture|design|pattern|system)\b/i,
  ],
};
```

### CROP: Token-Efficient Reasoning (2604.14214)

**Finding**: 80.6% token reduction via length regularization

**Key technique**: Regularization on response length forces optimization to produce concise prompts with critical information only.

**pi-braid connection**: CROP-style whispers:

```typescript
// Minimal signals instead of explanations:
const MINIMAL_WHISPER = {
  verbose: "Concise.",
  off_topic: "Refocus.",
  uncertain: "Verify.",
  contradicting: "Check consistency.",
};
```

---

## What's Applicable to pi-braid

### Immediate (can implement now)

1. **Versioned state for evolve extension**
   - Track agent state changes
   - Enable rollback on bad updates
   - Auditable lineage

2. **CROP-style whispers**
   - Replace verbose explanations with minimal signals
   - Reduces token overhead

### Medium-term (needs research)

3. **PriHA-inspired routing**
   - Fast heuristic for simple queries
   - Route complex to reasoning model
   - Refactor deleted query-optimizer for coding domain

4. **Autogenesis SEPL for agent improvement**
   - Propose → Assess → Commit pattern
   - Assessment via enforcement metrics
   - Rollback on degradation

---

## What's NOT Applicable

- **RSPL for resource management**: pi-coding-agent manages resources internally
- **DRAG dual retrieval**: We have session-recall, not general RAG

---

## Implementation Priority

| Component              | Effort | Impact | Priority |
| ---------------------- | ------ | ------ | -------- |
| Versioned evolve state | Low    | High   | P1       |
| CROP whispers          | Low    | Medium | P1       |
| PriHA routing          | Medium | High   | P2       |
| Autogenesis SEPL       | High   | Medium | P3       |

---

## Connection to Other Threads

- **cognitive-control**: SEPL assessment uses heartbeat scheduler
- **measurement**: Assessment metrics measure evolution quality
- **context-engineering**: State versioning uses evidence pool
