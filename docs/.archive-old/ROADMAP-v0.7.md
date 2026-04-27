# pi-braid Roadmap — v0.7

**Date**: 2026-04-20
**Build**: 0 errors | 29 extensions | ~25,318 lines | 136 runtime tests pass

## What's Done (v0.6)

| Phase | Items | Status |
|-------|-------|--------|
| Phase 1 | Session isolation, context-manager decomposition, enforcement migration | ✅ |
| Phase 2 | Heartbeat scheduler, three memory stores, belief+policy | ✅ |
| Phase 3 | Evidence pool, conflict QA, MARS, measurement | ✅ |
| Refactor | Enforcement decomposition (1350→880 lines), test infrastructure | ✅ |
| RUMS | Mutual information memory selection (2604.14473) | ✅ |

## v0.7 — Planned Work

### High Priority

#### 1. End-to-End Benchmark
Run agent on known complex tasks, measure:
- Success rate (task completion)
- Tool call efficiency (fewer calls = better)
- Context usage (pruning frequency, overflow events)
- Degradation onset (when does agent start making mistakes?)
- RUMS impact (compare with/without mutual information selection)

**Effort**: 1-2 days
**Risk**: Low — adds measurement infrastructure

#### 2. Meta-Cognition Decomposition
`metacognition/index.ts` is 760 lines. Extract tool factories:
```
handlers/
  hypothesis-scorer.ts    ← DONE
  think-tool.ts           ← partially done (extracted)
  hypothesize-tool.ts     ← TODO
  finalize-tool.ts        ← TODO
```
Migrate `_planner` + `_goalManager` to `getPlannerState(ctx)`.

**Effort**: 2-3 days
**Risk**: Medium — changes event handler signatures

#### 3. Stricter Type Coverage
Resolve `as any` casts in enforcement event handlers.
Most are for untyped pi custom events — acceptable.
Focus on tool params where proper types exist.

**Effort**: 1 day
**Risk**: Low — add type definitions

### Medium Priority

#### 4. RUMS Benchmark
Compare RUMS vs similarity search on memory retrieval quality.
Run parallel sessions with both approaches, measure task success.

**Effort**: 1-2 days
**Risk**: Low — experimental flag

#### 5. Hyperagents Integration
The `hyperagents-evolution` skill exists but isn't wired in.
After each session: run evolution cycle, archive best performers.

**Effort**: 2-3 days
**Risk**: Medium — needs careful tuning

#### 6. Session Isolation Testing
Verify that parallel sessions truly don't share state.
Run concurrent sessions, check for cross-contamination.

**Effort**: 1 day
**Risk**: Low — automated test

### Lower Priority

#### 7. Prompt Evolution
Use the enforcement feedback to evolve the system prompt.
Track nudge patterns, adjust prompt based on failure modes.

**Effort**: 2 days
**Risk**: Medium — prompt changes affect everything

#### 8. Documentation
- Architecture diagrams (mermaid)
- Contributing guide
- Extension authoring tutorial
- Paper summaries for each Phase 2/3 component

**Effort**: 1-2 days
**Risk**: None

## Current Architecture

```
pi-braid extensions (29)
├── enforcement/          880 lines   ← decomposed to handlers/
│   └── handlers/
│       ├── message-analysis.ts
│       ├── turn-analysis.ts
│       ├── orphan-chains.ts
│       ├── tool-tracker.ts
│       ├── probe-handler.ts
│       ├── routing-handler.ts
│       └── blocking.ts
├── heartbeat-scheduler/ 340 lines   ← proactive cognitive scheduling
├── three-memory-stores/ 580 lines   ← RUMS retrieval
│   ├── Episodic memory
│   ├── Heuristics (evolving rules)
│   └── Tool reliability
├── cognitive-systems/    ← evidence pool, conflict QA
├── context-manager/     ← decomposition target
├── metacognition/       ← decomposition target
└── ... (22 more)

Shared libs (19)
├── evidence-pool.ts       ← conflict detection
├── conflict-qa.ts       ← resolution questions
├── error-classifier.ts   ← retry logic
├── extension-state.ts    ← session isolation
├── extension-utils.ts    ← shared helpers
├── mars-reflector.ts    ← MARS advice
├── reasoning-metrics.ts ← stability measurement
└── degradation-detector.ts ← degradation detection
```

## Test Infrastructure

```
test/runtime/
├── test-error-classifier.mjs    19 tests
├── test-conflict-qa.mjs         12 tests
├── test-evidence-pool.mjs       14 tests
├── test-heartbeat.mjs            26 tests
├── test-integration.mjs          26 tests
├── test-memory-stores.mjs         21 tests
└── test-reasoning-metrics.mjs    18 tests

136 tests, 0 failures
```
