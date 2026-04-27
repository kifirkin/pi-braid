# pi-braid Roadmap — v0.9

**Date**: 2026-04-20
**Build**: 0 errors | 29 extensions | 20 libs | ~25,291 lines | 205 runtime tests pass

## What's Done (v0.8)

| Item | Status | Details |
|------|--------|---------|
| Metacognition decomposition | ✅ | 760L → 145L index + 4 handlers |
| Cognition evaluator | ✅ | 3-dimension scoring + recommendations |
| Hyperagents evolver | ✅ | Heartbeat module #5, heuristic evolution |
| Benchmark framework | ✅ | 5-task suite, provider-agnostic |
| RUMS memory selection | ✅ | Mutual information retrieval |
| Pre-commit hook | ✅ | 10/10 suites verified |
| Enforcement decomposition | ✅ | 1350→880 lines |
| Error classifier wired | ✅ | retry.ts + enforcement |

## v0.9 — Planned Work

### High Priority

#### 1. Context-Manager Decomposition (SKIPPED in v0.8)
**Why skipped**: 15+ event handlers sharing `getCmState`, `compactionRetryState`, and inter-dependent state. Already partially decomposed (analysis.ts, pruning.ts, retry.ts extracted). Further decomposition would create a web of imports.

**Revisit when**: pi SDK provides better event handler composition, or when the extension needs significant new features.

#### 2. Live Benchmark
Run agent on 5 known tasks, measure success rate, tool efficiency, context usage.
Framework built (`scripts/benchmark.py`), needs working provider.

**Blocked on**: provider availability (a0-venice not responding)

#### 3. Merge cleanup/refactor → main
All work is on `cleanup/refactor` branch. Need to merge to `main` and tag.

**Effort**: 30 minutes
**Risk**: Low — all tests pass

### Medium Priority

#### 4. Prompt Evolution
Use enforcement feedback to evolve the system prompt.
Track nudge patterns, adjust prompt based on failure modes.

#### 5. Session Isolation Testing
Verify parallel sessions don't share state.
Run concurrent sessions, check for cross-contamination.

#### 6. Documentation
- Architecture diagrams (mermaid)
- Contributing guide
- Extension authoring tutorial

## Architecture Overview

```
pi-braid (29 extensions, 20 libs, 25,291 lines)
├── Core extensions
│   ├── metacognition/    145L index + 4 handlers (think, hypothesize, finalize, scoring)
│   ├── enforcement/       880L index + 5 handlers
│   ├── context-manager/  1141L index + 3 modules (analysis, pruning, retry)
│   └── assistant/        tool state management
├── Cognitive systems
│   ├── heartbeat-scheduler/ 5 modules (recaller[RUMS], dreamer, contextHygiene, measurement, evolver)
│   ├── three-memory-stores/  RUMS retrieval + episodic/heuristic/tool-reliability
│   ├── cognitive-systems/    evidence pool + conflict QA
│   └── context-lifecycle/    session lifecycle management
├── Shared libs (20)
│   ├── evidence-pool.ts       conflict detection
│   ├── conflict-qa.ts         resolution questions
│   ├── error-classifier.ts    retry logic
│   ├── cognition-evaluator.ts 3-dimension scoring
│   ├── extension-state.ts     session isolation
│   ├── extension-utils.ts     shared helpers
│   ├── mars-reflector.ts      MARS advice
│   ├── reasoning-metrics.ts   stability measurement
│   └── degradation-detector.ts degradation detection
└── Test infrastructure (10 suites, 205 tests)
    ├── cognition-evaluator     11 tests
    ├── conflict-qa             12 tests
    ├── error-classifier        19 tests
    ├── evidence-pool           15 tests
    ├── finalize-bcr            14 tests
    ├── heartbeat               26 tests
    ├── integration             44 tests
    ├── memory-stores           29 tests
    ├── metacognition-handlers  17 tests
    └── reasoning-metrics       18 tests
```
