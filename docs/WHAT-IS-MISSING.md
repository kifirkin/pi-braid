# What Braid Has Missed: Complete Gap Analysis

**Date**: 2026-04-29
**Last updated**: Today — BPE validated, R9 closed, codebase graph clean

## Legend

| Status | Meaning |
|--------|---------|
| ✅ | Done |
| 🔴 | Missing — critical |
| 🟡 | Partial — needs completion |

---

## Phase 0: Archive Recovery (D0-D5)

| Item | Status | Notes |
|------|--------|-------|
| D0 heartbeat-scheduler | 🟡 Partial | Scheduler + belief store exist. 6 policy rules defined. Policy engine wired via emitSignal. All 7 rules validated (unit tests). Dreamer/meta-learning not tested. |
| D1 session isolation | ✅ DONE | `registerSessionCleanup()` wired in polyfill on session_end. All extension state clears on rotation. |
| D2 async migration | 🟡 Partial | user-message-preprocessor, prompt-guardian, repl still sync (acceptable) |
| D5 evidence pool | ✅ DONE | XoT two-stage reasoning: Stage 1 (classify) + Stage 2 (whisper). `detectConflicts` wired in enforcement/tool_end. |

---

## Phase 1: System Improvements (R5-R9)

| Item | Status | Notes |
|------|--------|-------|
| R5 three-memory | ✅ VERIFIED | turn_end auto-recall fires with 10s cooldown, similarity > 0.3. whisperRecall() suggests past solutions. |
| R6 session recall | ✅ Done | Triggers on rotation. |
| R7 L1 environment | 🟡 Partial | `discoverPiPackage()` unused in prompt-builder (cosmetic) |
| R8 planner conflict | ✅ Done | Planner vs metacognition = complementary layers |
| R9 analytics wiring | ✅ DONE (2026-04-29) | analytics turn_end now proactively surfaces [policy] recommendations from belief-policy-engine. Closed the feedback loop. |

---

## Phase 2: Behavior Research (BR1-BR4)

| Item | Status | Notes |
|------|--------|-------|
| BR1 self-reflection | 🟡 Harness written | test-br1-trap-tasks.mjs — 5 trap tasks. Validates via final text. Needs API access to run. |
| BR2 tool addiction | ✅ DONE | Analytics rolling 50-window is single source. Removed enforcement (9+) and feedback (5+) duplicates. |
| BR3 nudge effectiveness | 🟡 Partial | Nudge dedup exists (50-turn/5-min cooldown). A/B measurement not implemented. |
| BR4 latent activator | 🟡 Benchmark exists | evaluation/br4_latent_multi_turn.py exists. Needs running with ON/OFF comparison. |

---

## Phase 3: Prompt-Builder (PB1-PB4)

| Item | Status | Notes |
|------|--------|-------|
| PB1 simplification | ✅ Done | 245 lines, removed 5 sections |
| PB2 latent runtime | ✅ Done | Behaviors moved to latent runtime. Prompt has research-based contrast vectors (RepE, sycophancy resistance, epistemic stability). |
| PB3 whisper audit | ✅ DONE | Whispers clean — factual + actionable. No compliance theater stakes language. |
| PB4 benchmark validation | 🔴 Not started | No measurement of compliance behaviors |

---

## Phase 4: Benchmarking (BM1-BM3)

| Item | Status | Notes |
|------|--------|-------|
| BM1 multi-turn debugging | 🟡 Harness exists | evaluation/bm1_multi_turn_debug.py — 3 tasks (race condition, memory leak, null reference). Phase tracking, fix quality scoring, over-fix detection. Ready to run. |
| BM2 code quality | 🔴 Not started | eslint, complexity, edge cases unmeasured |
| BM3 real-world tasks | 🔴 Not started | No real-world task suite |

---

## Codebase Health (2026-04-29)

| Check | Result |
|-------|--------|
| Dependency graph | ✅ No orphans, dead-ends, cycles, or high-fan-in hubs |
| Test coverage | 34/34 tests pass |
| Dead code | ✅ Clean — `recentNudges` + `sequence_repetition` removed from feedback |
| Policy rules | ✅ All 7 rules validated (test-belief-policy-engine.mjs) |

---

## Summary: What's Actually Done (2026-04-29)

### ✅ Completed This Session
- Compaction v0.23: dedup guard, always LLM, clear on complete/abort
- BR2: Analytics is single source for tool addiction (removed enforcement/feedback duplicates)
- D1: registerSessionCleanup() wired in polyfill on session_end
- D3: prompt_preview(section="injections") verified
- BR1: test-br1-trap-tasks.mjs harness written (5 trap tasks)
- PB3: Whisper audit complete — clean
- R5: Auto-recall verified wired
- R9: Analytics proactively surfaces [policy] recommendations (feedback loop closed)
- D5: XoT two-stage reasoning confirmed wired (evidence-pool + conflict-qa)
- PB2: Prompt has research-based contrast vectors
- BPE: All 7 policy rules validated via unit tests
- Feedback: removed unused recentNudges + sequence_repetition type

### Remaining High-Priority
1. BR1: Run trap task validation with API access
2. BR4: Run latent activator multi-turn comparison (ON vs OFF vs baseline)
3. BM1: Run multi-turn debugging benchmark
4. BM2/BM3: Code quality + real-world task benchmarks
5. BR3: Nudge effectiveness A/B measurement
6. PB4: Benchmark validation for compliance behaviors
