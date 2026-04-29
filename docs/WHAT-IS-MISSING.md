# What Braid Has Missed: Complete Gap Analysis

**Date**: 2026-04-29
**Last updated**: Today — pi_rpc_benchmark threading fix, belief-policy-engine validated

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
| D0 heartbeat-scheduler | 🟡 Partial | Scheduler + belief store exist. 6 policy rules. All validated (unit tests pass). Dreamer/meta-learning not tested. |
| D1 session isolation | ✅ DONE | registerSessionCleanup() wired in polyfill on session_end. |
| D2 async migration | 🟡 Partial | user-message-preprocessor, prompt-guardian, repl still sync (acceptable) |
| D5 evidence pool | ✅ DONE | XoT two-stage: classify (Stage 1) + whisper (Stage 2). Wired in enforcement/tool_end. |

---

## Phase 1: System Improvements (R5-R9)

| Item | Status | Notes |
|------|--------|-------|
| R5 three-memory | ✅ VERIFIED | turn_end auto-recall fires with 10s cooldown, similarity > 0.3. whisperRecall() suggests past solutions. |
| R6 session recall | ✅ Done | Triggers on rotation. |
| R7 L1 environment | 🟡 Partial | `discoverPiPackage()` unused in prompt-builder (cosmetic) |
| R8 planner conflict | ✅ Done | Planner vs metacognition = complementary layers |
| R9 analytics wiring | ✅ DONE | analytics proactively surfaces [policy] recommendations on tool addiction detection. |

---

## Phase 2: Behavior Research (BR1-BR4)

| Item | Status | Notes |
|------|--------|-------|
| BR1 self-reflection | 🟡 Harness written | test-br1-trap-tasks.mjs — 5 trap tasks. Needs API access to run. |
| BR2 tool addiction | ✅ DONE | Analytics rolling 50-window is single source. Removed enforcement/feedback duplicates. |
| BR3 nudge effectiveness | 🟡 Partial | Nudge dedup exists. A/B measurement not implemented. |
| BR4 latent activator | 🟡 Benchmark exists | evaluation/br4_latent_multi_turn.py exists. Needs running. |

---

## Phase 3: Prompt-Builder (PB1-PB4)

| Item | Status | Notes |
|------|--------|-------|
| PB1 simplification | ✅ Done | 245 lines, removed 5 sections |
| PB2 latent runtime | ✅ Done | Research-based contrast vectors (RepE, sycophancy resistance, epistemic stability) |
| PB3 whisper audit | ✅ DONE | Whispers clean — factual + actionable. No compliance theater. |
| PB4 benchmark validation | 🔴 Not started | No measurement of compliance behaviors |

---

## Phase 4: Benchmarking (BM1-BM3)

| Item | Status | Notes |
|------|--------|-------|
| BM1 multi-turn debugging | 🟡 Harness exists | evaluation/bm1_multi_turn_debug.py — 3 tasks, fix quality scoring. Needs threading fix in pi_rpc_benchmark. |
| BM2 code quality | 🔴 Not started | eslint, complexity, edge cases unmeasured |
| BM3 real-world tasks | 🔴 Not started | No real-world task suite |

---

## Codebase Health (2026-04-29)

| Check | Result |
|-------|--------|
| Dependency graph | ✅ No orphans, dead-ends, cycles, or high-fan-in hubs |
| Test coverage | 34/34 tests pass |
| Dead code | ✅ Clean — recentNudges + sequence_repetition removed from feedback |
| Policy rules | ✅ All 7 rules validated via unit tests |
| BPE unit tests | ✅ test-belief-policy-engine.mjs (7/7 pass) |
| pi_rpc benchmark | ✅ Threading fix — queue-based stdout reader |

---

## Key Research Findings

### What HELPS pi-braid
- Compaction v0.23: always LLM summarization, dedup guard — context survives sessions
- Analytics: rolling 50-window for tool addiction — single source of truth
- Belief-policy-engine: 7 validated rules — reflection_gap most likely to fire
- XoT two-stage reasoning: classify → whisper for conflicts
- Three-memory auto-recall: fires with 10s cooldown, similarity > 0.3

### What HURTS pi-braid
- Multiple sendMessage call sites → context pollution (wired to injection-tracker)
- pi RPC model echo issue — benchmarks need threading + echo validation
- 33 extension calls all sending whispers → nudge fatigue risk

### Infrastructure Findings
- pi RPC needs threading: stdout reader thread + queue to avoid deadlock
- message_end fires BEFORE text arrives (streaming chunks in message_update)
- agent_end.messages is incomplete — accumulate from both message_end + agent_end.messages
- pi RPC may echo prompts in some sessions — always validate response != prompt
