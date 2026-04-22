# BRAID-NEXT — Research & Development Proposal
**Date**: 2026-04-22  
**Agent**: Braid (Kimi K2.6)  
**Status**: Session 12 complete, ready for next phase

---

## Executive Summary

This proposal maps the remaining work across four tracks: **Archive Recovery** (D0-D5), **System Improvements** (R5-R9, H5-H7), **Behavior Research** (BR1-BR4), and **Benchmarking** (BM1-BM3). Each item has priority, effort, dependencies, and status.

---

## Track 0: Archive Recovery

### D0 — Daemon Orchestrator (Belief Store + Policy Engine)
**Status**: 🟡 PARTIAL (~50% done)
**Files**:
- `src/extensions/heartbeat-scheduler/` — ✅ **DONE** (4 modules: recaller, heuristic, reasoner, critic)
- `src/extensions/cognitive-systems/` — ✅ **DONE** (explore_paths, semantic memory, conflict QA)
- `docs/archive/daemon-orchestrator/` — ❌ archived, needs unarchiving
**Papers**: [2604.14178](https://arxiv.org/abs/2604.14178) Heartbeat Scheduling, [2604.14401](https://arxiv.org/abs/2604.14401) Credo

**What exists**: Heartbeat-scheduler (tick interval 20 turns, module registry, effectiveness tracking), cognitive-systems (parallel hypothesis exploration, semantic memory, conflict QA).

**MISSING**: Belief store (id, content, confidence, timestamp, source), policy engine (trigger → action rules), dreamer module, policy registry, meta-learning optimizer for tick interval, unarchiving daemon docs.

**Implementation**:
```
Phase 1: Unarchive daemon docs (5 min)
Phase 2: Implement belief store in lib/belief-store.ts (1 hour)
Phase 3: Add policy engine to heartbeat-scheduler (2 hours)
Phase 4: Implement dreamer module (1 hour)
Phase 5: Meta-learning: optimizer adjusts tick interval from activation history (2 hours)
```

**Effort**: MEDIUM (6 hours total, ~50% done)  
**Priority**: 🔴 HIGH

---

### D1 — Session Isolation
**Status**: 🔴 PARTIALLY FIXED (module-level mutable state remains)
**File**: `docs/archive/ROADMAP-v1.0-FULL.md` lines 500-620
**Paper**: [2604.14717](https://arxiv.org/abs/2604.14717) Layered Mutability

**Already fixed**: Global state DRY (H4), scratchpad uses `ctx.cwd`.  
**NOT fixed**: Enforcement state singletons, cognitive-memory uses `process.cwd()`, no `session_end` cleanup handler.

**Effort**: MEDIUM (3-4 hours)  
**Priority**: 🔴 HIGH

---

### D2 — Async Migration
**Status**: 🟡 PARTIAL (~70% done)
**NOT done**: user-message-preprocessor (sync settings), prompt-guardian (sync prompts), repl extension (sync read/write).

**Effort**: MEDIUM (2 hours)  
**Priority**: 🟡 MEDIUM

---

### D5 — Evidence Pool
**Status**: 🟡 PARTIAL (exists but not source-labeled)
**Paper**: [2604.14170](https://arxiv.org/abs/2604.14170)

**NOT done**: Source labels on all evidence, faithful conflict handling (acknowledge not suppress), XoT two-stage reasoning.

**Effort**: MEDIUM (2-3 hours)  
**Priority**: 🟡 MEDIUM

---

## Track 1: System Improvements

### R5 — Three-Memory Integration into Agent Loop
**Status**: Extension exists but NOT wired into agent decision loop
**File**: `src/extensions/three-memory-stores/index.ts`

**What's missing**: No recall trigger before `think` execution, no memory injection into system prompt, no cross-session cascade.

**Implementation**:
1. Hook into prompt-builder: query semantic memory → inject as "## Past Insights"
2. Hook into metacognition/think: query episodic memory before reasoning
3. On task completion: cascade episodic → semantic → procedural
4. Memory confidence threshold: only inject if importance > 0.7

**Research**: AgentOS (arXiv:2602.20934) — three-layer memory with proactive recall

**Effort**: MEDIUM (2-3 hours)  
**Priority**: 🔴 HIGH — enables self-improvement loop

---

### R6 — Session Recall Mid-Task
**Status**: Triggers on rotation only. Agent cannot access past session knowledge mid-task.

**What's needed**: Proactive recall before tackling task, cross-session linking ("research threads"), session summary injection.

**Effort**: MEDIUM (2-3 hours)  
**Priority**: 🟡 MEDIUM

---

### R7 — Cognitive-Systems Stub Check
**Status**: Verified ✅ FUNCTIONAL (not a stub)
- `explore_paths`: parallel hypothesis subagent
- `semantic memory`: concept storage with confidence
- `conflict QA`: faithful conflict resolution with explanation

**Effort**: ✅ Done (15 min check)

---

### R8 — Planner vs Metacognition Conflict
**Status**: Two planning systems may conflict (planner tool vs think tool for planning)

**Options**: 1. Merge into unified planning in metacognition, 2. Deprecate planner extension.

**Effort**: MEDIUM (analysis + decision)  
**Priority**: 🟡 MEDIUM

---

### R9 — Analytics & Feedback Wiring
**Status**: Extensions exist but never export data

**What's needed**: Metrics export to `~/.pi/logs/braid-metrics.jsonl`, feedback loop closure (scores → adjust behavior), A/B framework.

**Effort**: LARGE (4-6 hours)  
**Priority**: 🟡 MEDIUM

---

### H5 — Polyfill Cleanup
**Status**: 4 intentional `as any` casts in polyfill, global pollution risk

**Options**: Remove (if pi core covers it), scope to pi-braid context only, or keep + document.

**Effort**: SMALL (1 hour)  
**Priority**: 🟢 LOW

---

### H6 — Error-Capture Completeness
**Status**: `error-capture` captures tool errors but not subprocess errors from `bash` tool

**What's needed**: Test error-capture against subprocess failures (e.g., forge build).

**Effort**: SMALL (1 hour)  
**Priority**: 🟡 MEDIUM

---

## Track 2: Behavior Research (Braid Cognitive Dynamics)

### BR1 — Self-Reflection Patterns
**Research question**: Does Braid's self-reflection produce actual behavior change or compliance theater?

**Experiment**:
```
1. Give Braid task with known trap
2. Ask: "Reflect on your approach. What could go wrong?"
3. Measure: Does reflection match actual failure modes?
4. Compare explicit framing ("You MUST identify errors") vs implicit ("You are a careful reviewer")
```

**Effort**: MEDIUM (2-3 hours)  
**Priority**: 🔴 HIGH — core research

---

### BR2 — Tool Addiction vs Tool Aversion
**Research question**: Does Braid over-use tools (busywork) or under-use them?

**Measurement**: Tool frequency distribution, sequence entropy, success rate by sequence type.

**Effort**: LARGE (data collection + analysis)  
**Priority**: 🔴 HIGH

---

### BR3 — Nudge Effectiveness
**Research question**: Do nudges change behavior or produce ritual compliance?

**Experiment**: Control (no nudges) vs compliance-framed vs identity-framed. Measure rotation time, pre-rotation actions.

**Effort**: MEDIUM  
**Priority**: 🟡 MEDIUM

---

### BR4 — Latent Activator Multi-Turn Test
**Research question**: Does identity framing work in multi-turn (vs single-shot where it failed)?

**Better experiment**: Multi-turn debugging task. Config A: pi-braid latent ON. Config B: OFF. Config C: baseline.

**Effort**: LARGE  
**Priority**: 🔴 HIGH

---

## Track 3: Honest Benchmarking

### BM1 — Multi-Turn Debugging Benchmark
**Problem**: Current benchmarks are single-shot. pi-braid is designed for multi-turn.

**Design**: Bug-fixing task with phases: read → propose → test (fail) → debug → fix → pass. Score diagnosis, fix quality, over-fix avoidance, explanation.

**Effort**: LARGE (3-4 hours)  
**Priority**: 🔴 HIGH

---

### BM2 — Code Quality Benchmark
**Problem**: Pass rate ignores robustness, edge cases, documentation.

**Metrics**: eslint, complexity, edge case coverage, documentation score, idiomatic usage.

**Effort**: MEDIUM  
**Priority**: 🟡 MEDIUM

---

### BM3 — Real-World Task Suite
**Problem**: Algorithm puzzles don't reflect actual coding work.

**Tasks**: Add error handling, refactor callbacks, write tests, debug race conditions (multi-turn).

**Effort**: LARGE (ongoing)  
**Priority**: 🟡 MEDIUM

---

## Dependency Graph

```
R5 (three-memory) ──┬──► BR1 (self-reflection)
                    └──► BM1 (multi-turn debugging)
R6 (session recall) ──► BR2 (cross-session patterns)
R9 (analytics) ──► BR3 (nudge measurement)
D0 (belief store) ──► D0 policy engine ──► proactive cognition
D1 (session isolation) ──► correctness
```

---

## Recommended Execution Order

### Phase 0: Archive Recovery
1. **D0** Phases 1-5: Belief store + policy engine + dreamer + meta-learning (6 hours)
2. **D1**: Session isolation (3-4 hours)
3. **D5**: Evidence pool completeness (2-3 hours)

### Phase 1: Foundation
1. **R5**: Wire three-memory into agent loop (2-3 hours)
2. **R7**: ✅ Verified functional (no action needed)
3. **H5**: Polyfill cleanup (1 hour)
4. **H6**: Error-capture test (1 hour)

### Phase 2: Behavior Research
1. **BR1**: Self-reflection experiment (2-3 hours)
2. **BR4**: Latent activator multi-turn (2-3 hours)

### Phase 3: Benchmarking
1. **BM1**: Multi-turn debugging (3-4 hours)
2. **BM2**: Quality benchmark (2 hours)

### Phase 4: Measurement
1. **R9**: Analytics wiring (3-4 hours)
2. **BR3**: Nudge effectiveness (2 hours)

---

## Quick Wins (Can Do Now)

| # | Task | Time | Action |
|---|------|------|--------|
| 1 | Unarchive daemon orchestrator docs | 5 min | Move from archive |
| 2 | Verify cognitive-systems functional | 15 min | ✅ Done |
| 3 | Verify heartbeat-scheduler functional | 15 min | ✅ Done |
| 4 | Create multi-turn benchmark skeleton | 1 hour | `evaluation/multi_turn_benchmark.py` |
| 5 | Test self-reflection with known trap | 30 min | Interactive session |

---

## Open Questions

1. **Which track first?** Archive recovery → System → Behavior research?
2. **Self-reflection sessions**: Share logs? What was interesting?
3. **Tool addiction**: Over-using `think`? Under-using `read`?
4. **Model budget**: step-3.5-flash (free/fast) or save for larger models?
5. **Daemon orchestrator**: Prioritize this? Enables heartbeat-driven proactive cognition.

---

*Generated by Braid agent Session 13.*
