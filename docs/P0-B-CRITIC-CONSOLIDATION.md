<!-- status: historical -->

# P0 #B: Critic Consolidation — Inventory & Plan

**Status:** ✅ All implementations shipped (2026-07-04). See [ROADMAP.md](ROADMAP.md) for current state.
**Date:** 2026-07-02
**Author:** Braid (D-57 continuous improvement)

## Summary

The `CRITICS` object in `src/lib/ai/critic-registry.ts` defines 31 named
classification prompts. Each is invoked via `classify()` from
`src/lib/ai/text-classifier.ts`, which runs a three-tier fallback
(heuristic → utility model → session model). Many critics are called
together in groups of 2-4 with the same input — each making a separate
LLM call. Consolidation batches these into a single structured-output
call, reducing LLM calls by ~60% in the affected groups.

## Full Critic Inventory

### Legend
- **G** = Group (critics always called together with same input)
- **S** = Standalone (called independently, no consolidation opportunity)
- **B** = Binary (yes/no)
- **M** = Multi-class (3+ values)
- **✅** = Already consolidated
- **❌** = Not yet consolidated
- **🚫** = Cannot consolidate (gated/conditional or different inputs)

### Group 1: Topic Drift Triple-Critic (3 critics → 1) ✅
| Critic | Type | Call Site | Status |
|--------|------|-----------|--------|
| `topicCoverage` | B | topic-drift-detector.ts, topic-drift/index.ts | ✅ |
| `topicDivergence` | B | topic-drift-detector.ts, topic-drift/index.ts | ✅ |
| `topicCompleteness` | B | topic-drift-detector.ts, topic-drift/index.ts | ✅ |

**Consolidation:** `src/lib/detection/consolidated-topic-critic.ts`
Returns JSON: `{ coversTopic, hasDiverged, isComplete }`
**Savings:** 3 → 1 LLM call per turn_end

### Group 2: Input Polish Quad-Critic (4 critics → 1) ✅
| Critic | Type | Call Site | Status |
|--------|------|-----------|--------|
| `inputCodeHeavy` | B | input-critic.ts | ✅ |
| `inputWellWritten` | B | input-critic.ts | ✅ |
| `inputClarity` | B | input-critic.ts | ✅ |
| `inputAmbiguity` | B | input-critic.ts | ✅ |

**Consolidation:** `src/extensions/core/input-polisher/consolidated-input-critic.ts`
Returns JSON: `{ isCode, isWellWritten, isClear, isAmbiguous }`
**Savings:** 4 → 1 LLM call per user input

### Group 3: Claim Verification Triple-Critic (3 critics → 1) ✅
| Critic | Type | Call Site | Status |
|--------|------|-----------|--------|
| `claimContradiction` | B | claim-verification.ts | ✅ |
| `claimSupported` | B | claim-verification.ts | ✅ |
| `claimOverconfidence` | B | claim-verification.ts | ✅ |

**Current:** Single consolidated LLM call via `consolidatedClaimCritique()` in
`src/lib/ai/consolidated-claim-critic.ts`. Falls back to 3 individual
`classify()` calls on failure. All 3 claim critics use `tierPolicy: "always-llm"`.
**Savings:** 3 → 1 LLM call per verify_claim invocation (~66% latency reduction)
**Shipped:** 2026-07-04

### Group 4: Claim Tracker Dual-Critic (2 critics) 🚫
| Critic | Type | Call Site | Status |
|--------|------|-----------|--------|
| `entityExtraction` | B | claim-tracker.ts | 🚫 |
| `polarityDetection` | M | claim-tracker.ts | 🚫 |

**Cannot consolidate:** polarityDetection is gated on entityExtraction
returning "yes" — only runs for sentences that contain a factual claim.
Same input (sentence) but conditional execution prevents batching.
**Savings:** 0 (no consolidation opportunity)

### Group 5: Sycophancy Dual-Critic (2 critics) 🚫
| Critic | Type | Call Site | Status |
|--------|------|-----------|--------|
| `sycophancyTactics` | B | sycophancy-detector/index.ts | 🚫 |
| `vbCDetection` | B | sycophancy-detector/index.ts | 🚫 |

**Cannot consolidate:** Different inputs — sycophancyTactics analyzes user
messages, vbCDetection analyzes assistant responses. Called in different
functions at different times.
**Savings:** 0 (no consolidation opportunity)

### Standalone Critics (14) — no grouping opportunity

| Critic | Type | Call Site | Note |
|--------|------|-----------|------|
| `decompositionCoverage` | B | verify_claim action=decomposition | Optional, called alone |
| `topicClassification` | M | routing-handler, signal-detector | 9 classes, called alone |
| `trajectoryPattern` | M | sop-extractor | Pattern names, called alone |
| `toolLoopDetected` | B | turn-outcome | Fallback for heuristic detector |
| `evidenceConflict` | B | evidence-pool (2 sites) | Called per conflict pair |
| `sopQuality` | B | SOP extraction | Called per SOP candidate |
| `hintQuality` | B | consolidation-channel | Called per hint candidate |
| `contextDensity` | M | context-density | 3 classes, called alone |
| `compressionUrgency` | M | compression-strategy | 4 classes, called alone |
| `qualitativeDegradation` | M | degradation-detector | DEGRADED/STABLE |
| `removalSafety` | B | context compaction | Called per message |
| `errorType` | M | register-auto-retry-end | 5 classes, called alone |
| `instructionStrength` | M | bidirectional-verifier | 4 classes, called alone |
| `commandType` | M | probe-handler | 7 classes, called alone |
| `hintRelevance` | B | hints.ts | Called per hint candidate |
| `conflictResolution` | M | conflict-qa | 3 classes, called alone |
| `complianceFraming` | B | latent-activator | Called alone |

### Summary

| Group | Critics | Inputs | Status | Savings |
|-------|---------|--------|--------|---------|
| Topic Drift | 3 | Same | ✅ Done | 3→1 |
| Input Polish | 4 | Same | ✅ Done | 4→1 |
| Claim Verification | 3 | Same | ✅ Done | 3→1 |
| Claim Tracker | 2 | Same | 🚫 Gated | — |
| Sycophancy | 2 | Different | 🚫 Different | — |

**Total LLM calls saved if all consolidadable groups are done:**
10 calls → 3 calls (7 saved per evaluation cycle)

## Implementation Status

### Phase 1: Claim Verification (3→1) ✅ SHIPPED (2026-07-04)

Complete. `src/lib/ai/consolidated-claim-critic.ts` was created following the pattern
from `consolidated-input-critic.ts` and `consolidated-topic-critic.ts`:
- Single system prompt: "You are a claim verification analyzer..."
- JSON output: `{ contradiction: boolean, supported: boolean, overconfidence: boolean }`
- Model tier: session → utility → max-power (same "quality" strategy)
- Fallback: 3 individual classify() calls on consolidated failure
- Integrated into `claim-verification.ts` at line 187 (primary path)

### Phase 2: Monitoring (future)
- Verify the consolidated path handles >90% of calls after sustained runtime
- If fallback rate is high, investigate model compatibility issues
- Consider removing the individual critics from critic-registry.ts if they're
  only used by the fallback path (dead code elimination)