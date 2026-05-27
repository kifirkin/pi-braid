# pi-braid Refactor Implementation Plan

## Constraint

**Prefer implement, improve, or fix over removal.** Only remove truly dead code (unreferenced, deprecated with no path forward). If a subsystem exists but is incomplete, the refactor completes it. If it's complex but valuable, the refactor makes it work properly and connects it to the rest of the system.

---

## Codebase Profile

| Area | Files | Lines | Assessment |
|------|-------|-------|------------|
| Extensions/enforcement | 22 | 2,607 | God object with `any`-typed integration; 787-line handler registry |
| Extensions/memory | 22 | 8,484 | Heaviest module; context-manager alone is 4,001 lines |
| Extensions/core | 19 | 5,905 | Cleanest architecture; prompt-builder is well-structured |
| Extensions/heartbeat | 19 | 3,186 | Elaborate scheduler; dreamer name collision with lib/ |
| Extensions/cognitive | 6 | 1,753 | Well-scoped individual tools; solid |
| Lib/ | 45 | 9,696 | Mixed — logger/text-classifier excellent; consolidation pipeline incomplete |
| Contrib/ | 22 | 3,003 | Single-purpose, well-tested; healthy |
| Modules/ | 3 | 946 | Clean loader, API, definitions; solid |
| **Total** | **~160** | **~35,000** | |

### Key metrics
- **33** `await import()` calls — 17 for circular dependency breaking, 16 legitimate lazy-loading
- **54** `any`/`unknown` type casts — 22 in handler-registry.ts alone
- **63** passing runtime tests — but 0 test the enforcement integration pipeline
- **142** eslint problems (6 errors, 136 warnings, 77 auto-fixable)
- **0** TODO/FIXME markers in production code (good)

---

## Phase 0: Pre-Refactor Safety (1 day)

Goal: Ensure we can refactor without breaking behavior.

### 0.1 Integration smoke tests for enforcement

The 63 test suites test individual utility functions (`computeSimilarity`, `knownFiles` Map type, etc.). None test whether the enforcement pipeline actually catches bad behavior end-to-end. Before touching `handler-registry.ts`, add tests that:

- Feed a known sycophantic response through the enforcement pipeline and verify a whisper fires
- Simulate 8+ consecutive errors and verify error burst detection triggers
- Run tool call tracking across multiple turns and verify drift detection fires
- Verify calibration whispers trigger when prediction error exceeds threshold

**File**: `test/runtime/test-enforcement-integration.mjs` (new, ~200 lines)

### 0.2 Map the 33 `await import()` dependency graph

Not all dynamic imports are bad — some are legitimate laziness for startup performance (`node:child_process` in observatory, `node:fs` in prompt-builder). But 17 are cross-module imports that mask circular dependencies. Document every site in a dependency graph so Phase 3 can resolve them systematically.

**File**: `docs/import-dependency-map.md` (new)

### 0.3 Tag deprecated code for removal

Mark all deprecated items with a consistent comment format:

```
@deprecated Will be removed in v0.3.0 — <migration path>
```

**Files**: `state.ts:107`, `types.ts:21`, `metacognitive-state.ts:87,92`, `conflict-qa.ts:304`

### 0.4 Install the `eslint --fix` auto-fixes

Run `npm run lint:fix` and commit the 77 auto-fixable changes. This establishes a clean baseline.

---

## Phase 1: Complete Unfinished Features (4-5 days)

Goal: Every subsystem that exists should actually work end-to-end. No scaffolding without implementation.

### 1.1 Implement consolidation pipeline weight updates

**Problem**: `consolidation-channel.ts` (436 lines) is a queuing/scoring/scheduling system whose core value proposition — consolidating episodic memories into reusable patterns via weight updates — is explicitly unimplemented (line 6: "Weight update (LoRA/MEMIT) is not implemented"). The scheduler, scorer, queue, and archive scanner exist but produce nothing.

**Fix**: Since pi-braid runs inside pi and doesn't control model weights, the "weight update" path isn't directly feasible. Instead, implement *pattern extraction* — the consolidation pipeline should:

1. When an episode graduates from consolidation (status → "completed"), extract its SOP via the existing `sop-extractor.ts`
2. Store the extracted SOP as a consolidated hint in `~/.pi/agent/braid/consolidated-hints.jsonl` (the file already exists and is read by prompt-builder)
3. Delete the episode from the pending queue

This makes the pipeline fully functional: episode → score → queue → consolidate → extract SOP → store hint → agent benefits via prompt-builder injection. All the scaffolding (scoring, scheduling, archive scanning) now produces a real output.

**Files**:
- `src/lib/consolidation-channel.ts` — add `executeConsolidation()` that calls sop-extractor and writes hints
- `src/extensions/heartbeat/heartbeat-scheduler/index.ts` — wire consolidation tick to actually execute, not just queue

### 1.2 Connect the event bus to real consumers

**Problem**: `event-bus.ts` (198 lines) defines 9 typed events with full pub/sub but only 2 are ever emitted, and one (`enforcement_violation`) has a comment admitting it exists "to prevent the event from being logged into the void." The `context_full` event has one consumer in enforcement.

**Fix**: Wire the event bus as the actual inter-subsystem communication layer it was designed to be:

1. **Heartbeat → Event Bus**: Emit `heartbeat_tick` from the scheduler. Enforcement subscribes to count ticks for adaptive thresholds.
2. **Tool errors → Event Bus**: Emit `tool_error` from enforcement's tool result handler. Error-tracking extension subscribes to record errors for the `error_list`/`error_stats` tools.
3. **Memory eviction → Event Bus**: Emit `memory_evict` when three-memory-stores evicts old episodes. Context-lifecycle subscribes to adjust proposal thresholds.
4. **Analytics → Event Bus**: Emit `analytics_alert` from analytics extension. Watchdog subscribes for monitoring alerts.

This turns the event bus from dead code into the backbone of inter-module communication, replacing the current pattern of direct imports between modules that creates circular dependencies.

**Files**:
- `src/lib/event-bus.ts` — no changes needed (already complete)
- `src/extensions/heartbeat/heartbeat-scheduler/index.ts` — emit `heartbeat_tick`
- `src/extensions/enforcement/handler-registry.ts` — subscribe to `heartbeat_tick`, emit `tool_error`
- `src/extensions/error-tracking/index.ts` — subscribe to `tool_error`
- `src/extensions/memory/context-lifecycle/index.ts` — subscribe to `memory_evict`
- `src/extensions/heartbeat/analytics/index.ts` — subscribe to `analytics_alert`

### 1.3 Add conflict resolution UX to evidence pool

**Problem**: `evidence-pool.ts` (496 lines) + `conflict-qa.ts` (340 lines) = 836 lines for detecting semantic conflicts between sources, classifying them (direct/implication/reliability), and generating resolution questions. But there's no mechanism for the agent to *resolve* a conflict — questions are generated and whispered but never answered.

**Fix**: Add a resolution path:

1. When a conflict QA is generated, store its ID in enforcement state
2. On the next `message_end`, check if the agent's response addressed the conflict (keyword matching: "resolved", "conflict resolved", "the correct answer is")
3. If resolved, call `resolveQA()` to mark it complete and remove it from the unresolved pool
4. If unresolved after 5 turns, escalate severity in the whisper

This closes the loop: detect → question → agent response → resolve → remove. The entire 836-line infrastructure now produces an actual outcome.

**Files**:
- `src/extensions/enforcement/handler-registry.ts` — add resolution check in message_end handler
- `src/lib/conflict-qa.ts` — add `checkResponseForResolution()` function
- `src/lib/evidence-pool.ts` — add `markResolved()` function

### 1.4 Implement belief inference in the belief policy engine

**Problem**: `belief-policy-engine.ts` (478 lines) has an elaborate Belief type (key, confidence, evidence chain, timestamp) and a PolicyRecommendation pipeline, but beliefs are never inferred from signals. The `getNextRecommendation()` function only evaluates the 3 simple threshold rules directly against signal history — the belief store is write-only.

**Fix**: Add a belief inference step between signal emission and recommendation generation:

1. After each `emitSignal()`, run `inferBeliefs()` which checks if accumulated signals support a belief (e.g., 3+ stability-decline signals → belief "stability:declining" with confidence proportional to trend)
2. `getNextRecommendation()` queries beliefs (not raw signals) to generate recommendations
3. When a recommendation is acted upon (agent uses the suggested tool/approach), update belief confidence

This makes the Belief type actually meaningful — it's inferred from signals and used for recommendations. The 3 policy rules become belief-querying rules rather than signal-thresholding rules.

**Files**:
- `src/lib/belief-policy-engine.ts` — add `inferBeliefs()`, refactor `getNextRecommendation()` to query beliefs
- `src/extensions/enforcement/handler-registry.ts` — call `inferBeliefs()` after signal emission

### 1.5 Remove zombie deprecated code

The truly dead code — unreferenced, deprecated with no implementation path:

- `blockThinkBeforeEdit` flag in `state.ts:107` and `types.ts:21` — initialized to `false`, never read, never written. Config constant that does nothing.
- `metacognitive-state.ts:87,92` — no-op functions marked `@deprecated Storage removed — state is now ctx-scoped. No-op.` These are explicitly noted as having no function.
- `conflict-qa.ts:304` — alias `answerQA` pointing to `resolveQA`. Search for callers, remove alias if unused.

**Files**: `state.ts`, `types.ts`, `metacognitive-state.ts`, `conflict-qa.ts`

---

## Phase 2: Shrink the Memory Monolith (4-5 days)

Goal: Bring memory module from 8,484 lines to ~7,000 by extracting tool implementations into focused files and simplifying the context-lifecycle policy engine.

### 2.1 Extract context-manager tool implementations

`context-manager/handlers/tools.ts` is 731 lines — every context management tool's `execute` function is inlined. Each is self-contained and independently testable. Split into:

```
src/extensions/memory/context-manager/handlers/tools/
  context-tag.ts       (~80 lines)  — Create named save point
  context-log.ts       (~80 lines)  — View history entries
  context-checkout.ts  (~80 lines)  — Navigate to history point
  context-prune.ts     (~150 lines) — Analyze/remove stale entries
  context-audit.ts     (~100 lines) — Comprehensive health analysis
  context-snapshot.ts  (~60 lines)  — Quick health check
  context-compact.ts   (~80 lines)  — Remove obsolete entries
  context-archive.ts   (~80 lines)  — Compress messages to summary
```

Each file exports a single `execute` function. `tools.ts` becomes a thin registry that imports and registers each tool. Tests for individual tools become possible without loading the full context manager.

### 2.2 Improve compaction reliability

`compaction.ts` (607 lines) + `compaction-retry.ts` (387 lines) = 994 lines. The retry logic handles compaction failures with fallback strategies. Improve:

1. **Add compaction outcome tracking**: Record whether compaction succeeded or failed, and what fallback was used. Feed this into `advice-tracker.ts` to adjust retry strategy over sessions.
2. **Remove the cyclic dependency**: `compaction-retry.ts` imports `compaction.ts` via `await import("./rotation.js")` 5 times in one file. Extract the shared rotation utilities into `shared.ts` so both files can statically import what they need.
3. **Add compaction health metrics**: After each compaction, record `before/after token count` and `entries removed`. Expose via the analytics tools.

**Files**:
- `src/extensions/memory/context-manager/handlers/compaction.ts`
- `src/extensions/memory/context-manager/handlers/compaction-retry.ts`
- `src/extensions/memory/context-manager/handlers/shared.ts`
- `src/extensions/heartbeat/analytics/core.ts` — new metrics

### 2.3 Simplify the context-lifecycle policy engine (keep the loop)

`policy-engine.ts` (324 lines) and `signal-detector.ts` (325 lines) implement an R-CCAM loop (Retrieval → Cognition → Control → Action → Memory). The concept is sound — auto-detect when context needs compaction and propose it. The implementation is overbuilt with a full PolicyEngine class, SignalDetector class, and a 490-line types file.

**Keep the loop, simplify the implementation**:

1. `PolicyEngine` class → pure function `evaluatePolicy(ctx, signals) → EvaluatedAction[]`
2. `SignalDetector` class → pure function `detectSignals(entries, state) → Signal[]`
3. The types file (490 lines) shrinks to ~150 lines by removing the proposal state machine types that track every lifecycle stage — these are only used for logging, not decision-making.

The R-CCAM concept stays. The class-based architecture becomes functional. The value (auto-proposing compaction) remains.

**Files**:
- `src/extensions/memory/context-lifecycle/policy-engine.ts`
- `src/extensions/memory/context-lifecycle/signal-detector.ts`
- `src/extensions/memory/context-lifecycle/types.ts`

### 2.4 Improve SOP suggestion relevance

`sop-suggestion.ts` (452 lines) extracts keywords from user messages using stopword filtering and matches against stored SOPs with Jaccard similarity. The config (`SopSuggestionConfig` with 8 fields) is over-parameterized — most fields use defaults and are never configured.

**Improve**:

1. Replace the keyword extraction (stopword filtering + word splitting) with the utility model classifier already used by sycophancy-detector. Extract task keywords with a simple classification prompt.
2. Remove the config object — hardcode the sensible defaults (`maxSuggestionsPerTurn: 1`, `minSimilarity: 0.3`, `maxTotalTokens: 800`) as constants. If someone needs configurability later, extract it then.
3. Add feedback: After injecting an SOP suggestion, track whether the agent followed it (tool call pattern matching). Feed success rate back into similarity scoring.

**Files**: `src/lib/sop-suggestion.ts`

### 2.5 Rename heartbeat/dreamer to prevent collision

Two separate systems share the name "dreamer":
- `src/lib/dreamer.ts` — Markov-chain tool sequence predictor (predicts stuck/failure paths)
- `src/extensions/heartbeat/heartbeat-scheduler/modules/dreamer.ts` — Periodic pattern consolidation module

Rename the heartbeat module to `reflection-consolidator.ts` or `pattern-analyzer.ts`. The lib/dreamer keeps its name (it's the original dreamer concept). The heartbeat module gets a name that reflects what it actually does.

**Files**: 3 files updated (the module file itself, heartbeat-scheduler/index.ts import, modules/definitions.ts comment)

---

## Phase 3: Break the Enforcement God Object (5-6 days)

Goal: Split `handler-registry.ts` from 787 lines of monolithic event registration into independently testable, properly typed handlers with static imports.

### 3.1 Type the event objects

Before splitting, define proper TypeScript interfaces for each pi event shape. The biggest problem in handler-registry is `event: any` and `ctx: any` everywhere.

**File**: `src/extensions/enforcement/event-types.ts` (new, ~100 lines)

```typescript
interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}
interface MessageEndEvent {
  message: {
    role: "user" | "assistant" | "system";
    content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
  };
}
interface TextBlock { type: "text"; text: string; }
interface ThinkingBlock { type: "thinking"; thinking: string; }
interface ToolCallBlock { type: "toolCall"; name: string; input: Record<string, unknown>; }
interface SessionStartEvent {
  task?: string;
  prompt?: string;
}
interface ToolResultEvent {
  toolName?: string;
  error?: string;
}
interface SessionCompactEvent {}
interface AutoRetryEndEvent {
  success: boolean;
  attempt: number;
  finalError?: string;
}
interface SessionShutdownEvent {}
```

### 3.2 Extract individual handler registration functions

Current state: `registerHandlers()` is one 700-line function that registers everything inline.

Target state: Each handler is a self-contained module:

```
src/extensions/enforcement/handlers/
  register-input-handler.ts       — Language detection (~40 lines, from handler-registry:106-120)
  register-session-start.ts       — Block check, event bus wiring, drift init (~50 lines, from :122-156)
  register-tool-call.ts           — Tracking + blocking (~80 lines, from :158-224)
  register-message-end.ts         — Conflict + analysis + judge (~140 lines, from :226-353)
  register-tool-result.ts         — Calibration (~70 lines, from :356-410)
  register-turn-end.ts            — Coordinator registration (~50 lines, from :412-498)
  register-session-compact.ts     — Hygiene reset (~60 lines, from :503-558)
  register-auto-retry-end.ts      — Error classification (~40 lines, from :561-591)
  register-session-shutdown.ts    — State reset (~30 lines, from :743-756)
  dispatch-turn-end-analysis.ts   — Drift + BPE + MARS + dreamer + reflection (~150 lines, from :595-730)
```

Each file exports a single function like `registerToolCallHandler(pi: ExtensionAPI, nudgeManager: NudgeManager): void`. The `handler-registry.ts` becomes a thin orchestrator (~60 lines) that imports and calls each.

### 3.3 Replace dynamic imports with static imports

17 `await import()` calls in handler-registry are cross-module injections to break circular dependencies. After extracting handlers into focused files, each handler only depends on the lib modules it uses:

| Handler | Static imports needed |
|---------|----------------------|
| register-input-handler | `language-hint.ts`, `bidirectional-verifier.ts` |
| register-tool-call | `handlers/blocking.ts`, `handlers/tool-tracker.ts`, `bidirectional-verifier.ts` |
| register-message-end | `handlers/message-analysis.ts`, `evidence-pool.ts`, `conflict-qa.ts`, `verification-judge.ts` |
| register-tool-result | `evidence-pool.ts`, `belief-policy-engine.ts` |
| register-turn-end | `turn-end-coordinator.ts`, `mars-reflector.ts`, `dreamer.ts`, `claim-tracker.ts`, `belief-policy-engine.ts`, `advice-tracker.ts` |
| register-session-compact | (no lib imports needed) |
| register-auto-retry-end | (classification inline) |
| register-session-shutdown | (state reset only) |

Each handler has 2-5 static imports instead of 15-20 lazy imports. The circular dependency is broken by the file split — enforcement handlers no longer import anything from memory/heartbeat modules.

### 3.4 Convert dispatchTurnEndAnalysis to coordinator handlers

The 135-line `dispatchTurnEndAnalysis` function interleaves 6 concerns. After extraction, each becomes a turn_end coordinator handler with explicit priority:

```typescript
// In register-turn-end.ts:
registerTurnEndHandler("enforcement-drift", 100, driftDetectionHandler);
registerTurnEndHandler("enforcement-bpe", 90, bpePolicyHandler);
registerTurnEndHandler("enforcement-mars", 80, marsAdviceHandler);
registerTurnEndHandler("enforcement-dreamer", 70, dreamerPredictionHandler);
registerTurnEndHandler("enforcement-reflection", 60, reflectionGapHandler);
registerTurnEndHandler("enforcement-feedback", 50, adviceFeedbackHandler);
```

Each handler is independently testable. The coordinator already supports priority ordering and error isolation. The `_lastRecommendationType` module-level variable becomes state tracked in `EnforcementState`.

### 3.5 Fix the `blockThinkBeforeEdit` case

While extracting, fix the deprecated flag: it's initialized to `false` and never read. Either implement the blocking logic (if think was called without tools since last reflection, reject edits) or remove the flag entirely. If implementing, add it to `register-tool-call.ts`:

```typescript
if (toolName === "edit" || toolName === "write") {
  if (getState(ctx).blockThinkBeforeEdit && getState(ctx).toolsSinceReflection > 5) {
    return { block: true, reason: "Call think(type='reflection') before editing." };
  }
}
```

---

## Phase 4: Type Safety & Cross-Cutting Quality (3-4 days)

Goal: Eliminate `any` types, fix stale context patterns, improve error handling.

### 4.1 Replace remaining `any` casts

After Phase 3 types the event objects, tackle the remaining 32 `any`/`unknown` casts:

**High-priority**:
- `nudge-manager.ts` — `_now` parameter pattern (replace with direct `Date.now()` calls)
- `context-manager/handlers/tools.ts` — all `params: any`, `ctx: any` signatures (use TypeBox-inferred types)
- `memory-agent-bridge/index.ts` — explore_paths tool parameters, `execFileAsync` return type
- `session-recall/index.ts` — session query result types

**Medium-priority**:
- `contrib/` modules — tool parameter types (already have TypeBox schemas, use them)
- `whisper.ts` — message format types
- `extension-state.ts` — session manager getter types

**Target**: Reduce from 54 to under 10 `any`/`unknown` casts. The remaining ones are at pi API boundaries where the SDK types are incomplete.

### 4.2 Fix the stale context pattern

`safeSessionManager()` wraps every session access in try/catch because contexts can go stale. This is a symptom of unclear context lifecycle:

**Fix**: Scope session access to `session_start` handlers where the context is guaranteed fresh. For handlers that need session data mid-turn (drift detection, claim tracking), cache session state at session_start and use the cached copy. The `session_compact` handler already has a comment acknowledging this problem: `"session_compact handler: enforcement state access failed (stale ctx?)"`.

**Files**:
- `src/lib/extension-state.ts` — add `cacheSessionState()` and `getCachedSessionState()`
- `src/extensions/enforcement/handler-registry.ts` — cache at session_start, use cache in turn_end handlers

### 4.3 Fix the hardcoded version

In `src/index.ts:63-68`:

```typescript
// Before:
function getVersion(): string {
  try { return "0.2.5"; }
  catch { return "dev"; }
}

// After:
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}
```

The try/catch now actually catches something (missing file, parse error) instead of being a no-op wrapper.

### 4.4 Improve error handling consistency

The codebase uses three different error handling patterns inconsistently:
1. `try { ... } catch (err) { log.error(...) }` — used in 80% of handlers
2. `try { ... } catch { /* Non-fatal */ }` — empty catch blocks with comments
3. No try/catch at all — handlers that assume success

Standardize on pattern 1 with a helper:

```typescript
// src/lib/error-guard.ts (new, ~20 lines)
export async function guard<T>(
  label: string,
  fn: () => Promise<T>,
  log: Logger,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log.error(`${label}: ${(err as Error).message}`);
    return undefined;
  }
}
```

Replace empty catch blocks with `guard()` calls that at least log the error. The "Non-fatal" comments are preserved as the label parameter.

### 4.5 Run full eslint pass

After all phases complete, run `npm run lint` and fix remaining warnings. Expected: 0 errors, 0 warnings. The 77 auto-fixable issues from Phase 0.4 are already resolved. The remaining 65 are `any`-type warnings addressed in Phase 4.1.

---

## Phase Summary

| Phase | Days | Key Outcome |
|-------|------|-------------|
| 0: Safety | 1 | Integration tests + dependency map + clean lint baseline |
| 1: Complete Features | 4-5 | Consolidation pipeline works end-to-end; event bus is backbone; conflict resolution closes the loop; belief engine infers from signals; zombie code removed |
| 2: Memory Split | 4-5 | Tools extracted into focused files; compaction improved; policy engine simplified; dreamer renamed |
| 3: Enforcement Split | 5-6 | God object becomes 10 focused handlers; `any` is typed; dynamic imports become static; turn_end uses coordinator properly |
| 4: Quality | 3-4 | `any` casts reduced to <10; stale context fixed; hardcoded version reads package.json; error handling standardized; eslint clean |
| **Total** | **17-21 days** | |

### Files most affected

| File | Before | After | Change |
|------|--------|-------|--------|
| `handler-registry.ts` | 787 lines | ~60 lines | Becomes thin orchestrator |
| `dispatch-turn-end-analysis.ts` | (inline) | ~150 lines | Extracted handler, coordinator-registered |
| `register-message-end.ts` | (inline) | ~140 lines | Extracted handler, static imports |
| `tools.ts` (context-manager) | 731 lines | ~80 lines | Thin registry, 8 tool files extracted |
| `policy-engine.ts` | 324 lines | ~180 lines | Class → pure functions |
| `signal-detector.ts` | 325 lines | ~150 lines | Class → pure functions |
| `types.ts` (context-lifecycle) | 490 lines | ~150 lines | Removed proposal state machine |
| `consolidation-channel.ts` | 436 lines | ~500 lines | Added executeConsolidation() |
| `sop-suggestion.ts` | 452 lines | ~250 lines | Simplified config, added feedback loop |
| `event-bus.ts` | 198 lines | ~200 lines | Now actually connected to consumers |

### Risk by phase

| Phase | Risk | Mitigation |
|-------|------|------------|
| 0 | None | Never touches production code |
| 1 | Low | Adds features to existing scaffolding; doesn't change working behavior |
| 2 | Medium | Tool extraction is mechanical; compaction changes are additive |
| 3 | **High** | God object split. Mitigated by Phase 0 integration tests. Split one handler at a time, test after each. |
| 4 | Low | Type changes; stale context fix is mechanical; error handling is additive |

### Execution order is non-negotiable

1. **Phase 0 must complete first** — integration tests are the safety net for Phase 3
2. **Phase 1 must complete before Phase 3** — event bus wiring and belief inference change how handlers communicate
3. **Phase 2 can run in parallel with Phase 1** — memory module and lib subsystems are independent
4. **Phase 3 must follow Phase 1+2** — it depends on event bus wiring and type definitions from both
5. **Phase 4 must come last** — it touches everything and needs the stable target from previous phases