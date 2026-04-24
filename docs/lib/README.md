# Library Reference

23 library files in `src/lib/`. All provide shared infrastructure used by extensions.

## Core Infrastructure

| File | Purpose | Used By |
|------|---------|---------|
| `extension-state.ts` | Session-scoped state factory via `getExtensionState(ctx, key, factory)` | All extensions with state |
| `logger.ts` | Structured logging with category prefixes | All extensions |

## Cognitive/Memory

| File | Purpose | Used By |
|------|---------|---------|
| `belief-store.ts` | Belief state tracking with anchors | enforcement, topic-drift |
| `cognitive-memory.ts` | Cognitive memory operations | cognitive-systems, metacognition |
| `metacognitive-state.ts` | Metacognitive state tracking | metacognition |
| `goal-manager.ts` | Goal state management | planner |
| `planner.ts` | Goal management helpers | planner |

## Evidence & Conflict

| File | Purpose | Used By |
|------|---------|---------|
| `evidence-pool.ts` | Evidence tracking + conflict detection | enforcement |
| `conflict-qa.ts` | Conflict QA + resolution questions | enforcement |

## Enforcement/Signals

| File | Purpose | Used By |
|------|---------|---------|
| `belief-policy-engine.ts` | Belief policy + structured signal emission | enforcement |
| `mars-reflector.ts` | Multi-anchor reflection signals (MARS) | enforcement |
| `error-classifier.ts` | Error classification + retry logic | enforcement, error-capture |
| `topic-drift-detector.ts` | Topic drift detection | topic-drift |
| `reasoning-metrics.ts` | Reasoning metrics tracking | reasoning |
| `degradation-detector.ts` | Degradation detection | evolve |

## Utilities

| File | Purpose | Used By |
|------|---------|---------|
| `extension-utils.ts` | Extension helpers | context-lifecycle |
| `session-manager.ts` | Session management | agent-environment |
| `timer-bus.ts` | Timer event bus | timer |
| `async-storage.ts` | Async storage | general |
| `model-resolver.ts` | Model resolution | prompt-builder |
| `file-mutation-queue.ts` | File mutation queue | general |
| `global-state.ts` | Global state | general |
| `language-hint.ts` | Language hints for multilingual agents | enforcement |
| `path-utils.ts` | Path normalization | general |
| `polyfill.ts` | Type compatibility | general |
