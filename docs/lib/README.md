# lib docs — pi-braid Library Reference

Coverage: **22/23 lib files documented** (21 individual + 1 overview)

## Core Infrastructure

| Doc                                       | File                          | Lines | Purpose                                           |
| ----------------------------------------- | ----------------------------- | ----- | ------------------------------------------------- |
| [evidence-pool](./evidence-pool.md)       | `src/lib/evidence-pool.ts`    | 275+  | Structured evidence tracking + conflict detection |
| [conflict-qa](./conflict-qa.md)           | `src/lib/conflict-qa.ts`      | 100+  | Evidence conflict resolution                      |
| [extension-state](./extension-state.md)   | `src/lib/extension-state.ts`  | 70+   | Session-scoped state factory                      |
| [model-resolver](./model-resolver.md)     | `src/lib/model-resolver.ts`   | 80+   | Model resolution (utility, vision)                |
| [error-classifier](./error-classifier.md) | `src/lib/error-classifier.ts` | 150+  | Structured error classification                   |

## Metacognition & Reasoning

| Doc                                               | File                              | Lines | Purpose                                |
| ------------------------------------------------- | --------------------------------- | ----- | -------------------------------------- |
| [mars-reflector](./mars-reflector.md)             | `src/lib/mars-reflector.ts`       | 100+  | Self-reflection tool pattern analysis  |
| [belief-policy-engine](./belief-policy-engine.md) | `src/lib/belief-policy-engine.ts` | 300+  | Signal policy engine + recommendations |
| [reasoning-metrics](./reasoning-metrics.md)       | `src/lib/reasoning-metrics.ts`    | 60+   | Reasoning quality metrics              |
| [metacognitive-state](./metacognitive-state.md)   | `src/lib/metacognitive-state.ts`  | 70+   | Confidence + knowledge gap tracking    |
| [cognition-evaluator](./cognition-evaluator.md)   | `src/lib/cognition-evaluator.ts`  | —     | Heuristic evaluation (bundled)         |

## Memory & Storage

| Doc                                             | File                             | Lines | Purpose                                   |
| ----------------------------------------------- | -------------------------------- | ----- | ----------------------------------------- |
| [cognitive-memory](./cognitive-memory.md)       | `src/lib/cognitive-memory.ts`    | 150+  | Unified memory (8 types, utility scoring) |
| [belief-store](./belief-store.md)               | `src/lib/belief-store.ts`        | 40+   | Cross-session belief persistence          |
| [async-storage](./async-storage.md)             | `src/lib/async-storage.ts`       | 60+   | Safe async JSON/JSONL I/O                 |
| [file-mutation-queue](./file-mutation-queue.md) | `src/lib/file-mutation-queue.ts` | 50+   | Atomic write queue                        |

## Detection & Monitoring

| Doc                                               | File                              | Lines | Purpose                               |
| ------------------------------------------------- | --------------------------------- | ----- | ------------------------------------- |
| [degradation-detector](./degradation-detector.md) | `src/lib/degradation-detector.ts` | 80+   | Cross-session performance degradation |
| [topic-drift-detector](./topic-drift-detector.md) | `src/lib/topic-drift-detector.ts` | 50+   | Conversation drift detection          |

## Planning

| Doc                     | File                 | Lines | Purpose                   |
| ----------------------- | -------------------- | ----- | ------------------------- |
| [planner](./planner.md) | `src/lib/planner.ts` | 200+  | Plan-Execute-Review cycle |

## Utilities

| Doc                                     | File                         | Lines | Purpose                        |
| --------------------------------------- | ---------------------------- | ----- | ------------------------------ |
| [global-state](./global-state.md)       | `src/lib/global-state.ts`    | 15+   | Process-global state singleton |
| [logger](./logger.md)                   | `src/lib/logger.ts`          | 30+   | Structured logging             |
| [language-hint](./language-hint.md)     | `src/lib/language-hint.ts`   | 100+  | English language detection     |
| [session-manager](./session-manager.md) | `src/lib/session-manager.ts` | 60+   | Session lifecycle management   |
| [timer-bus](./timer-bus.md)             | `src/lib/timer-bus.ts`       | 50+   | Non-blocking timer event bus   |

## Not Documented

- `src/lib/extension-utils.ts` — generic extension helpers (self-documenting)
