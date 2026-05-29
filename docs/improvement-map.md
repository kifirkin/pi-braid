# pi-braid Improvement Map

Generated: 2026-05-29 (updated 21:12 EEST)
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
| Critic stats runtime observability | `lib/ai/critic-stats.ts`, `text-classifier.ts`, 19 callers labeled | 2026-05-29 |
| Module boundary enforcer | `scripts/check-deps.mjs` (layer rules, manifest exemption, overrides) | 2026-05-29 |
| Stale test reference checker | `scripts/check-deps.mjs` (comment skipping, assertion filtering) | 2026-05-29 |
| Extension entry-point validator | `scripts/check-deps.mjs` (namespace dirs skipped) | 2026-05-29 |
| RECOVERY_GRACE_TURNS centralization | `enforcement/state.ts` (was in `signals.ts` + `turn-end-handler.ts`) | 2026-05-29 |
| Shared type extraction: `ScheduledTimer` → `lib/events/timer-types.ts` | `timer-bus.ts`, `timer/index.ts` | 2026-05-29 |
| Shared type extraction: `Episode` → `lib/types/episode-types.ts` | `types.ts`, `sop-suggestion.ts`, 3 heartbeat consumers | 2026-05-29 |
| `quick-benchmark.mjs` test fix | Matched assertions to triple-critic refactored code | 2026-05-29 |
| `test-enforcement.mjs` test fix | Updated import paths, handler names, line thresholds | 2026-05-29 |
| ENTITY_VERBS regex centralization | `critic-registry.ts` (shared export), `claim-tracker.ts` (consumer) | 2026-05-29 |
| Duplicate constant checker | `scripts/check-duplicates.mjs` (name-stem grouping) | 2026-05-29 |
| API surface drift validation | `scripts/check-deps.mjs` (tool registration consistency) | 2026-05-29 |
| 5 remaining test failures cleared | Guards for external infra, async await in drift tests, Jaccard heuristic fallback | 2026-05-29 |

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

| Component | Status |
|-----------|--------|
| `hypothesize()` | ✅ Done — formats, verification plans, evidence extraction |
| `memory_recall()` | ✅ Done — time filters, context-aware ranking, relevance reasons |
| `memory_store()` | ✅ Done — consolidate_with, linked_memories |
| `metacognition/index.ts` | ✅ Done — `withMeta()` pattern, applied to hypothesize |
| New: outcome tracking | ⏸ Deferred — requires new module design |

### Phase C — Architectural Simplification

| Area | Status |
|------|--------|
| `src/lib/events/` event-router | ✅ Audited — onEvent/pi.on is one system; turn-end-coordinator already provides unified dispatch |
| `src/lib/ai/text-classifier.ts` + `critic-registry.ts` | ⏸ Deferred — growing organically, dynamic plugin critics are fine for now |
| `src/extensions/enforcement/` | ✅ Partial — judge-prompt.ts inlined; handler-registry.ts already thin orchestrator |
| Test structure (`test/runtime/*.mjs`) | ✅ Done — reorganized by module into 6 subdirectories |

---

## Recommended Order

### ✅ Completed this session
- sycophancy-detector → `sycophancyTactics` + `vbCDetection` critics ✅
- hypothesize() v2 — verification plans + evidence tracking + format options ✅
- memory_recall() v2 — time filters + context-aware ranking + relevance reasons ✅
- memory_store() v2 — linking + consolidation ✅
- Architectural audit — event router verified (already unified) ✅
- Enforcement judge consolidation (judge-prompt.ts removed) ✅

### Remaining
1. **Closed-loop outcome tracking** — new module (~2-4 days)
2. **Contrib @ts-nocheck files** — 6 files at ~4,800 lines, mostly browser extension
3. **Dynamic/plugin critic registry** — when critic count grows beyond ~30

### ✅ Completed today (2026-05-29)
- **register-auto-retry-end** → `errorType` LLM judge + heuristic fallback
- **claim-tracker** → `entityExtraction` + `polarityDetection` critics with shared `entityClaimFromSentence()` fallback utility
- **bidirectional-verifier** → `instructionStrength` LLM judge (async) + sync keyword regex preserved
- **probe-handler** → `commandType` LLM judge (opt-in async) + sync heuristic fallback
- **latent-activator** → `complianceFraming` LLM judge (opt-in async) + sync `hasComplianceFraming()` preserved
- **ERROR_BURST_THRESHOLD** → centralized into `enforcement/state.ts` from 3 independent definitions
- **Critic stats runtime observability** — `lib/ai/critic-stats.ts` counters, `text-classifier.ts` labels, 19 callers wired, integrated into analytics extension
- **Module boundary enforcement** — `scripts/check-deps.mjs`: layer rules (lib/→ext/ isolation), `ALLOWED_BOUNDARY_OVERRIDES`, manifest.ts exemption, comment-line filtering
- **Shared type extraction** — `ScheduledTimer` → `lib/events/timer-types.ts`, `Episode` → `lib/types/episode-types.ts`, 6+ consumers updated
- **RECOVERY_GRACE_TURNS** → centralized into `enforcement/state.ts` (was in `signals.ts` + `turn-end-handler.ts`)
- **Knowledge duplication audit** — 60+ constants checked, one real duplicate found and fixed (ENTITY_VERBS)
- **Stale test refs fixed** — 13 in `quick-benchmark.mjs`, `test-enforcement.mjs`: real refs fixed, false positives eliminated via checker improvement
- **Duplicate constant scanner** — `scripts/check-duplicates.mjs` with name-stem grouping to avoid false positives
- **API surface drift checker** — `scripts/check-deps.mjs`: validates tool registration names across all extensions, no duplicates found
- **64/64 tests passing** — all pre-existing failures resolved
- **Sycophancy critics** — `sycophancyTactics` + `vbCDetection` migrated to critic-registry.ts
- **hypothesize() v2** — format options (ranked/tree/list), verificationPlan param, evidence_for/evidence_against extraction
- **memory_recall() v2** — time filters (since/until), context-aware ranking (project boost, session guard, frequency), relevanceReason strings
- **memory_store() v2** — consolidateWith (merge+delete), linkedMemories (bidirectional MemoryLink)
- **Enforcement judge consolidation** — `judge-prompt.ts` inlined and deleted (now -1 files in enforcement)
- **Event router audit** — verified onEvent/pi.on is one system (wrapper, not parallel)
- **Hypothesize evidence extraction** — CONFIRM/DISPROVE lines parsed from LLM output and surfaced in details
- **Context-aware recall ranking** — +30% same-project boost, +20% session error boost, +15% frequent-access boost

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