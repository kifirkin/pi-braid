# pi-braid Improvement Map

Generated: 2026-05-29 (updated 15:23 EEST)
Based on: April 2026 Tool Improvements Proposal, May 2026 LLM-Judge Refactoring

---

## Current State

### ✅ Already Implemented (May 2026)

| Feature | Files Changed | Date |
|---------|---------------|------|
| Barrel file elimination (46 → 0) | All `src/lib/*.ts`, `test/runtime/*.mjs` | May 2026 |
| `contextDensity` LLM judge | `critic-registry.ts`, `context-density.ts` | May 2026 |
| `compressionUrgency` LLM judge | `critic-registry.ts`, `compression-strategy.ts` | May 2026 |
| `qualitativeDegradation` LLM judge | `critic-registry.ts`, `degradation-detector.ts` | May 2026 |
| `removalSafety` LLM judge | `critic-registry.ts`, `filter-safe-to-remove.ts` | May 2026 |
| Heuristic fallback simplification (×4) | `critic-registry.ts` | May 2026 |
| `errorType` LLM judge | `critic-registry.ts`, `register-auto-retry-end.ts` | 2026-05-29 |
| `instructionStrength` LLM judge | `critic-registry.ts`, `bidirectional-verifier.ts` | 2026-05-29 |
| `commandType` LLM judge | `critic-registry.ts`, `probe-handler.ts` | 2026-05-29 |
| `complianceFraming` LLM judge | `critic-registry.ts`, `latent-activator.ts` | 2026-05-29 |
| ERROR_BURST_THRESHOLD centralization | `enforcement/state.ts` (was 3 independent defs) | 2026-05-29 |
| `polarityDetection` + `entityExtraction` critics + fallback | `critic-registry.ts`, `claim-tracker.ts` | 2026-05-29 |

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

| Module | Heuristic | Fragility | Effort | Impact | Status |
|--------|-----------|-----------|--------|--------|--------|
| `claim-tracker.ts:145` | Verb leading-word filter (regex) | Medium | Small | Medium | ✅ Addressed — `entityExtraction` critic + fallback utility |
| `claim-tracker.ts:159` | Polarity detection via 7 negation words | Medium | Small | Medium | ✅ Addressed — `polarityDetection` critic + fallback utility |
| `bidirectional-verifier.ts:76-105` | Path detection via 5 regexes | Low | Small | Medium | ⏸ Deferred — low fragility, small impact |
| `bidirectional-verifier.ts:195-203` | SHALL/MUST/SHOULD keyword strength | Low | Small | Medium | ✅ Addressed — `instructionStrength` critic + sync fallback |
| `conflict-qa.ts` | RESOLUTION_KEYWORDS array | Low | Small | Medium | ⏸ Deferred — low fragility |
| `sycophancy-detector/index.ts:30-51` | Flattery pattern regexes | High | Medium | High | ⏸ Deferred — already three-tier design, correct as-is |
| `sycophancy-detector/index.ts:120-133` | Footage/evidence pattern regexes | High | Medium | High | ⏸ Deferred — already three-tier design, correct as-is |
| `register-auto-retry-end.ts:48-50` | Error type regex classification | Medium | Small | High | ✅ Addressed — `errorType` critic + heuristic fallback |

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

### Next sprint
2. **hypothesize() v2** — verification plans + evidence tracking + format options
3. **memory_recall() v2** — time filters + context-aware ranking + relevance reasons

### Next quarter
4. **memory_store() v2** — linking + consolidation
5. **Standard tool results** — metacognition refactor
6. **Closed-loop outcome tracking** — new module
7. **Architectural simplification** — event router, enforcement consolidation

### ✅ Completed this session (2026-05-29)
- **register-auto-retry-end** → `errorType` LLM judge + heuristic fallback
- **claim-tracker** → `entityExtraction` + `polarityDetection` critics with shared `entityClaimFromSentence()` fallback utility
- **bidirectional-verifier** → `instructionStrength` LLM judge (async) + sync keyword regex preserved
- **probe-handler** → `commandType` LLM judge (opt-in async) + sync heuristic fallback
- **latent-activator** → `complianceFraming` LLM judge (opt-in async) + sync `hasComplianceFraming()` preserved
- **ERROR_BURST_THRESHOLD** → centralized into `enforcement/state.ts` from 3 independent definitions

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