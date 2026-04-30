# Overnight Quick-Start Task List

## pi-braid — April 23-24, 2026

---

## BASELINE (Start Here)

```bash
# Verify baseline builds
npx tsc --noEmit --skipLibCheck
node test/runtime/test-heartbeat.mjs
node test/runtime/test-cognition-evaluator.mjs
```

If baseline passes, proceed to Tier 1. If failures, check if pre-existing.

---

## TIER 1 — CRITICAL (Hours 1-4)

### [ ] 1.1: Activate Heartbeat Policy Engine

**File**: `src/extensions/heartbeat-scheduler/index.ts`
**Line**: ~802 (function definition) → needs call at session_start (~line 180)

```typescript
// Add to session_start handler after state initialization:
const policyActivated = activatePolicyEngine(ctx, {
  onEnforcementWhisper: (msg) => ctx.enforcer?.sendEnforcementWhisper(msg),
  onPolicyFire: (policyId, context) => {
    const module = policyModules[policyId];
    if (module) module.activate(ctx, context);
  },
});
state.policyEngineReady = true; // Currently hardcoded to false
```

**Verify**: `heartbeat_status` should show policy engine active.

### [ ] 1.2: Wire Real Tool Tracking

**File**: `src/extensions/heartbeat-scheduler/index.ts`
**Location**: `onToolComplete` handler (around line 760)

Replace `if (state.policyEngineReady)` block with real tracking:

```typescript
const tracking = getToolTracking(); // Currently returns hardcoded zeros
tracking.totalToolsUsed++;
tracking.lastToolCallTurn = state.turnCount;
// ... specific tool type tracking ...
ctx.analytics?.recordToolCall(toolName, Date.now(), { success: !event.error });
```

### [ ] 1.3: Wire Three-Memory-Stores to Heartbeat

**File**: `src/extensions/heartbeat-scheduler/index.ts`

In `recallerModule.activate()`:

```typescript
const { retrieveByRUMS } = await import("../three-memory-stores/index.js");
const relevant = retrieveByRUMS(ctx, currentTask, { maxResults: 3 });
// Surface to agent
```

In `evolverModule.activate()`:

```typescript
const { evolveHeuristic } = await import("../three-memory-stores/index.js");
// Evolve underperforming heuristics
```

### [ ] 1.4: Make Analytics Readable

**File**: `src/extensions/analytics/index.ts`

Add to `registerTools()`:

- `get-session-metrics` → structured JSON of current session
- `get-tool-reliability` → tool success rates per task type
- `get-degradation-history` → historical degradation events

Also fix `formatCurrentSession()` to store JSON data, not just formatted text.

### [ ] 1.5: Wire Belief-Store to Measurement Module

**File**: `src/extensions/heartbeat-scheduler/index.ts`

In `measurementModule.activate()`:

```typescript
const { beliefStore } = getBeliefStore(ctx);
const reasons = getDegradationReasons(ctx);
for (const reason of reasons) {
  beliefStore.addBelief(ctx, {
    type: "degradation_signal",
    content: reason.description,
    confidence: reason.severity,
    source: "measurement",
    tags: ["measurement", "degradation"],
  });
}
```

---

## TIER 2 — HIGH (Hours 4-7)

### [ ] 2.1: Create Bidirectional Verification Tool

**New File**: `src/extensions/verification/index.ts`

Implement:

- `verify_claim` — cross-check claims against retrieved context
- `verify_decomposition` — verify task decomposition coverage

### [ ] 2.2: Make Session Recall Proactive

**File**: `src/extensions/session-recall/index.ts`

Add proactive triggers in heartbeat tick:

```typescript
const proactiveRecallTriggers = [
  { condition: () => ctx.toolFailures > 2, recallType: "error_recovery_episodes" },
  { condition: () => ctx.decompositionDepth > 2, recallType: "complex_task_episodes" },
  // ...
];
```

### [ ] 2.3: Add Budget-Aware Planning Tool

**New File**: `src/extensions/planner/budget-planner.ts`

Implement:

- `plan_with_budget` — cost-estimated task plan
- `check_budget` — remaining budget and spending rate

### [ ] 2.4: Wire Context-Lifecycle Signal Detector

**File**: `src/extensions/heartbeat-scheduler/index.ts`

In tick handler:

```typescript
const { detectTopicDrift } = await import("../context-lifecycle/signal-detector.js");
const { detectContextOverflow } = await import("../context-lifecycle/signal-detector.js");
// Fire on significant events
```

---

## TIER 3 — MEDIUM (Hours 7-9)

### [ ] 3.1: Fix Enforcement Judge to Use Structured Signals

**File**: `src/extensions/enforcement/judge-prompt.ts`

Replace verbose text patterns with structured JSON output format:

```typescript
const JUDGE_TEMPLATE = `Output format (JSON):
{
  "signals": [
    {
      "type": "compliance" | "deception" | "incomplete" | "hallucination" | "scope_violation",
      "severity": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "specific quote from response",
      "remediation": "specific action to fix",
      "nudgeType": "whisper" | "warn" | "block",
      "category": "enforcement" | "quality" | "safety"
    }
  ]
}`;
```

### [ ] 3.2: Fix Nudge Quality

**File**: `src/extensions/enforcement/nudge-manager.ts`

Replace generic nudges with specific templates:

```typescript
const NUDGE_TEMPLATES = {
  error_concealment: {
    specific:
      "Error {error_type} detected. Your response did not acknowledge it. State the error explicitly and propose a fix.",
    tone: "direct",
  },
  scope_drift: {
    specific: "You drifted from: '{original_task}'. Return to scope or explicitly renegotiate.",
    tone: "direct",
  },
  // ...
};
```

### [ ] 3.3: Wire Error Classification to Enforcement

**File**: `src/extensions/enforcement/index.ts`

In tool error handler:

```typescript
const { classifyError, shouldRetry } = await import("../../lib/error-classifier.js");
const classification = classifyError(event.error, event.toolName);
if (shouldRetry(classification)) {
  ctx.whisper?.(
    `Error: ${classification.category}. ${RETRY_STRATEGIES[classification.category].hint}`,
  );
}
```

---

## TIER 4 — LOW (Hours 9-10)

### [ ] 4.1: Create Self-Correction Tool

**New File**: `src/extensions/self-correction/index.ts`

- `meta_correct` — identify failure patterns and create prevention heuristics

### [ ] 4.2: Wire L1 Environment Discovery

**File**: `src/extensions/prompt-builder/l1-environment.ts`

Call `discoverPiPaths()` and inject docs path context into prompt.

### [ ] 4.3: Add Proactive Policy Learning

**File**: `src/extensions/heartbeat-scheduler/index.ts`

Track policy outcomes and update confidence:

```typescript
const outcome = await trackOutcome(policyId, action);
beliefStore.updatePolicy(ctx, policyId, {
  confidence: outcome.success
    ? Math.min(1.0, policy.confidence + 0.05)
    : Math.max(0.1, policy.confidence - 0.1),
});
```

---

## VERIFICATION COMMANDS

After each task:

```bash
# Type check
npx tsc --noEmit --skipLibCheck

# Heartbeat test (source-based, always passes)
node test/runtime/test-heartbeat.mjs

# Cognition evaluator test
node test/runtime/test-cognition-evaluator.mjs
```

After Tier 1 complete:

```bash
node test/runtime/test-heartbeat.mjs
node test/runtime/test-memory-stores.mjs
```

After Tier 2 complete:

```bash
# New test files
node test/runtime/test-verification.mjs
node test/runtime/test-budget-planning.mjs
```

---

## PROGRESS LOG

| Task | Started | Completed | Notes |
| ---- | ------- | --------- | ----- |
| 1.1  |         |           |       |
| 1.2  |         |           |       |
| 1.3  |         |           |       |
| 1.4  |         |           |       |
| 1.5  |         |           |       |
| 2.1  |         |           |       |
| 2.2  |         |           |       |
| 2.3  |         |           |       |
| 2.4  |         |           |       |
| 3.1  |         |           |       |
| 3.2  |         |           |       |
| 3.3  |         |           |       |
| 4.1  |         |           |       |
| 4.2  |         |           |       |
| 4.3  |         |           |       |

---

## If Stuck

- **Build errors**: Use `npx tsc --noEmit` to find type errors
- **Extension not loading**: Check `pi -e <path>` for startup errors
- **Tests failing**: Check if test imports `dist/` files (pre-existing issue)
- **Heartbeat not firing**: Check `heartbeat_status` tool output
- **Policy engine dead**: Verify `policyEngineReady` is set to `true` at startup

## Emergency Abort

If something goes wrong and needs rollback:

```bash
git stash  # Save current changes
git log --oneline -5  # Find last good commit
git checkout <good-commit-hash>  # Revert to known good state
```

---

## Parallel Agent Inputs Incorporated

Added from parallel agent audits (`mem-mo342dag`, `mem-mo91o7ja`) + proposal docs:

| Source                             | Key Findings                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `mem-mo91o7ja` (codebase audit)    | 4 CRITICAL issues: monkey patches, globalThis duplicates, broken type guard, HTTP 429 conflict     |
| `mem-mo342dag` (tool audit)        | 2 duplicate tool names found                                                                       |
| `TOOL_IMPROVEMENTS_PROPOSAL.md`    | Tool v2: think() depth+chains, hypothesize() ranked, memory_recall() relevance, memory_store() TTL |
| `PROPOSAL_TOPIC_DRIFT_DETECTOR.md` | Semantic drift detection before generation                                                         |
| `CODEBASE-AUDIT-FULL.md`           | 4 CRITICAL + 4 HIGH + 9 MODERATE issues across codebase                                            |

Full consolidated plan: `docs/OVERNIGHT-PLAN-UPDATED.md`
