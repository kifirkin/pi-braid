<!-- status: forward-looking -->

# Research: Integration Testing Gap — When Unit Tests Pass but Production Breaks

**Date:** 2026-07-02
**Source:** Deep session reflection across 60+ pi-braid session files
**Status:** Research proposal

## Executive Summary

During a deep investigation of all past pi-braid sessions, a recurring pattern emerged: **unit tests pass while production code is broken.** The most concrete example is the tool-loop-detector, which had 18 passing subtests but was silently dead code in production for weeks. This document analyzes that case and three others to identify the systemic testing gap.

## 1. The Tool-Loop-Detector Case (Canary)

### What happened

The tool-loop-detector in `src/lib/detection/tool-loop-detector.ts` had a critical bug: `recordTurnEnd()` incremented `state.turnCount` but **never created a new `perTurn` entry**. Since `detectToolLoop()` required `perTurn.length >= 2` to run, it always returned `{isLoop: false}` in production.

**The detector was dead code for weeks** despite having 18 passing subtests.

### Why the tests passed

The unit test `test-tool-loop-detector.mjs` did not call the production path:

```
Production: registerToolCall() → recordTurnEnd() → detectToolLoop()
Test:       detectToolLoop() with pre-built state (bypasses recordTurnEnd)
```

The test constructed synthetic `ToolLoopState` objects and passed them directly to `detectToolLoop()`. Since `recordTurnEnd()` was never called in the test, the bug was invisible.

### Root cause pattern

**Integration-path testing gap**: Event handlers → state mutations → detector logic were never tested end-to-end. Only the detector logic was unit-tested in isolation.

## 2. Three Other Cases of the Same Pattern

### 2a. EventBus listener accumulation

**Production path:** module load → `eventBus.on("context_full", handler)` → handler fires N times after N reloads

**Tests:** Each test file loads the module once and runs one session. The accumulation only manifests after 2+ reloads in the same `pi` process — something no test does.

**Detected:** Live session (user complaint: whisper flood after reload). Fixed by storing listeners in module-level `const` containers.

### 2b. State baseline drift

**Production path:** new fields added to `EnforcementState` → baseline `65` should be `70` → structural test passes anyway

**Tests:** Test asserts `Object.keys(state).length === 65`. But if new keys are added without updating the test, the test passes because it's checking a stale constant. No automated reconciliation.

**Detected:** Manual audit during deep session investigation. Fixed by updating baseline to 70.

### 2c. Module-level state leakage across `/reload`

**Production path:** session 1 sets `enforcementSignals["some_flag"] = true` → `/reload` → session 2 reads stale flag → incorrect behavior mode

**Tests:** Each test runs in its own process. Module-level state is fresh. The leakage only manifests across reloads in the same process — something no test simulates.

**Detected:** Live session (incorrect behavior mode after reload). Fixed by clearing signals on `session_start`.

## 3. The Systemic Gap

All four cases share the same structure:

| Case | Production path | Test path | Gap |
|---|---|---|---|
| Tool-loop-detector | event → state → detect | detect(state) | Event handlers bypassed |
| Listener accumulation | 2+ reloads in one process | 1 load per test | Multi-reload untested |
| Baseline drift | State grows over time | Stale constant | No reconciliation |
| State leakage | 2+ sessions in one process | 1 session per test | Cross-session untested |

**Root cause:** The test suite assumes:
1. Event handlers are correct (they aren't tested)
2. Module state is fresh (it isn't in production)
3. Baselines are maintained manually (they rot)

## 4. Recommended Research

### 4a. Integration harness for enforcement handlers

Build a test harness that runs the full production path:

```ts
// Pseudocode
const harness = new EnforcementHarness(pi);
harness.simulateToolCall("bash", ["ls"]);
harness.simulateTurnEnd();
const result = harness.detectToolLoop();
assert(result.isLoop === expected);
```

This exercises `registerToolCall()` → `recordTurnEnd()` → `detectToolLoop()` exactly as production does.

### 4b. Multi-reload test fixture

Add a test fixture that simulates consecutive `/reload`:

```ts
// Pseudocode
await reloadSession(ctx);
await reloadSession(ctx);
assert(eventBus.listenerCount("context_full") === 1);
```

### 4c. Automated baseline derivation

Replace hardcoded baseline constants with runtime derivation:

```ts
// Instead of:
const BASELINE_COUNT = 65;
assert(Object.keys(state).length === BASELINE_COUNT);

// Derive from source of truth:
const BASELINE_COUNT = countExpectedKeys(stateModules);
// Where countExpectedKeys() sums documented keys from each sub-module
```

### 4d. Cross-session test mode

Add a test mode that preserves module-level state between test cases:

```ts
// Instead of fresh module per test:
describe("cross-session", () => {
  beforeAll(() => loadModules());  // load once
  test("session 1 sets flag", () => { ... });
  test("session 2 reads stale flag", () => { ... });  // catches leakage
});
```

## 5. Effort Estimate

| Item | Effort | Impact |
|---|---|---|
| Enforcement harness | 2–3 days | Catches all future tool-loop-detector class bugs |
| Multi-reload fixture | 1 day | Catches listener accumulation before deployment |
| Automated baseline | 0.5 day | Prevents silent baseline drift |
| Cross-session test mode | 1 day | Catches module-level state leakage |

**Total:** ~5–6 days for a 4x reduction in "tested but broken" risk.

## 6. Relationship to existing work

This does not replace existing unit tests — it adds a layer above them. The ROADMAP (§3) documents the tool-loop-detector fix (DR-H-1) but does not propose the integration harness. This proposal fills that gap.

The FRAGILE-HEURISTICS-INVENTORY covers heuristic fragility. This proposal covers *testing* fragility — a distinct category.

## 7. Next steps

1. Build the enforcement harness for the tool-loop-detector path
2. Add multi-reload fixture to the event-bus test suite
3. Derive the state-composition baseline from source modules
4. If all three succeed, generalize the patterns to a cross-session test utility