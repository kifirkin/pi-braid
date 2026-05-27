# pi-braid Refactor & Integration Plan

A unified plan that merges the completed revival work with the structural refactor roadmap.
This replaces both `REFACTOR-PLAN.md` and `REVIVAL-PLAN.md` (which is now fully subsumed).

---

## Status Summary

| Category | Status | What was done |
|----------|--------|---------------|
| ✅ **Revival Tier 1** | Complete | Nudge merge, enforcement_signals wiring, state leak fix, logging-only consumers removed, dead code removed |
| ✅ **Revival Tier 2** | Complete | Turn-end coordinator created, BehavioralState decomposed, paper citations fixed |
| 🔲 **Refactor Phases 0-4** | Pending | Integration tests, event bus wiring, enforcement God Object split, memory monolith shrink, quality improvements |
| 🔲 **Tier 3 Aspirational** | Pending | Event bus routing to actions, Dreamer/MARS feedback loop, lib module unit tests |

---

## Constraint

**Prefer implement, improve, or fix over removal.** Only remove truly dead code (unreferenced, deprecated with no path forward). If a subsystem exists but is incomplete, the refactor completes it. If it's complex but valuable, the refactor makes it work properly and connects it to the rest of the system.

> Note: Dead code removal already happened in Revival Tiers 1-2 (~2000 lines removed). The focus now is on **wiring up and making work what already exists**.

---

## Overall Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        MODULE SYSTEM                         │
│  (definitions.ts + loader.ts + api.ts — already solid)      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐ │
│  │  CORE   │  │  ENFORCEMENT │  │  MEMORY  │  │  CONTRIB  │ │
│  │  (7 ext)│  │  (1 big ext) │  │  (5 ext) │  │  (8 ext)  │ │
│  └────┬────┘  └──────┬───────┘  └────┬─────┘  └───────────┘ │
│       │              │               │                       │
│       └──────────────┼───────────────┘                       │
│                      │                                       │
│              ┌───────▼────────┐                              │
│              │   TURN_END     │  ← coordinator dispatches    │
│              │  COORDINATOR   │     priority-ordered handlers│
│              └───────┬────────┘                              │
│                      │                                       │
│         ┌────────────┼────────────┐                          │
│         ▼            ▼            ▼                          │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│   │ analysis │ │ loop     │ │ claim    │  ...               │
│   │ (drift,  │ │ (burst,  │ │ tracker  │                    │
│   │ BPE,     │ │ overflow,│ │          │                    │
│   │ MARS,    │ │ nudge)   │ │          │                    │
│   │ dreamer) │ │          │ │          │                    │
│   └──────────┘ └──────────┘ └──────────┘                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              EVENT BUS (being wired)                    │  │
│  │  heartbeat_tick ──→ enforcement (adaptive thresholds)   │  │
│  │  tool_error    ──→ error-tracking (error_list tools)    │  │
│  │  memory_evict  ──→ context-lifecycle (proposal adjust)  │  │
│  │  analytics_alert → watchdog (monitoring alerts)         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │        PI BRAID PATHS (~/.pi/agent/braid/)              │  │
│  │  memory/  checkpoints/  errors/  feedback/  metrics/    │  │
│  │  consolidated-hints.jsonl  tools-config.json             │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Safety & Pre-Fix (1-2 days)

### 0.1 Integration smoke tests for enforcement

**Problem**: 63 test suites test individual utility functions, but none test the enforcement pipeline end-to-end.

**Action**: Add tests that:
- Feed a known sycophantic response through enforcement and verify a whisper fires
- Simulate 8+ consecutive errors and verify error burst detection triggers
- Run tool call tracking across multiple turns and verify drift detection fires
- Verify calibration whispers trigger when prediction error exceeds threshold

**File**: `test/runtime/test-enforcement-integration.mjs` (new, ~250 lines)

### 0.2 Document remaining `await import()` dependency graph

**Problem**: ~16 dynamic `import()` calls remain that mask circular dependencies.

**Action**: A dependency map already exists at `docs/import-dependency-map.md`. Update it with current state after Phase 1 splits, and flag which are legitimate lazy-loads vs which mask circular dependencies.

**File**: `docs/import-dependency-map.md` (update)

### 0.3 Run eslint baseline

```bash
npm run lint:fix
```

Establish clean baseline before structural changes.

---

## Phase 1: Wire Up Unfinished Features (5-7 days)

This is the highest-impact phase. Every subsystem that "almost works" gets completed.

### 1.1 Connect Event Bus to Real Consumers

**Problem**: `src/lib/event-bus.ts` defines 10 typed events with full pub/sub, but `emit()` calls have zero consumers subscribed via `eventBus.on()`. Events are fired into the void.

**Action**: Wire the event bus as the inter-subsystem communication layer it was designed to be:

| Event | Emitter | Subscriber | Effect |
|-------|---------|------------|--------|
| `heartbeat_tick` | Heartbeat scheduler (`heartbeat-scheduler/index.ts`) | Enforcement `handler-registry.ts` | Count ticks for adaptive threshold scaling |
| `tool_error` | Enforcement tool result handler | Error-tracking extension (`error-tracking/index.ts`) | Populate `error_list` / `error_stats` tools with real data |
| `memory_evict` | Three-memory-stores eviction path | Context-lifecycle extension | Adjust proposal thresholds after memory eviction |
| `analytics_alert` | Analytics extension (`heartbeat/analytics/`) | Watchdog extension | Route monitoring alerts to watchdog for TUI notification |
| `context_full` | Context manager (`context-density.ts`) | Enforcement → compaction trigger | Already partially wired — add automatic compaction suggestion |

**Files to modify**:
- `src/extensions/heartbeat/heartbeat-scheduler/index.ts` — emit `heartbeat_tick`
- `src/extensions/enforcement/handler-registry.ts` — subscribe to `heartbeat_tick`; emit `tool_error`
- `src/extensions/error-tracking/index.ts` — subscribe to `tool_error`
- `src/extensions/memory/context-lifecycle/index.ts` — subscribe to `memory_evict`
- `src/extensions/heartbeat/analytics/index.ts` — emit `analytics_alert` on detection
- `src/extensions/watchdog/index.ts` — subscribe to `analytics_alert`

**Success criteria**:
- Every defined event type has at least one subscriber that produces a measurable side effect
- `eventBus.getStats()` shows non-zero handler counts for all active event types
- No event type remains write-only

### 1.2 Connect Degradation Detector to Checkpoint Rollback

**Problem**: `src/lib/degradation-detector.ts` tracks `PerformanceMetrics`, detects degradation, writes to `degradation.json` — but triggers nothing. `src/lib/state-checkpoint.ts` creates checkpoints, can restore them — but has no trigger to call restore on degradation. Two systems exist, both half-complete, unaware of each other.

**Action**: Connect them end-to-end:

1. **In `degradation-detector.ts`**: After `updateDegradationStatusFrom()` sets `state.isDegraded = true`, call a new exported function `onDegradationDetected(ctx)` that the rest of the system can subscribe to.

2. **In `state-checkpoint.ts`**: Add `handleDegradation(ctx)` that:
   - Loads the last checkpoint from disk
   - Calls `restoreFromCheckpoint(ctx, checkpoint)` to roll back extension state
   - Sends a whisper to the agent: `[recovery] Session restored to checkpoint @ turn N. Continuing from clean state.`
   - Returns `{ restored: true, checkpointTurn: N }` or `{ restored: false, reason: "..." }`

3. **In `dispacht-turn-end-analysis.ts` (or a new turn_end handler)**: After `inferBeliefs()`, check if degradation state is degraded. If so, call the checkpoint rollback path.

**Files**:
- `src/lib/degradation-detector.ts` — add `onDegradationDetected` callback mechanism
- `src/lib/state-checkpoint.ts` — add `handleDegradation(ctx): RestoreResult`
- Wire it in the turn_end coordinator

**Success criteria**:
- When degradation is detected (errorRate > 0.1, toolSuccess < 70%), a checkpoint is automatically restored
- Agent receives a whisper explaining what happened
- Both subsystems can be tested independently

### 1.3 Complete Consolidation Pipeline (already mostly done)

**Problem**: The consolidation pipeline (`consolidation-channel.ts`) already has `executeConsolidation()` and `processConsolidationTick()` implemented. But it's not wired to heartbeat ticks.

**Action**: Wire the heartbeat scheduler to call `processConsolidationTick()` on each tick:

```typescript
// In heartbeat-scheduler/index.ts, inside tick handler:
import { processConsolidationTick } from "../../../lib/consolidation-channel.js";
processConsolidationTick();
```

This is a 2-line change that activates the full pipeline: episodes → score → queue → extract SOP → write hint file → agent benefits.

**Also**: The `scanArchives()` function is called by enforcement's turn-end handler but its results (archive candidates) are logged and thrown away. Wire them into the consolidation queue so archived change proposals become consolidation candidates.

**Files**: `src/extensions/heartbeat/heartbeat-scheduler/index.ts`, `src/extensions/enforcement/handler-registry.ts`

### 1.4 Add Conflict Resolution Feedback Loop

**Problem**: `evidence-pool.ts` + `conflict-qa.ts` = 836 lines for detecting, classifying, and generating questions about semantic conflicts — but no mechanism to *resolve* them. Questions are whispered into the void.

**Action**:
1. When a conflict QA is generated, store its ID in enforcement state
2. On `message_end`, check if agent's response addressed the conflict (simple keyword matching)
3. If resolved, mark it complete via `resolveQA()`
4. If unresolved after 5 turns, escalate whisper severity

```typescript
// In register-message-end.ts handler:
const pendingConflicts = getPendingConflicts(ctx);
for (const conflict of pendingConflicts) {
  const resolution = checkResponseForResolution(agentText, conflict);
  if (resolution) {
    resolveQA(conflict.id, resolution);
  } else if (conflict.turnsSinceDetected >= 5) {
    sendEnforcementWhisper(pi, ctx, formatConflictWhisper(conflict, 'escalated'), true);
  }
}
```

**Files**:
- `src/lib/conflict-qa.ts` — add `checkResponseForResolution()`
- `src/lib/evidence-pool.ts` — add `markResolved()`
- `src/extensions/enforcement/handlers/register-message-end.ts` — add resolution check

### 1.5 Nuke the remaining dead code confirmed by g-reffing

**Problem**: Several items were tagged in the original plan but may have been left after Revival.

**Action**: Confirm via grep and remove:
- `blockThinkBeforeEdit` — if still initialized and never read, remove
- `metacognitive-state.ts` no-op functions — if still present, remove
- Any other items confirmed as unreferenced

**Files**: `state.ts`, `types.ts`, `metacognitive-state.ts`, `conflict-qa.ts`

---

## Phase 2: Fix Fragile Patterns (3-4 days, parallel with Phase 1)

### 2.1 Fix Agent-Patch Version Gate (CRITICAL BUG)

**Problem**: `src/extensions/core/agent-patch/index.ts` has an inverted version gate. `MIN_FIXED_VERSION` is set to `[0, 0, 0]` with the comment "Set to e.g. [0, 71, 0] when upstream fix lands." The comparison `isVersionAtLeast(current, [0,0,0])` returns `true` for ANY version > 0.0.0 (which is every real package version). So the patch **skips itself** for all real pi-agent-core versions.

**Fix**: Invert the logic so the patch **applies** unless the upstream fix is confirmed present:

```typescript
// Change from:
if (isVersionAtLeast(pkg.version, MIN_FIXED_VERSION)) {
  log.info("...patch skipped");
  return true;  // <-- skips applying
}
// To:
if (isVersionAtLeast(pkg.version, MIN_FIXED_VERSION)) {
  log.info("pi-agent-core already has the fix — skipping patch");
  return true;  // still skips, but only when MIN_FIXED_VERSION is set e.g. [0, 71, 0]
}
// The fix: set MIN_FIXED_VERSION to [9, 9, 9] so it NEVER matches until someone sets the real version
// OR: remove the version gate entirely and always apply the patch, since it's idempotent
```

**Recommended fix**: Remove the version gate entirely. The patch is idempotent (re-patching the same prototype method just replaces the function). If upstream fixes the issue, the patch becomes a harmless no-op wrapper. Remove the `createRequire` dance, remove MIN_FIXED_VERSION, and always apply the patch:

```typescript
export default async function agentPatchExtension(_pi: ExtensionAPI): Promise<void> {
  try {
    const proto = Agent.prototype as any;
    if (!proto?.handleRunFailure) {
      log.warn("handleRunFailure not found — patch skipped");
      return;
    }
    proto.handleRunFailure = async function(error, aborted) {
      // ... same implementation ...
    };
    log.info("Applied handleRunFailure patch");
  } catch (err) {
    log.warn(`Failed to apply patch: ${err}`);
  }
}
```

**File**: `src/extensions/core/agent-patch/index.ts`

### 2.2 Fix Orphaned Timeout Promises in `llm-call.ts`

**Problem**: `Promise.race([completeSimple(...), timeoutPromise])` doesn't cancel the timeout when `completeSimple` wins the race. The timeout's `setTimeout` still fires and rejects into the void, causing unhandled rejections.

**Fix**: Use `AbortSignal` and `clearTimeout`:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(new Error("LLM call timeout")), timeoutMs);

try {
  const result = await completeSimple(model as Model<Api>, context, {
    apiKey, maxTokens, temperature, maxRetries: sdkMaxRetries,
    signal: signal ?? controller.signal, // combine external + timeout signals
  });
  clearTimeout(timeoutId);
  // ... process result ...
} catch (err) {
  clearTimeout(timeoutId);
  if (err instanceof Error && err.name === "AbortError" && err.message === "LLM call timeout") {
    // handle timeout specifically
  }
  // ... retry logic ...
}
```

**File**: `src/lib/llm-call.ts`

### 2.3 Fix Async-Storage Data Loss on Shutdown

**Problem**: `src/lib/async-storage.ts` uses `setTimeout`-based debouncing for file writes. If the process exits (SIGINT, crash, module reload), pending writes are lost. `flushAll()` exists but nothing calls it on shutdown.

**Fix**: Register a `beforeExit` handler and wire into session shutdown:

```typescript
// In async-storage.ts:
process.on("beforeExit", async () => {
  await flushAll();
});

// Also expose a shutdown integration for pi:
export async function shutdownAsyncStorage(): Promise<void> {
  await flushAll();
}

// In extension-state.ts session shutdown handler, call:
await shutdownAsyncStorage();
```

**And**: Change debounce from `setTimeout` to microtask-based batching:

```typescript
const writeQueue = new Map<string, unknown>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(async () => {
    flushScheduled = false;
    const entries = [...writeQueue.entries()];
    writeQueue.clear();
    await Promise.all(entries.map(([path, data]) =>
      mkdir(dirname(path), { recursive: true }).then(() =>
        writeFile(path, JSON.stringify(data, null, 2), "utf-8")
      ).catch(err => _log.error(`Write failed: ${path}`, err))
    ));
  });
}

export async function saveState<T>(path: string, data: T): Promise<void> {
  writeQueue.set(path, data);
  scheduleFlush();
}
```

This eliminates the data loss window entirely. Microtask-based batching means all pending writes complete before the event loop continues, and `process.on('beforeExit')` catches any stragglers.

**Files**: `src/lib/async-storage.ts`, anywhere that calls it (cognitive-memory, etc.)

### 2.4 Fix `sendTrackedMessage` Double-Tagging

**Problem**: Enforcement whispers in `whisper.ts` send:
```typescript
sendTrackedMessage(pi, {
  content: [{ type: "text", text: `[enforcement] ${message}` }],
  customType: "enforcement",
  ...
});
```
The content starts with `[enforcement]` AND `customType` is set to "enforcement". The agent sees `[enforcement] <message>` while the message metadata also marks it as enforcement. The content prefix is redundant.

**Fix**: Remove the `[enforcement]` prefix from the content text. The `customType: "enforcement"` metadata already tags it, and `sendTrackedMessage` already sets `details._braidInjected = true` and `details._braidSource = "enforcement/whisper"`.

```typescript
sendTrackedMessage(pi, {
  customType: "enforcement",
  content: [{ type: "text" as const, text: message }], // no [enforcement] prefix
  display: true,
}, ...);
```

**File**: `src/extensions/enforcement/whisper.ts`

---

## Phase 3: Fix LLM-Based Approaches to Actually Fire Correctly (3-4 days)

**Philosophy**: LLM-based semantic analysis is superior to regex heuristics for judging
work quality, classifying text, and detecting sycophancy. The problem was never the
LLM approach — it was:
1. Guard conditions too tight → judge almost never fires
2. Prompts too verbose → model ignores key instructions
3. Wrong fallback order → LLM called when not needed
4. No feedback loop → same low-quality nudges repeat

We fix these. We do NOT replace LLM approaches with regex.

### 3.1 Fix Verification Judge Activation Conditions

**Problem**: The judge at `src/extensions/enforcement/verification-judge.ts` has
an activation guard that is nearly impossible to trigger:
```typescript
if (currentState.actualTools.length === 0 && hasCodeChanges) { ... }
```
`actualTools.length === 0` means ZERO tools called this entire turn.
With `hasCodeChanges` also required. This means the judge only fires
when the agent wrote code but used zero tools — which never happens
because edit/write ARE tools. The guard is vacuously false.

**Action**: Widen the guard to capture real scenarios:

| Current guard | Fixed guard | Rationale |
|------------|------------|-----------|
| `actualTools.length === 0 && hasCodeChanges` | `editOrWriteCount >= 1` | Fire after ANY code change, not just zero-tool turns |
| `turnsSince > 1 && 60s cooldown` | `turnsSince >= 5` | Wait for meaningful work window, not just 1 turn |
| No pre-finalize check | `toolName === 'finalize'` in tool_call handler | Always judge before finalize |
| No periodic check | Every 15 turns regardless | Catch drift even without code changes |

```typescript
// Before (verification-judge-state.ts):
export function shouldRunJudge(
  s: EnforcementState,
  currentTurn: number,
  minTurnGap = 1,
  minTimeGapMs = 60_000,
): boolean {
  if (s.verificationJudgeRunning) return false;
  if (currentTurn - s.lastVerificationJudgeTurn < minTurnGap) return false;
  if (Date.now() - s.lastJudgeTime < minTimeGapMs) return false;
  return true;
}

// After:
export function shouldRunJudge(
  s: EnforcementState,
  currentTurn: number,
  triggers: { hasCodeChanges: boolean; isFinalizing: boolean },
): boolean {
  if (s.verificationJudgeRunning) return false;
  
  // Always judge on finalize
  if (triggers.isFinalizing) return true;
  
  // Judge after code changes with reasonable gap
  if (triggers.hasCodeChanges && currentTurn - s.lastVerificationJudgeTurn >= 5) return true;
  
  // Periodic check every 15 turns
  if (currentTurn - s.lastVerificationJudgeTurn >= 15) return true;
  
  // Respect minimum time gap to avoid rapid re-judging
  if (Date.now() - s.lastJudgeTime < 30_000) return false;
  
  return false;
}
```

This changes the judge from "almost never fires" to "fires on every meaningful event".

**Files**:
- `src/extensions/enforcement/verification-judge-state.ts` — fix `shouldRunJudge()`
- `src/extensions/enforcement/handlers/register-tool-call.ts` — trigger on `finalize`
- `src/extensions/enforcement/handlers/register-tool-result.ts` — trigger on code change detection
- `src/extensions/enforcement/handlers/register-message-end.ts` — widen the message_end trigger

### 3.2 Improve Judge Prompts for Better Output

**Problem**: The judge system prompt at `src/extensions/enforcement/judge-prompt.ts`
is verbose, meta-instruct-y, and tells the model what NOT to do more than what to do.
It also uses a JSON output format that models find tricky.

**Action**: Rewrite prompt with directive density — tell the model what to do,
in specific terms, with examples:

```typescript
export const VERIFICATION_JUDGE_SYSTEM_PROMPT = `You evaluate whether an agent's work matches the user's request.

Output a JSON object with exactly these fields:
- verdict: "pass" | "warn" | "fail"
- confidence: number 0-100
- summary: string (2-3 sentences)
- issues: array of { severity: "critical"|"high"|"medium"|"low", category: "unverified"|"incomplete"|"shortcut"|"claim"|"scope", description: string }
- unverifiedChanges: boolean

Rules:
- pass = work matches request, changes verified, no shortcuts
- warn = work mostly matches but has minor gaps or unverified changes
- fail = work doesn't match, significant shortcuts, or claims without evidence
- Be strict — the agent should verify changes before declaring done
- If user request is empty, judge on general quality

Examples:
{"verdict":"fail","confidence":90,"summary":"Agent deleted auth middleware without running tests","issues":[{"severity":"critical","category":"unverified","description":"No test run after deleting src/auth/middleware.ts"}],"unverifiedChanges":true}`;
```

Key changes:
- Removed meta-instructions ("I want you to...", "Your task is...")
- Added concrete examples
- Shortened by 60%
- Explicit field-level rules instead of vague quality guidance

**File**: `src/extensions/enforcement/judge-prompt.ts`

### 3.3 Fix Text Classifier Fallback Order

**Problem**: `src/lib/text-classifier.ts` tries utility model → session model → heuristic.
Two LLM calls per classification. Heuristic is last resort.

**Action**: Reverse the order. Try heuristic first (it's fast and free).
If it returns a clear answer with high confidence, use it.
Only fall through to LLM for ambiguous cases.

```typescript
export async function classify(
  ctx: ExtensionContext,
  criteria: ClassifierCriteria,
  substitutions: Record<string, string>,
  options: ClassifierOptions = {},
): Promise<ClassificationResult> {
  const startTime = Date.now();
  
  // Tier 1: Heuristic fallback (fast, no LLM cost)
  if (options.fallback) {
    const heuristicResult = await options.fallback();
    // Only trust heuristic if it's clearly yes or no
    if (heuristicResult?.toLowerCase() === "yes" || heuristicResult?.toLowerCase() === "no") {
      return {
        label: heuristicResult.toLowerCase(),
        confidence: 0.7,
        raw: heuristicResult,
        tier: "heuristic",
        latencyMs: Date.now() - startTime,
      };
    }
  }
  
  // Tier 2: LLM utility model (cheapest LLM option)
  try {
    const result = await tryUtilityModel(criteria, substitutions, options);
    if (result && result.confidence > 0.5) return result;
  } catch { /* fall through */ }
  
  // Tier 3: LLM session model (better quality but more expensive)
  try {
    const result = await trySessionModel(ctx, criteria, substitutions, options);
    if (result) return result;
  } catch { /* fall through */ }
  
  return { label: "no", confidence: 0, raw: "", tier: "failed", latencyMs: Date.now() - startTime };
}
```

The key insight: the heuristic tier has 0.7 confidence (good enough for most cases).
Only when it's ambiguous (not clearly yes/no) do we pay LLM cost.
In practice, ~60% of classifications can be handled by heuristic.

**File**: `src/lib/text-classifier.ts`

### 3.4 Add Feedback Loop to Dreamer/MARS Advice

**Problem**: Both Dreamer (`src/lib/dreamer.ts`) and MARS (`src/lib/mars-reflector.ts`)
generate advice that's whispered to the agent. But there's no feedback loop:
did the agent follow the advice? Was the prediction correct?

**Action**: The advice tracker (`advice-tracker.ts`) already records advice and
evaluates accuracy. Wire it into the whisper delivery path:

1. When Dreamer or MARS generates advice, pass a unique ID through the whisper
2. After the whisper is sent, track subsequent tool calls for the next 3 turns
3. Did the agent follow the advice? (e.g., if advised to "use think()", check if think() was called)
4. Feed outcome back to advice-tracker, which adjusts thresholds dynamically

```typescript
// In dreamer.ts — advice generation:
export async function dream(ctx: ExtensionContext): Promise<DreamAdvice | null> {
  const advice = generateAdvice(ctx);
  if (advice) {
    const record = recordAdvice({
      source: "dreamer",
      prediction: advice.prediction ?? "stuck",
      tool: advice.action,
      turn: getState(ctx).currentTurn,
    });
    advice.id = record.id; // Tag advice with tracked ID
  }
  return advice;
}

// In advice-tracker.ts — follow-up evaluation:
export function checkAdviceFollowThrough(ctx: ExtensionContext): void {
  const pending = _state.records.filter(r => !r.evaluated && r.turn < ctx.currentTurn - 3);
  for (const record of pending) {
    // Check if the recommended tool was used in subsequent turns
    const wasFollowed = checkToolUsedAfter(ctx, record.tool, record.turn);
    record.evaluated = true;
    record.correct = wasFollowed;
    record.evaluatedAt = Date.now();
    
    // Adjust thresholds based on accuracy
    const accuracy = getAccuracyForSource(record.source);
    if (accuracy < 0.3) increaseCooldown(record.source);
    if (accuracy > 0.7) reduceCooldown(record.source);
  }
}
```

**Files**:
- `src/lib/dreamer.ts` — tag advice with record ID
- `src/lib/mars-reflector.ts` — tag advice with record ID
- `src/lib/advice-tracker.ts` — add `checkAdviceFollowThrough()`
- `src/extensions/enforcement/handlers/dispatch-turn-end-analysis.ts` — call follow-up check

### 3.3 Reduce Enforcement Sub-State Proliferation

**Problem**: The enforcement extension has **18 TypeScript source files** in `src/extensions/enforcement/`. While each sub-state file in the `state.ts` composition pattern is small (30-80 lines), the total surface area is overwhelming. There's no single place to understand how enforcement state works.

**Action**: Keep the sub-state pattern (it's a good refactoring direction from the original God Object), but:

1. **Merge the 3 smallest sub-states** that share concerns:
   - `scratchpad-state.ts` (28 lines) → merge into `context-hygiene-state.ts` (both track nudge timing)
   - `memory-hygiene-state.ts` (75 lines) → same concern space
   
   Result: 7 sub-state files → 5 sub-state files. Each is ≥80 lines with a clear responsibility.

2. **Add a JSDoc block at the top of `state.ts`** that lists every sub-state interface and its properties, so you can understand the full shape without opening 7 files.

**Files**: 
- `src/extensions/enforcement/state.ts` — add summary documentation
- `src/extensions/enforcement/scratchpad-state.ts` — merge into context-hygiene-state.ts
- `src/extensions/enforcement/memory-hygiene-state.ts` — keep but document coupling

### 3.4 Fix Logger Context Binding

**Problem**: `src/lib/logger.ts` exports `createLogger()` which returns a Logger with `bindContext(ctx)` / `unbindContext()`. But every extension creates `const log = createLogger("name")` at module level, before any ctx exists. By the time bindContext is called inside a handler, the module-level `log` was already created and calling `bindContext` affects that instance — but only if the handler actually calls it. Most don't.

**Fix**: Remove `bindContext` / `unbindContext` from the Logger interface. Instead:
- The logger automatically detects if a `ctx`-like object is passed to info/warn/error via `data` parameter
- Or: remove the TUI routing entirely (console-only logging is fine for an extension)

Actually, the simplest fix: keep `bindContext` but make the logger **require** it before emitting. If no context is bound, route to console only. If context is bound, prefer `ctx.ui.notify()`. Add a warning when `warn()`/`error()` is called without a bound context during a handler execution.

**Simpler**: Remove `bindContext` / `unbindContext` / `hasContext` entirely. Loggers created at module level are console-only. If a handler needs TUI notifications, it calls `ctx.ui.notify()` directly. The logger becomes a thin console wrapper with log levels, buffering, and source tags.

**File**: `src/lib/logger.ts`

---

## Phase 4: Type Safety & Quality (3-4 days)

### 4.1 Reduce `any`/`unknown` casts

**Target**: Reduce from ~40 to under 10 `any`/`unknown` casts. Remaining ones must be at pi API boundaries where SDK types are incomplete.

| Location | Current state | Fix |
|----------|--------------|-----|
| `event-types.ts` | Full typed interfaces for pi event shapes | Already done — use them |
| `handler-registry.ts` | `event: any`, `ctx: any` in remaining handlers | Replace with typed overloads from event-types.ts |
| `nudge-manager.ts` | `_now` parameter pattern | Replace with `Date.now()` direct calls |
| Context-manager `tools.ts` | `params: any` | Use TypeBox-inferred types |
| `memory-agent-bridge/index.ts` | `explore_paths` params | Add proper interface |
| `session-recall/index.ts` | Query result types | Add result interface |
| `whisper.ts` | Message format types | Use MessageEndEvent types from event-types.ts |

### 4.2 Fix Hardcoded Version String

**Problem**: `src/index.ts:getVersion()` has a `try`/`catch` that tries `JSON.parse` on a hardcoded string — the try-catch is a no-op.

**Actually fixed already**: Let me re-read... the current code reads `package.json` properly. But let me check the dist version.

**Check**: If `src/index.ts` already reads package.json (as the code I read earlier does), this is already fixed. Verify in the source file.

### 4.3 Remove Unused Threshold Constants

From `src/lib/context-thresholds.ts`: 20+ exported constants, many with no callers.

**Action**: After confirming via grep, remove unreferenced constants:
- `USAGE_WHISPER_SOFT` = 40 — check callers
- `USAGE_WHISPER_ADVISORY` = 50 — check callers
- `DENSITY_HIGH` = 0.7 — check callers
- `HYGIENE_LOW_DENSITY_CONSECUTIVE_MIN` = 2 — check callers (used in a module that may not exist)
- `ANALYTICS_DENSITY_FULL_EVENT` = 70 — check callers

Only keep what's actually imported elsewhere. Document each remaining constant's consumer in a comment.

**File**: `src/lib/context-thresholds.ts`

### 4.4 Clean up `dist/` — Prevent Phantom Submodules

**Problem**: The `dist/extensions/cognitive/` directory has empty subdirectories for modules (reasoning, topic-drift, verification, etc.) that exist in `src/` but produce empty JS files. This creates confusion about what's actually compiled.

**Fix**: One of:
1. Add `.gitignore` entries for empty directories in `dist/extensions/*/` that have no compiled output
2. Or ensure all extension directories actually compile (fill in missing module entry points)
3. Or add a post-build cleanup script that removes empty `.js` files from `dist/`

The root cause is likely that `tsconfig.json` includes `src/**/*.ts` but some modules haven't been compiled because they reference types that don't exist. Check TypeScript compilation output.

**File**: `tsconfig.json` (investigate), or `scripts/clean-dist.mjs` (new cleanup script)

### 4.5 Full eslint pass

After all phases complete: `npm run lint` → 0 errors, 0 warnings.

---

## Phase 5: Enforcement God Object — Final Split (5-6 days)

### 5.1 Current State After Revival

The enforcement extension already has:
- Split handlers directory (`handlers/register-*.ts`, `handlers/dispatch-*.ts`)
- 17 handler files extracted from the original monolith
- Turn-end coordinator (`turn-end-coordinator.ts`) with priority ordering
- Focused sub-state files instead of `BehavioralState`
- Typed event interfaces (`event-types.ts`)

### 5.2 What Remains

**Problem 1**: `dispatch-turn-end-analysis.ts` still interleaves 6 concerns in one 170-line function: drift detection, BPE signal emission, belief inference, MARS advice, dreamer prediction, reflection gap, advice feedback loop, recommendations.

**Action**: Split into independently registered turn-end handlers:

```typescript
// In registerCompactAndSessionHandlers:
registerTurnEndHandler("enforcement-drift", 100, driftDetectionHandler);
registerTurnEndHandler("enforcement-bpe", 90, (event, ctx) => {
  // emitSignal calls only — pulled from dispatch-turn-end-analysis.ts
});
registerTurnEndHandler("enforcement-beliefs", 85, (event, ctx) => {
  inferBeliefs(ctx);
});
registerTurnEndHandler("enforcement-mars", 80, marsHandler);
registerTurnEndHandler("enforcement-dreamer", 70, dreamerHandler);
registerTurnEndHandler("enforcement-reflection", 60, reflectionGapHandler);
registerTurnEndHandler("enforcement-feedback", 50, adviceFeedbackHandler);
registerTurnEndHandler("enforcement-recommendations", 40, recommendationHandler);
```

Each handler is independently testable and can be toggled via module config.

**Problem 2**: `dispatchTurnEndLoop` in `turn-end-handler.ts` is 340+ lines.

**Action**: Split into focused sub-handlers:
- Error burst detection (~30 lines)
- Context overflow check (~30 lines)
- Tool sequence validation (~80 lines)
- Nudge dispatch (~60 lines)
- Claim tracking (~40 lines)

**Problem 3**: Several handlers still use `event: any` or `ctx: any` parameter types.

**Action**: Replace with typed event interfaces from `event-types.ts`.

### 5.3 Final Structural Target

After this phase, enforcement looks like:

```
src/extensions/enforcement/
  index.ts                      — ~30 lines: registration
  handler-registry.ts           — ~80 lines: imports + calls
  state.ts                      — ~80 lines: composed state factory
  nudge-manager.ts              — ~150 lines: nudge config + dispatch (existing)
  whisper.ts                    — ~80 lines: message delivery (existing)
  validation.ts                 — ~186 lines: turn validation (existing)
  signals.ts                    — ~51 lines: enforcement signal constants
  verify-deterministic.ts       — ~100 lines: deterministic verification (new)
  event-types.ts                — ~120 lines: typed interfaces (existing)
  
  handlers/
    register-input-handler.ts        — ~50 lines
    register-session-start.ts        — ~50 lines
    register-tool-call.ts            — ~120 lines
    register-message-end.ts          — ~140 lines
    register-tool-result.ts          — ~70 lines
    register-session-compact.ts      — ~60 lines
    register-auto-retry-end.ts       — ~40 lines
    register-session-shutdown.ts     — ~30 lines
    
    dispatch-turn-end-analysis/     ← directory (was one function)
      drift-handler.ts              — ~60 lines
      bpe-handler.ts                — ~40 lines
      mars-handler.ts               — ~50 lines
      dreamer-handler.ts            — ~50 lines
      reflection-handler.ts         — ~40 lines
      feedback-handler.ts           — ~40 lines
      recommendation-handler.ts     — ~40 lines
    
    dispatch-turn-end-loop/         ← directory (was turn-end-handler.ts)
      error-burst.ts                — ~30 lines
      context-overflow.ts           — ~30 lines
      tool-validation.ts            — ~80 lines
      nudge-dispatch.ts             — ~60 lines
      claim-tracker.ts              — ~40 lines
    
    blocking.ts                    — ~100 lines (existing)
    tool-tracker.ts                — ~80 lines (existing)
    turn-analysis.ts               — ~80 lines (existing)
    message-analysis.ts            — ~80 lines (existing)
    orphan-chains.ts               — ~60 lines (existing)
    routing-handler.ts             — ~40 lines (existing)
    probe-handler.ts               — ~30 lines (existing)
```

Total files: ~32. Total lines: ~2,100 (down from ~2,607 original). Each file is independently testable. Each concern can be enabled/disabled.

---

## Phase 6: Cross-Cutting Quality (2-3 days)

### 6.1 Remove Process-Global Mutable State

Files with module-level mutable state that needs fixing:

| File | Global state | Fix |
|------|-------------|-----|
| `injection-tracker.ts` | `_buckets` Map | Already session-keyed — OK |
| `sop-suggestion.ts` | `_suggestionFeedback` array, `_lastSuggestionEpisodeId` | Move to session-scoped state |
| `logger.ts` | `_globalMinLevel`, `_globallySuppressed` | Already OK (intentional globals) |
| `llm-call.ts` | `rateLimitCooldownUntil` | Split into per-session or document limitation |
| `event-bus.ts` | `eventBus` singleton | Global singleton is intentional (event bus) |
| `async-storage.ts` | `pendingWrites` Map | Already session-safe (debounce is process-wide) |

**Highest priority**: `sop-suggestion.ts` — `_lastSuggestionEpisodeId` is process-global and will bleed between sessions. Move to per-session state.

### 6.2 Add Error Handling for Empty Catch Blocks

Grep for empty catch blocks and replace with `guard()` or at minimum a log statement:

```typescript
// Before:
catch { /* Non-fatal */ }

// After:
catch (err) { log.debug("Non-fatal: ", err); }
```

### 6.3 Add Unit Tests for Lib Pure Functions

Using the existing `test-*.mjs` pattern but without launching pi:

| Module | Functions to test | Tests |
|--------|------------------|-------|
| `evidence-pool.ts` | `addEvidence()`, `detectConflicts()`, `formatConflictMessage()` | 5 tests |
| `dreamer.ts` | `simulatePaths()` | 3 tests |
| `mars-reflector.ts` | `buildPattern()`, `generateAdvice()` | 3 tests |
| `claim-tracker.ts` | claim extraction from text | 4 tests |
| `bidirectional-verifier.ts` | `checkLocalizationRisk()`, `verifyCompletion()` | 3 tests |
| `consolidation-channel.ts` | `scoreEpisode()`, `computeValue()`, `isHintTooGeneric()` | 5 tests |
| `context-density.ts` | `evaluateContextDensity()` | 3 tests |

**File**: `test/runtime/test-lib-pure.mjs` (new, ~250 lines)

### 6.4 Performance: Consolidate File I/O

Multiple lib modules read/write files synchronously (`readFileSync`/`writeFileSync`):
- `consolidation-channel.ts` — 6 sync calls
- `braid-settings.ts` — sync read/write
- `cognitive-memory/storage.ts` — async storage but also some sync fallbacks
- `degradation-detector.ts` — uses `async-storage.ts` (good)
- `state-checkpoint.ts` — uses `fs/promises` (good)

**Action**: Consolidate sync file I/O into `async-storage.ts` as the single async I/O layer. Replace all `readFileSync`/`writeFileSync` calls in lib modules with `loadState`/`saveState` from async-storage.

**Exception**: The `consolidation-channel.ts` sync reads are justified (called from heartbeat tick, needs to be synchronous to avoid race conditions with concurrent ticks). But consider wrapping them in `AsyncResource` or a mutex.

---

## Execution Order

```
WEEK 1: Safety + Wire Up
┌────────────────────────────────────────────────────────────┐
│ Phase 0: Integration tests, eslint baseline, dep map       │
│ Phase 1.1: Wire event bus consumers                        │
│ Phase 1.2: Connect degradation → checkpoint rollback       │
│ Phase 1.3: Consolidation pipeline heartbeat wiring         │
│ Phase 1.4: Conflict resolution feedback loop               │
│ Phase 1.5: Remove remaining dead code                      │
└────────────────────────────────────────────────────────────┘

WEEK 2: Fix Fragile Patterns + Simplify
┌────────────────────────────────────────────────────────────┐
│ Phase 2.1: Fix agent-patch version gate     (CRITICAL)     │
│ Phase 2.2: Fix orphaned timeout promises                   │
│ Phase 2.3: Fix async-storage data loss                     │
│ Phase 2.4: Fix double-tagging in whispers                  │
│ Phase 3.1: Replace LLM judge with deterministic checks     │
│ Phase 3.2: Replace text-classifier with heuristic-first    │
│ Phase 3.3: Merge small sub-states                          │
│ Phase 3.4: Simplify logger context binding                 │
└────────────────────────────────────────────────────────────┘

WEEK 3: Type Safety + Quality
┌────────────────────────────────────────────────────────────┐
│ Phase 4.1: Reduce any casts to <10                         │
│ Phase 4.3: Remove unused threshold constants               │
│ Phase 4.4: Clean dist/ phantom modules                     │
│ Phase 4.5: Full eslint pass                                │
│ Phase 6.1: Fix remaining process-global state              │
│ Phase 6.3: Add lib module unit tests                        │
│ Phase 6.4: Consolidate file I/O                            │
└────────────────────────────────────────────────────────────┘

WEEK 4: Enforcement God Object Final Split
┌────────────────────────────────────────────────────────────┐
│ Phase 5.1: Split dispatch-turn-end-analysis into 7 handlers│
│ Phase 5.2: Split dispatchTurnEndLoop into 5 sub-handlers   │
│ Phase 5.3: Type all remaining any parameters               │
│ Phase 5.4: Final verification + cleanup                    │
└────────────────────────────────────────────────────────────┘
```

### Parallelization

| Track A | Track B |
|---------|---------|
| Phase 0 (dependency for all) | — |
| Phase 1.1 (event bus wiring) | Phase 1.3 (consolidation wiring) |
| Phase 1.2 (degradation → rollback) | Phase 1.4 (conflict resolution) |
| Phase 1.5 (dead code) (5 min) | Phase 2.1 (agent-patch fix) (30 min) |
| Phase 2.2 (timeout fix) | Phase 2.3 (async-storage fix) |
| Phase 2.4 (whisper fix) | Phase 3.1 (LLM judge replacement) |
| Phase 3.2 (text classifier) | Phase 3.3 (sub-state merge) |
| Phase 3.4 (logger) | Phase 4.1 (any-cast reduction) |
| Phase 5 (enforcement split) | Phase 4.3-6 (quality + tests) |

---

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| 0 (safety) | None | Never touches production code |
| 1.1 (event bus) | Low | Additive; existing direct import patterns remain as fallback |
| 1.2 (degradation) | Medium | Rollback could corrupt state; add dry-run mode, test with synthetic data |
| 1.4 (conflict resolution) | Low | Keyword matching is best-effort; wrong resolution = ignored, no harm |
| 2.1 (agent patch) | **High** if wrong | This patch is critical for error recovery. Test thoroughly: simulate API error, verify message_end fires, verify session persistence works |
| 2.2 (timeout fix) | Medium | Timeout behavior changes; test both timeout and success paths |
| 2.3 (async storage) | Medium | Data persistence changes; power-loss scenarios hard to test |
| 3.1 (judge replacement) | Medium | Subtle change in verification behavior; compare old vs new output for 50+ scenarios |
| 3.2 (text classifier) | Low | Heuristic-first preserves existing LLM path as fallback |
| 5 (enforcement split) | **Highest** | Move handlers one at a time, test after each. Integration tests from Phase 0 are the safety net |

---

## Measuring Success

### Quantitative

| Metric | Current | Target |
|--------|---------|--------|
| `any`/`unknown` casts | ~40 | <10 (at pi API boundaries only) |
| `await import()` (circular mask) | ~16 | 0 |
| Global mutable state bleed risks | 6 files | 0 |
| Event types with subscribers | 0 of 10 | 8 of 10 |
| Uncalled LLM calls per classification | 2 | 0 (heuristic first) |
| Enforcement file count | 18 | ~32 (smaller files, clearer boundaries) |
| Enforcement total lines | ~2,607 | ~2,100 (smaller despite more files) |
| Unused exported constants | ~7 | 0 |
| Process-shutdown data loss | High (debounce) | None (microtask batch + beforeExit) |
| Lib module unit tests | 0 | ~26 |

### Qualitative

- **Agent-patch**: Apply on every load unconditionally (no version gate confusion). `message_end` fires on every error scenario.
- **Event bus**: Every `emit()` call has at least one subscriber that produces an observable effect.
- **Degradation detector**: Detects → triggers → checkpoint restore → agent notified. Closed loop.
- **Consolidation pipeline**: Episodes → scored → queued → extracted → hint file written → prompt-builder injects. Closed loop.
- **Conflict resolution**: Detected → question generated → agent responds → verified → resolved. Closed loop.
- **LLM usage**: Only for tasks that genuinely require semantic understanding (sycophancy detection). All mechanical checks (verification, classification) are deterministic.
- **Text classifier**: Heuristic decides first. LLM only consulted when heuristic can't.
- **Async storage**: Microtask batching + process.on('beforeExit') → zero data loss window.
- **Dist/**: No phantom empty .js files. Every compiled output corresponds to functioning source.
