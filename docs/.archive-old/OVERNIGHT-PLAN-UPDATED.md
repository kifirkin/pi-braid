# Overnight Development Plan — UPDATED
## pi-braid — April 23-24, 2026

> **Sources**: Original plan + parallel agent audit (`mem-mo342dag`, `mem-mo91o7ja`) + `CODEBASE-AUDIT-FULL.md` + `TOOL_IMPROVEMENTS_PROPOSAL.md` + `PROPOSAL_TOPIC_DRIFT_DETECTOR.md`

---

## BASELINE (Start Here)

```bash
npx tsc --noEmit --skipLibCheck
node test/runtime/test-heartbeat.mjs   # 24/24 should pass
node test/runtime/test-evidence-pool.mjs
```

---

## PHASE 0 — Already Done ✅

| Task | Status | Notes |
|------|--------|-------|
| Activate heartbeat policy engine | ✅ Done | `v0.10.0` tagged |
| Persistent tool tracking | ✅ Done | Moved to `state.metaLearning.toolTracking` |
| Type augmentations | ✅ Done | `extension-context.d.ts` |

---

## PHASE 1 — Wire Three-Memory-Stores (HIGH)

### 1.1 Wire `recallerModule` → `retrieveByRUMS`

**Files**: 
- `src/extensions/heartbeat-scheduler/index.ts` (recallerModule.activate)
- `src/extensions/three-memory-stores/index.ts`

**Problem**: `retrieveByRUMS` defined but never called. Proactive recall never fires.

**Fix in recallerModule.activate()**:
```typescript
const { retrieveByRUMS, addMemoryEpisode } = await import('../three-memory-stores/index.js');

// Get current task context from heartbeat state
const currentTask = state.currentTask || '';

// Retrieve relevant memories
const relevant = retrieveByRUMS(ctx, currentTask, {
    maxResults: 3,
    recencyWeight: 0.7,
    usageWeight: 0.3,
    matchWeight: 0.0,
    minRelevance: 0.5,
});

if (relevant.length > 0) {
    // Surface to agent via whisper
    ctx.whisper?.(`Recall: Found ${relevant.length} relevant past episodes`);
    // Record the recall
    addMemoryEpisode(ctx, {
        type: 'memory_recall',
        task: currentTask,
        outcome: 'success',
        lessons: relevant.map(r => r.episode.lessons || '')
    });
}
```

**Also add proactive triggers in tick handler**:
```typescript
const proactiveTriggers = [
    { condition: () => state.toolFailures > 2, type: 'error_recovery' },
    { condition: () => state.decompositionDepth > 2, type: 'complex_task' },
];
```

### 1.2 Wire `evolverModule` → `evolveHeuristic`

**File**: `src/extensions/heartbeat-scheduler/index.ts`

**Fix in evolverModule.activate()**:
```typescript
const { evolveHeuristic, getHeuristicStats } = await import('../three-memory-stores/index.js');
const underperforming = getHeuristicStats(ctx)
    .filter(s => s.successRate < 0.5 && s.applications > 5);
for (const rule of underperforming) {
    const evolved = evolveHeuristic(ctx, rule.ruleId, { success: false });
    if (evolved) {
        ctx.whisper?.(`Evolved underperforming heuristic: ${rule.ruleId}`);
    }
}
```

### 1.3 Create `verify_claim` Tool (Bidirectional Verification)

**New file**: `src/extensions/verification/index.ts`

From the parallel agent's research, the "braid paper" failure mode shows agents produce fluent but off-topic output. We need a tool that cross-checks claims against retrieved context.

```typescript
interface VerifyClaimInput {
    claim: string;
    context: string[];
    claimId?: string;
}

interface VerifyClaimResult {
    claimId: string;
    verified: boolean;
    issues: Array<{
        type: 'contradiction' | 'unsupported' | 'hedge_warning';
        severity: 'low' | 'medium' | 'high';
        description: string;
        conflictingTexts?: [string, string];
    }>;
    summary: string;
}

// Core: check for contradictions between claim and context
function checkContradiction(claim: string, ctx: string): string | null {
    // Extract key claims from both
    // Compare for semantic contradiction
    // Return null if consistent, description if contradictory
}

// Implementation with hedges detection
const HEDGES = ['should', 'always', 'never', 'must', 'guaranteed'];
```

---

## PHASE 2 — Tool v2 Implementations (MEDIUM)

From `TOOL_IMPROVEMENTS_PROPOSAL.md` — these are the missing cognitive tool improvements.

### 2.1 `think()` Tool v2 — Depth + Chain Linking

**File**: `src/extensions/metacognition/handlers/think.ts` (or create)

**Add to ThinkInput**:
- `depth?: 'minimal' | 'low' | 'medium' | 'high' | 'max'`
- `type?: 'observation' | 'planning' | 'execution' | 'reflection' | 'conclusion'`
- `on_failure?: { diagnose: boolean; propose_fix: boolean }`
- `parent_id?: string`
- `confidence?: number`
- `alternatives?: string[]`

**Add to ThinkResult**:
- `thought_id: string`
- `depth_used: string`
- `chain_position: 'root' | 'child' | 'leaf'`
- `related_memories?: string[]`
- `suggested_next?: string`

**Research basis**: Ares (52.7% token reduction), Hi-CoT (6.2% accuracy improvement), Structured Reflection

### 2.2 `hypothesize()` Tool v2 — Ranked + Evidence Tracking

**File**: `src/extensions/metacognition/handlers/hypothesize.ts`

**Add to HypothesizeInput**:
- `max_hypotheses?: number` (default: 3)
- `format?: 'ranked' | 'tree' | 'list'`
- `verification_plan?: string`

**Add to HypothesisResult**:
- `hypotheses[].evidence_for: string[]`
- `hypotheses[].evidence_against: string[]`
- `hypotheses[].tests: string[]`
- `recommended_first?: string`

### 2.3 `memory_recall()` Tool v2 — Relevance + Type Filtering

**File**: `src/extensions/session-recall/index.ts`

**Add to MemoryRecallInput**:
- `memory_type?: 'insight' | 'pattern' | 'error' | 'episodic' | 'semantic' | 'procedural'`
- `min_relevance?: number` (0-1 threshold)
- `since?: string` / `until?: string` (ISO dates)
- `current_context?: string` (for relevance ranking)

**Add to MemoryRecallResult**:
- `memories[].relevance: number` (0-1)
- `memories[].recency: number` (0-1)
- `memories[].importance: number` (0-1)
- `consolidation_suggestions?: string[][]`

### 2.4 `memory_store()` Tool v2 — TTL + Linking

**File**: `src/extensions/session-recall/index.ts`

**Add to MemoryStoreInput**:
- `importance?: number` (0-1, affects TTL)
- `ttl_ms?: number`
- `consolidate_with?: string[]`
- `linked_memories?: string[]`
- `parent_id?: string`
- `source?: string`

**Add to MemoryStoreResult**:
- `consolidated_with?: string[]`
- `estimated_utility?: number`
- `similar_existing?: string[]`
- `ttl_set?: number`

---

## PHASE 3 — Topic Drift Detector (HIGH)

From `PROPOSAL_TOPIC_DRIFT_DETECTOR.md` — detects drift BEFORE confident wrong output.

### 3.1 Implement Core Drift Detection

**New file**: `src/extensions/enforcement/topic-drift.ts`

```typescript
const TOPIC_ANCHORS = new Map<string, Set<string>>(); // sessionId → anchors

export function extractAnchors(request: string): Set<string> {
    const tokens = request.toLowerCase().split(/\W+/);
    return new Set(tokens.filter(t => t.length > 3));
}

export function measureSimilarity(output: string, anchors: Set<string>): number {
    const outputTokens = new Set(output.toLowerCase().split(/\W+/));
    const intersection = [...anchors].filter(a => outputTokens.has(a));
    return anchors.size > 0 ? intersection.length / anchors.size : 1.0;
}

export function detectTopicDrift(
    sessionId: string,
    request: string,
    output: string,
    threshold = 0.6
): { drifted: boolean; similarity: number; missing: string[] } {
    const anchors = TOPIC_ANCHORS.get(sessionId) ?? extractAnchors(request);
    TOPIC_ANCHORS.set(sessionId, anchors);
    
    const similarity = measureSimilarity(output, anchors);
    const missing = [...anchors].filter(a => !output.toLowerCase().includes(a));
    
    return {
        drifted: similarity < threshold,
        similarity,
        missing
    };
}
```

### 3.2 Wire to Enforcement

**File**: `src/extensions/enforcement/index.ts`

In `before_generation` handler:
```typescript
const drift = detectTopicDrift(ctx.sessionId, ctx.userRequest, ctx.intendedOutput);
if (drift.drifted) {
    ctx.whisper?.(`Your response seems to cover different ground than the request mentioned`);
}
```

---

## PHASE 4 — Codebase Audit Fixes (HIGH)

From `CODEBASE-AUDIT-FULL.md` — 4 CRITICAL + 4 HIGH + 9 MODERATE issues.

### 4.1 CRITICAL: Fix Monkey Patches in Polyfill

**File**: `src/extensions/polyfill/index.ts` (lines 300-327)

**Issue**: Direct API mutation of ExtensionAPI prototype.

**Fix**: Replace with proper extension registration or remove entirely if the underlying API is now available:
```typescript
// Instead of patching sessionManager.getBranch,
// register a proper handler that intercepts calls
pi.on("model_select", (event, ctx) => {
    // Handle branch naming at registration time, not mutation
});
```

### 4.2 CRITICAL: Fix Duplicate `globalThis` Anti-pattern

**Files**: 
- `src/extensions/polyfill/index.ts` (lines 33-38)
- `src/lib/model-resolver.ts` (lines 33-38)
- Likely in a third location

**Fix**: Consolidate to ONE shared module:
```typescript
// src/lib/global-state.ts — one source of truth
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");
export function getCustomModelKeys(): Map<string, string> {
    if (!(globalThis as any)[CUSTOM_KEYS_MAP]) {
        (globalThis as any)[CUSTOM_KEYS_MAP] = new Map<string, string>();
    }
    return (globalThis as any)[CUSTOM_KEYS_MAP];
}
```

### 4.3 CRITICAL: Fix Broken Type Guard

**File**: Likely in error-classifier or similar

**Issue**: Runtime type guard relying on semantic inversion.

**Fix**: Use explicit type checking with well-defined discriminators.

### 4.4 CRITICAL: Fix HTTP 429 Classification Conflict

**File**: `src/lib/error-classifier.ts`

**Issue**: HTTP 429 classified as both retryable AND non-retryable.

**Fix**: One canonical classification per error code.

### 4.5 HIGH: Fix Module-Level Mutable State

**Files**: Multiple extensions

**Issue**: Violates architecture — module-level `let` for mutable state.

**Fix**: All state via `getExtensionState(ctx, key, factory)`.

### 4.6 HIGH: Reduce `as any` Casts

**Files**: Throughout codebase (~70+ casts)

**Fix**: Add proper types or use `unknown` with explicit narrowing.

### 4.7 HIGH: Fix Compliance-Heavy Prompts

**Files**: Enforcement, nudge-manager

**Issue**: Research shows compliance-heavy prompts cause degradation.

**Fix**: Balance compliance with capability prompts.

### 4.8 HIGH: Extract Magic Numbers

**Files**: Various configuration files

**Fix**: Named constants for METRICS_SAVE_INTERVAL, HEALTHCHECK_INTERVAL, NUDGE_COOLDOWN, etc.

---

## PHASE 5 — Analytics Programmatically Readable (MEDIUM)

### 5.1 Add Structured Read Tools

**File**: `src/extensions/analytics/index.ts`

Add these tools:
- `get-session-metrics` → structured JSON
- `get-tool-reliability` → success rates per task type
- `get-degradation-history` → historical events

### 5.2 Fix Storage Format

**File**: `src/extensions/analytics/index.ts`

Store session data as JSON, not just formatted strings:
```typescript
// Store structured data alongside formatted display
const structuredData = {
    sessionId: current.id,
    duration: Date.now() - current.startTime,
    toolCounts: current.tools,
    errorCount: current.errors,
    successRate: current.successes / (current.successes + current.errors),
};
// Save to JSON file for programmatic access
```

---

## PHASE 6 — Outcome Tracking (MEDIUM)

From `TOOL_IMPROVEMENTS_PROPOSAL.md` — closed-loop learning.

### 6.1 Add `finalize()` Outcome Tracking

**File**: `src/extensions/metacognition/handlers/finalize.ts`

After every `finalize`, record:
```typescript
interface OutcomeTracking {
    path_taken: string[];
    what_worked: string[];
    what_failed: string[];
    learnings: string[];
}
```

### 6.2 Wire to Three-Memory-Stores

Store outcome learnings as episodic memories for future recall.

---

## PHASE 7 — Missing Proposals (MEDIUM)

### 7.1 Implement Bidirectional Verifier

**File**: `src/extensions/enforcement/bidirectional-verifier.ts`

From `BIDIRECTIONAL-VERIFIER-PROPOSAL.md`.

### 7.2 SAE Steering (Future)

From `SAE-STEERING-PROPOSAL.md` — not critical for this session.

---

## Task Matrix

| # | Task | Phase | Priority | Files | Lines Est |
|---|------|-------|----------|-------|-----------|
| 1.1 | Wire recallerModule → retrieveByRUMS | 1 | HIGH | heartbeat, three-memory | ~30 |
| 1.2 | Wire evolverModule → evolveHeuristic | 1 | HIGH | heartbeat, three-memory | ~20 |
| 1.3 | Create verify_claim tool | 1 | HIGH | new extension | ~150 |
| 2.1 | think() v2 — depth + chains | 2 | MEDIUM | metacognition | ~80 |
| 2.2 | hypothesize() v2 — ranked | 2 | MEDIUM | metacognition | ~60 |
| 2.3 | memory_recall() v2 — relevance | 2 | MEDIUM | session-recall | ~50 |
| 2.4 | memory_store() v2 — TTL | 2 | MEDIUM | session-recall | ~40 |
| 3.1 | Topic drift detector core | 3 | HIGH | new topic-drift.ts | ~50 |
| 3.2 | Wire drift detector to enforcement | 3 | HIGH | enforcement | ~20 |
| 4.1 | Fix monkey patches (polyfill) | 4 | CRITICAL | polyfill | ~50 |
| 4.2 | Fix globalThis duplicates | 4 | CRITICAL | lib, polyfill | ~30 |
| 4.3 | Fix broken type guard | 4 | CRITICAL | TBD | ~20 |
| 4.4 | Fix HTTP 429 conflict | 4 | CRITICAL | error-classifier | ~10 |
| 4.5 | Fix module-level mutable state | 4 | HIGH | many | ~100 |
| 4.6 | Reduce as any casts | 4 | HIGH | many | ~50 |
| 4.7 | Fix compliance-heavy prompts | 4 | HIGH | enforcement | ~50 |
| 4.8 | Extract magic numbers | 4 | MEDIUM | config | ~30 |
| 5.1 | Add structured read tools | 5 | MEDIUM | analytics | ~60 |
| 5.2 | Fix storage format | 5 | MEDIUM | analytics | ~20 |
| 6.1 | Add outcome tracking | 6 | MEDIUM | metacognition | ~40 |
| 6.2 | Wire to memory stores | 6 | MEDIUM | metacognition | ~20 |
| 7.1 | Bidirectional verifier | 7 | MEDIUM | new | ~100 |

**Total**: ~1,130 lines across 23 tasks

---

## Progress Log

| Task | Started | Completed | Notes |
|------|---------|-----------|-------|
| 0 (baseline) | | ✅ | |
| 1.1 | | | |
| 1.2 | | | |
| 1.3 | | | |
| 2.1 | | | |
| 2.2 | | | |
| 2.3 | | | |
| 2.4 | | | |
| 3.1 | | | |
| 3.2 | | | |
| 4.1 | | | |
| 4.2 | | | |
| 4.3 | | | |
| 4.4 | | | |
| 4.5 | | | |
| 4.6 | | | |
| 4.7 | | | |
| 4.8 | | | |
| 5.1 | | | |
| 5.2 | | | |
| 6.1 | | | |
| 6.2 | | | |
| 7.1 | | | |

---

## References

- `mem-mo342dag-z4ivsgk` — Tool audit (2 duplicates found)
- `mem-mo91o7ja-vjdw3vp` — Codebase audit (4 CRITICAL)
- `docs/archive/CODEBASE-AUDIT-FULL.md` — Full audit details
- `docs/archive/TOOL_IMPROVEMENTS_PROPOSAL.md` — Tool v2 specs
- `docs/archive/PROPOSAL_TOPIC_DRIFT_DETECTOR.md` — Drift detection spec
- `docs/archive/BIDIRECTIONAL-VERIFIER-PROPOSAL.md` — Verification spec
