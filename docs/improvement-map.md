# pi-braid Improvement Map

Generated: 2026-05-29  
Based on: April 2026 Tool Improvements Proposal, May 2026 LLM-Judge Refactoring

---

## Current State

### ✅ Already Implemented (May 2026)

| Feature | Files Changed |
|---------|---------------|
| Barrel file elimination (46 → 0) | All `src/lib/*.ts`, `test/runtime/*.mjs` |
| `contextDensity` LLM judge | `critic-registry.ts`, `context-density.ts` |
| `compressionUrgency` LLM judge | `critic-registry.ts`, `compression-strategy.ts` |
| `qualitativeDegradation` LLM judge | `critic-registry.ts`, `degradation-detector.ts` |
| `removalSafety` LLM judge | `critic-registry.ts`, `filter-safe-to-remove.ts` |
| Heuristic fallback simplification (×4) | `critic-registry.ts` |

### ✅ Implemented from April Proposal

| Proposal Feature | Status | Files |
|------------------|--------|-------|
| `think()` depth control | DONE | `think.ts` |
| `think()` auto_depth | DONE | `think.ts` |
| `think()` structured types | DONE | `think.ts` |
| `think()` confidence tracking | DONE | `think.ts` |
| `think()` alternatives | DONE | `think.ts` |
| `think()` on_failure | DONE | `think.ts` |
| `think()` parent_id chain linking | DONE | `think.ts` |
| `memory_store()` context field | DONE | `three-memory-stores/index.ts` |

### ❌ Not Yet Implemented from April Proposal

| Proposal Feature | Effort | Impact |
|------------------|--------|--------|
| `hypothesize()` verification plans | Medium | High |
| `hypothesize()` format options (ranked/tree/list) | Small | Medium |
| `hypothesize()` evidence_for / evidence_against | Medium | High |
| `memory_recall()` time filters (since/until) | Small | Medium |
| `memory_recall()` context-aware ranking | Medium | High |
| `memory_recall()` relevance_reason | Medium | High |
| `memory_store()` consolidate_with | Medium | High |
| `memory_store()` linked_memories | Medium | Medium |
| `memory_store()` parent_id (episodic chains) | Small | Medium |
| Standard tool results format | Medium | High |
| Closed-loop outcome tracking | High | High |

---

## Remaining Heuristic-Heavy Code

### Phase A — LLM Judge Adoption (extends May pattern)

| Module | Heuristic | Fragility | Effort | Impact |
|--------|-----------|-----------|--------|--------|
| `claim-tracker.ts:145` | Verb leading-word filter (regex) | Medium | Small | Medium |
| `claim-tracker.ts:159` | Polarity detection via 7 negation words | Medium | Small | Medium |
| `bidirectional-verifier.ts:76-105` | Path detection via 5 regexes | Low | Small | Medium |
| `bidirectional-verifier.ts:195-203` | SHALL/MUST/SHOULD keyword strength | Low | Small | Medium |
| `conflict-qa.ts` | RESOLUTION_KEYWORDS array | Low | Small | Medium |
| `sycophancy-detector/index.ts:30-51` | Flattery pattern regexes | High | Medium | High |
| `sycophancy-detector/index.ts:120-133` | Footage/evidence pattern regexes | High | Medium | High |
| `register-auto-retry-end.ts:48-50` | Error type regex classification | Medium | Small | High |

### Phase B — Tool v2 Implementation (extends April proposal)

| Component | Current State | Target State | Effort |
|-----------|--------------|--------------|--------|
| `hypothesize()` | Basic problem+evidence | Ranked with verification plans | 2 days |
| `memory_recall()` | Query + basic filters | Context-aware with relevance scoring | 3 days |
| `memory_store()` | Basic storage | Linking + consolidation hints | 2 days |
| `metacognition/index.ts` | No standard results | Standard tool result format | 2 days |
| New: outcome tracking | Not exists | Closed-loop learning from tool traces | 4 days |

### Phase C — Architectural Simplification

| Area | Current State | Target | Effort |
|------|--------------|--------|--------|
| `src/lib/events/` event-router | Three parallel registration systems | Unified handler pattern | 2 days |
| `src/lib/ai/text-classifier.ts` + `critic-registry.ts` | Growing critic registry | Dynamic/plugin critics | 1 day |
| `src/extensions/enforcement/` | Multiple judge files overlapping | Consolidated judge layer | 3 days |
| Test structure (`test/runtime/*.mjs`) | Flat directory, ~11k lines total | Organized by module | 2 days |

---

## Recommended Order

### Next (this week)
1. **sycophancy-detector** → `sycophancyQuality` LLM judge (high impact, replaces fragile regex)
2. **register-auto-retry-end** → `errorType` LLM judge (high impact, replaces error regex)
3. **claim-tracker** → `entityExtraction` + `polarityDetection` judges (data quality)

### Next sprint
4. **hypothesize() v2** — verification plans + evidence tracking + format options
5. **memory_recall() v2** — time filters + context-aware ranking + relevance reasons
6. **Bidirectional verifier** → `instructionStrength` LLM judge

### Next quarter
7. **memory_store() v2** — linking + consolidation
8. **Standard tool results** — metacognition refactor
9. **Closed-loop outcome tracking** — new module
10. **Architectural simplification** — event router, enforcement consolidation

---

## Key Design Patterns

### Pattern A: Critic + Heuristic Fallback (for decision-making heuristics)
```typescript
// critic-registry.ts
myCritic: {
  label: "...",
  criteria: {
    systemPrompt: "...",
    userPrompt: "...",
  },
  options: { maxTokens: 5 },
} satisfies CriticDef;

// consumer
const result = await classify(ctx, CRITICS.myCritic.criteria, 
  { /* vars */ },
  { fallback: () => CRITICS.myCriticFallback?.(/*...*/) }
);
```

### Pattern B: Tool v2 improvements
```typescript
// Add fields, keep backward compat
interface HypothesizeInputV2 extends HypothesizeInput {
  format?: 'ranked' | 'tree' | 'list';
  verification_plan?: string;
}
```

### Pattern C: Standard tool results
```typescript
interface StandardResult {
  confidence: number;
  alternatives_considered?: number;
  suggested_next_tool?: string;
  related_memories?: string[];
}
```