# What Braid Has Missed: Complete Gap Analysis

> **This is a detailed extract from [RESEARCH-MASTER.md](RESEARCH-MASTER.md) Parts 3-4. For the single source of truth, see that document.**

**Date**: 2026-04-28 (updated today)
**Last session**: compaction v0.23, BR2 dedup, D1 wired, BR1 harness, PB3 audit, R5 verified

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
| D0 heartbeat-scheduler | 🟡 Partial | Scheduler + belief store exist. Policy engine wired via emitSignal. Dreamer/meta-learning need validation. |
| D1 session isolation | ✅ DONE | `registerSessionCleanup()` wired in polyfill on session_end. All extension state clears on rotation. |
| D2 async migration | 🟡 Partial | user-message-preprocessor, prompt-guardian, repl still sync (acceptable) |
| D5 evidence pool | 🟡 Partial | Source labels exist. XoT two-stage reasoning not implemented. |

---

## Phase 1: System Improvements (R5-R9)

| Item | Status | Notes |
|------|--------|-------|
| R5 three-memory | ✅ VERIFIED | turn_end auto-recall fires with 10s cooldown, similarity > 0.3. whisperRecall() suggests past solutions. |
| R6 session recall | ✅ Done | Triggers on rotation. Proactive recall not needed mid-task. |
| R7 L1 environment | 🟡 Partial | `discoverPiPackage()` unused in prompt-builder (cosmetic) |
| R8 planner conflict | ✅ Done | Planner vs metacognition = complementary layers |
| R9 analytics wiring | 🟡 Partial | emitSignal for addiction wired. Belief-policy stores signals. Agent must query tools manually — no auto policy action. |

---

## Phase 2: Behavior Research (BR1-BR4)

| Item | Status | Notes |
|------|--------|-------|
| BR1 self-reflection | 🟡 Harness written | test-br1-trap-tasks.mjs — 5 trap tasks. Validates via final text (RPC mode doesn't expose tool_call events). Needs API access to run. |
| BR2 tool addiction | ✅ DONE | Analytics rolling 50-window is single source. Removed enforcement (9+) and feedback (5+) duplicates. |
| BR3 nudge effectiveness | 🟡 Partial | Nudge dedup exists (50-turn/5-min cooldown). A/B measurement not implemented. |
| BR4 latent activator | 🟡 Benchmark exists | evaluation/br4_latent_multi_turn.py exists. Needs running with ON/OFF comparison. |

---

## Phase 3: Prompt-Builder (PB1-PB4)

| Item | Status | Notes |
|------|--------|-------|
| PB1 simplification | ✅ Done | 245 lines, removed 5 sections |
| PB2 latent runtime | 🟡 Partial | Latent activator exists. Some behaviors still in prompt. |
| PB3 whisper audit | ✅ DONE | Whispers clean — factual + actionable. No compliance theater stakes language. [auto] prefix signals system origin. |
| PB4 benchmark validation | 🔴 Not started | No measurement of compliance behaviors |

---

## Phase 4: Benchmarking (BM1-BM3)

| Item | Status | Notes |
|------|--------|-------|
| BM1 multi-turn debugging | 🟡 Harness exists | evaluation/bm1_multi_turn_debug.py. True multi-turn debugging (read→fail→debug→fix→verify) not implemented. |
| BM2 code quality | 🔴 Not started | eslint, complexity, edge cases unmeasured |
| BM3 real-world tasks | 🔴 Not started | No real-world task suite |

---

## Summary: What's Actually Done (2026-04-28)

### ✅ Completed This Session
- Compaction v0.23: dedup guard (sessionId::leafId), always LLM summarization, clear on complete/abort
- BR2: Removed duplicate tool addiction detection — analytics is single source
- D1: registerSessionCleanup() wired in polyfill on session_end
- D3: prompt_preview(section="injections") verified — already exists and works
- BR1: test-br1-trap-tasks.mjs written (5 trap validation tests)
- PB3: Whisper audit complete — clean, no compliance theater stakes language
- R5: Verified three-memory turn_end auto-recall is wired and working

### Remaining High-Priority
1. BR1: Run trap task validation with API access
2. BR4: Run latent activator multi-turn comparison
3. BM1: Implement true multi-turn debugging benchmark
4. R9: Analytics → automatic policy-driven behavior adjustment
5. BM2/BM3: Code quality + real-world task benchmarks
