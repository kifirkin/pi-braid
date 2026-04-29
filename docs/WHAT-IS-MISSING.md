# What Braid Has Missed: Complete Gap Analysis

**Date**: 2026-04-29
**Last updated**: Today — SDK benchmarks working (pi RPC subprocess deadlocks, SDK doesn't), BM1+BR1 harnesses via SDK + stepfun

## Legend

| Status | Meaning |
|--------|---------|
| ✅ | Done |
| 🔴 | Missing — critical |
| 🟡 | Partial — needs completion |

---

## pi RPC vs SDK — Critical Finding

**Python subprocess RPC deadlocks** — pi's async stdin/stdout interleaving causes blocking that can't be solved from Python. Threading partially helps but deep deadlocks remain on long prompts.

**Solution: pi SDK (Node.js)** — Direct API, no subprocess pipes, reliable event delivery, session.state.messages for text extraction. Key fixes:
- Model must include `provider` + `api` + `baseUrl` fields (not just `id`)
- Streaming events `message_update` not reliable — use `session.state.messages` after `prompt()` resolves
- Tool calls in `toolResult` messages (not just `assistant`)
- `stepfun/step-3.5-flash` via `pi-poorman-providers` — reasoning=true but no thinking output

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
| BR1 self-reflection | 🟡 SDK harness | evaluation/br1-sdk.mjs — 5 trap tasks, stepfun model. Smoke test shows agent executes echo without hesitation. Needs full run. |
| BR4 latent activator | ✅ VERIFIED | BR4 3-trial: solve rate 100% both configs. Latent +0.3 turns persistence. TRAP COMPARISON: stepfun model already refuses all harmful traps (authority, reward-hacking, disabling-safety) with strong reasoning — both baseline (no extensions) AND pi-braid score 100/100. Compliance patterns don't fire — model uses direct refusal, not scripted confirmation language. Enforcement value is NOT in compliance — it's in memory, persistence, error recovery. |
| BR2 tool addiction | ✅ DONE | Analytics rolling 50-window is single source. Removed enforcement/feedback duplicates. |
| BR3 nudge effectiveness | 🟡 Partial | Nudge dedup exists. A/B measurement not implemented. |
| BR4 latent activator | 🟡 Benchmark exists | evaluation/br4_latent_multi_turn.py — needs SDK migration. |

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
| BM1 multi-turn debugging | 🟡 SDK harness | evaluation/bm1-sdk.mjs — 3 tasks, ~60/100 avg with stepfun. ts-read-fail: 100/100 (agent found + fixed JS syntax errors), ls-bash-fail: 50/100, edit-fail: 30/100 (impossible task — can't append comment to JSON without breaking it). |
| BM2 code quality | 🔴 Not started | eslint, complexity, edge cases unmeasured |
| BM3 real-world tasks | 🔴 Not started | No real-world task suite |

---

## pi-poorman-providers

pi-braid should use `stepfun/step-3.5-flash` via `pi-poorman-providers` as the benchmark model. This is the model that "works great" per user confirmation. All benchmarks should migrate to SDK + stepfun. |

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

## Key Research Findings

### What HELPS pi-braid
- Compaction v0.23: always LLM summarization, dedup guard — context survives sessions
- Analytics: rolling 50-window for tool addiction — single source of truth
- Belief-policy-engine: 7 validated rules — reflection_gap most likely to fire
- XoT two-stage reasoning: classify → whisper for conflicts
- Three-memory auto-recall: fires with 10s cooldown, similarity > 0.3

### What HURTS pi-braid
- Multiple sendMessage call sites → context pollution (wired to injection-tracker)
- 33 extension calls all sending whispers → nudge fatigue risk

### What pi-braid CANNOT FIX (model already handles)
- **Compliance/safety**: stepfun model already refuses harmful requests (authority impersonation, reward hacking, disabling-safety) with strong reasoning — both baseline and pi-braid score 100/100 on trap tasks. Compliance patterns (over_confirmation, rule_anchoring) don't fire — model uses direct refusal.
- Enforcement extension value is in memory/persistence/error-recovery, NOT compliance

### Infrastructure Findings
- **pi RPC subprocess = dead end**: async stdin/stdout interleaving causes deadlock. Use pi SDK (Node.js) instead
- pi SDK streaming events unreliable — use `session.state.messages` after `prompt()` resolves
- Model must include `provider` + `api` + `baseUrl` for API calls (not just `id`)
- Tool calls in `toolResult` messages (not just `assistant`)
- stepfun reasoning=true but no thinking output in SDK events

### Infrastructure Findings
- pi RPC needs threading: stdout reader thread + queue to avoid deadlock
- message_end fires BEFORE text arrives (streaming chunks in message_update)
- agent_end.messages is incomplete — accumulate from both message_end + agent_end.messages
- pi RPC may echo prompts in some sessions — always validate response != prompt
