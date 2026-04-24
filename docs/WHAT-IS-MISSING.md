# What Braid Has Missed: Complete Gap Analysis

> **This is a detailed extract from [RESEARCH-MASTER.md](RESEARCH-MASTER.md) Parts 3-4. For the single source of truth, see that document.**

**Date**: 2026-04-23
**Sources**: BRAID-NEXT-PROPOSAL.md, BRAID-CONSOLIDATED-TASKS.md, STATUS.md, today's work, looped architecture research

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ | Done |
| 🔴 | Missing — critical |
| 🟡 | Partial — needs completion |
| 🆕 | NEW — identified today |

---

## Phase 0: Archive Recovery (D0-D5)

| Item | Claimed Status | Actual Status | Gap |
|------|---------------|---------------|-----|
| D0 heartbeat-scheduler | ✅ "4 modules done" | 🟡 Scheduler runs, belief store exists, but **policy engine + dreamer + meta-learning NOT wired** | Policy evaluation, dreamer episodes, meta-learning tick adjustment never activate |
| D0 daemon docs | ❌ "accidentally archived" | ❌ Still in `docs/archive/daemon-orchestrator/` | Should be unarchived and integrated |
| D1 session isolation | ✅ "Done" | 🟡 Singletons exist, but **no `session_end` cleanup** | Cognitive memory uses `process.cwd()`, leaks across sessions |
| D2 async migration | ✅ "Done" | 🟡 70% done; user-message-preprocessor, prompt-guardian, repl still sync | Unknown if causing issues |
| D5 evidence pool | 🟡 "Partial" | 🟡 Source labels exist, but **XoT two-stage reasoning NOT implemented** | No chain-of-thought decomposition in conflict handling |

**Key insight**: The "Done" labels on D0 and D1 are misleading. The code exists but the **integration** is missing. It's like having a engine in a garage vs. having it in the car.

---

## Phase 1: System Improvements (R5-R9, H5-H6)

| Item | Claimed Status | Actual Status | Gap |
|------|---------------|---------------|-----|
| R5 three-memory | 🟡 "In recaller" | 🟡 Stores verified (21/21 tests), but **NOT auto-recalled in agent loop** | Must manually query; not proactive |
| R6 session recall | ✅ "Done" | 🟡 Only triggers on **rotation**, not mid-task | No proactive recall before tackling similar tasks |
| R7 L1 environment | 🟡 "Partial" | 🟡 `path-utils.ts` created, but **prompt-builder still does manual path walking** | `discoverPiPackage()` not used in `reconstructProjectContextSection()` |
| R8 planner conflict | ✅ "Done" | ✅ Actually resolved | — |
| R9 analytics wiring | 🟡 "Partial" | 🟡 Metrics export to file, but **NO feedback loop closure** | Scores don't adjust behavior; A/B tracking exists but not analyzed |
| H5 polyfill | ✅ "Done" | ✅ Cleaned | — |
| H6 error-capture | ✅ "Done" | ✅ Works for bash failures | — |

**Key insight**: R5-R9 are "infrastructure theater" — the pipes exist, but no water flows through them. The three-memory stores work but the agent doesn't automatically use them.

---

## Phase 2: Behavior Research (BR1-BR4)

| Item | Claimed Status | Actual Status | Gap |
|------|---------------|---------------|-----|
| BR1 self-reflection | 🟡 "System prompt updated" | 🟡 Prompt has `MODE_AWARENESS`, `SELF_REFLECTION_GUIDANCE`, but **NO trap task validation** | We don't know if it actually works |
| BR2 tool addiction | 🔴 "Not started" | 🔴 No data collection, no analysis | Suspected but unmeasured |
| BR3 nudge effectiveness | 🟡 "Rotation nudge experiment needed" | 🟡 Nudge dedup exists (50-turn/5-min cooldown), but **NO A/B measurement** | Don't know if nudges change behavior |
| BR4 latent activator | 🟡 "Multi-turn benchmark created" | 🟡 `benchmark_multi_turn.py` exists, but **NOT run with latent ON/OFF comparison** | Single-shot failed (78%), multi-turn untested |

### 🆕 Completed 2026-04-24 (Session Fixes + Integration)

| Item | Status | Notes |
|------|--------|-------|
| Auto-finalize at 90% via sendUserMessage | ✅ Done | heartbeat-scheduler now sends steer message at 90% context, forcing finalize |
| Compaction window fix | ✅ Done | `pi.compact({ keep: reducedKeep })` now passes keep on retry, vs `pi.compact()` before |
| Structured enforcement signals | ✅ Done | `SystemSignal.autoProceed` added, `emitSignal` updated, enforcement handlers wired |
| `result.content` array fix | ✅ Done | 7 tools fixed (planner, topic-drift, analytics), 3 pi-core patches applied |
| Extension docs (4) | ✅ Done | enforcement, three-memory-stores, planner, context-lifecycle docs created |
| Skills catalog | ✅ Done | `docs/skills/README.md` created |
| Lib catalog | ✅ Done | `docs/lib/README.md` created |
| Testing guide | ✅ Done | `docs/TESTING.md` created |
| Doc consolidation | ✅ Done | 21→13 top-level docs, 37 in archive |
| Extension doc framework | ✅ Done | `docs/extensions/` dir created (4 docs, 29 remaining) |

**Key insight**: All behavior research is either unvalidated or unmeasured. We have hypotheses but no evidence.

---

## Phase 3: Prompt-Builder (PB1-PB4)

| Item | Claimed Status | Actual Status | Gap |
|------|---------------|---------------|-----|
| PB1 simplification | ✅ "Done" | ✅ 245 lines, removed 5 sections | — |
| PB2 latent runtime | 🟡 "Move 40 behaviors to runtime" | 🟡 Latent activator extension exists, but **behaviors still partially in prompt** | Some behaviors still listed in prompt (check `implicit-norms.ts`) |
| PB3 enforcement audit | 🟡 "Audit whispers for stakes" | 🆕 **Partially done TODAY** | We added `STAKES_AWARENESS` block to prompt, but **did NOT audit existing whisper content** |
| PB4 benchmark validation | 🔴 "Not started" | 🔴 Benchmark runs but **no measurement of compliance behaviors** | Don't know if simplification actually reduced compliance theater |

**Key insight**: Today's prompt changes (sycophancy, stakes, epistemic, drift) are NEW and overlap with PB3 but were NOT in the original plan. We need to validate them.

---

## Phase 4: Benchmarking (BM1-BM3)

| Item | Claimed Status | Actual Status | Gap |
|------|---------------|---------------|-----|
| BM1 multi-turn debugging | 🔴 "Not started" | 🟡 `benchmark_multi_turn.py` exists (print mode), but **NOT designed for multi-turn debugging** | Current benchmark is single-shot code generation, not iterative debugging |
| BM2 code quality | 🔴 "Not started" | 🔴 No quality metrics | eslint, complexity, edge cases unmeasured |
| BM3 real-world tasks | 🔴 "Not started" | 🔴 No real-world tasks | Still doing algorithm puzzles |

**Key insight**: Our "multi-turn" benchmark is actually single-shot with 3 trials. True multi-turn debugging (read → fail → debug → fix → verify) doesn't exist.

---

## 🆕 NEW: Looped Architecture Research (Today's Work)

| Item | Source | Status | Gap |
|------|--------|--------|-----|
| Recursive verification | 2604.10980 | 🆕 Identified | No `verify` tool in metacognition |
| Budget-aware planning | 2604.13408 | 🆕 Identified | Planner has no token budget tracking |
| Fast/slow routing | 2604.08890 | 🆕 Identified | Latent activator is manual, not auto-routed |
| Exploratory reasoning | 2604.17094 | 🆕 Identified | `hypothesize` exists but no multi-path fusion |
| Memory condensation | 2604.03213 | 🆕 Identified | Session recall injects raw insights, no compression |
| Process supervision | 2604.07822 | 🆕 Identified | No step-by-step consistency checking |

**Key insight**: These are NOT in the original proposal at all. They represent a new research direction that could supersede some existing tasks.

---

## 🆕 NEW: Today's Prompt Changes

| Change | File | Status | Gap |
|--------|------|--------|-----|
| Sycophancy resistance | `prompt-builder/index.ts` | ✅ Applied | Needs benchmark validation |
| Stakes awareness | `prompt-builder/index.ts` | ✅ Applied | Needs benchmark validation |
| Epistemic stability | `prompt-builder/index.ts` | ✅ Applied | Needs benchmark validation |
| Drift self-audit | `prompt-builder/index.ts` | ✅ Applied (in IMPLICIT_NORMS) | Needs benchmark validation |
| IMPLICIT_NORMS rewrite | `prompt-builder/index.ts` | ✅ Applied | Needs benchmark validation |
| UX `isTTY` guard | `extensions/ux/index.ts` | ✅ Applied | Needs full benchmark run |
| Benchmark OSC stripping | `benchmark_multi_turn.py` | ✅ Applied | Needs full benchmark run |

**Key insight**: All of today's changes are applied but **NOT validated** at scale. The partial benchmark showed 12/12 pass, but that's 2 trials × 6 tasks, not the full 3 configs × 6 tasks × 3 trials.

---

## Summary: What's Actually Missing

### Critical (Do First)

1. ~~**🔴 D0 dreamer/policy/meta-learning**: Code exists but never activates~~ → ✅ Wired (structured signals)
2. **🔴 D1 session cleanup**: Memory leaks across sessions
3. ~~**🔴 R5 three-memory auto-recall**: Stores work but agent doesn't use them~~ → Documented (write-only read gap noted)
4. **🔴 BR1 validation**: Self-reflection prompt claims, no evidence
5. **🔴 BM1 true multi-turn debugging**: Current benchmark is single-shot
6. **🔴 R9 feedback loop**: Analytics export to file, no behavior adjustment

### High (Do Next)

7. **🟡 R6 mid-task recall**: Only triggers on rotation
8. **🟡 R7 path-utils integration**: `discoverPiPackage()` unused
9. **🟡 PB3 whisper audit**: Stakes language still present in whispers
10. **🟡 BR4 latent multi-turn test**: Benchmark exists, not run
11. **🟡 BR2 tool addiction measurement**: Suspected, unmeasured
12. **🆕 Recursive verification tool**: New research, high impact
13. **🟡 29 extension docs**: `docs/extensions/` created, 4 done, 29 remaining

### Medium/ (Do Later)

13. **🟡 D5 XoT reasoning**: Evidence pool missing two-stage decomposition
14. **🟡 PB2 latent runtime**: Some behaviors still in prompt
15. **🟡 BM2/BM3 quality/real-world**: Metrics and tasks undefined
16. **🆕 Budget-aware planning**: New research, additive
17. **🆕 Memory condensation**: New research, additive
18. **🟡 Prompt guardian policy integration**: prompt-guardian unused

---

## The Real Problem/

Braid has built **infrastructure** (extensions, stores, tests) but hasn't built **integration** (wiring, feedback loops, validation). The result is:

- Tests pass ✅
- Code compiles ✅
- But the agent doesn't actually use most of what was built ❌

This is the same "compliance theater" pattern we identified in prompts — but at the architecture level.

---

## Recommended Fix Strategy

Don't build more. **Wire what exists.**

### Week 1: Integration Sprint
1. Wire D0 policy engine into heartbeat (2h)
2. Wire R5 three-memory into agent loop (2h)
3. Add session_end cleanup (1h)
4. Validate BR1 with trap tasks (2h)

### Week 2: Validation Sprint
5. Run BR4 latent multi-turn comparison (3h)
6. Measure BR2 tool addiction (2h)
7. Audit PB3 whisper stakes language (1h)
8. Full benchmark validation (2h)

### Week 3: New Research (After validation)
9. Implement recursive verification (4h)
10. Implement budget-aware planning (4h)

---

*Generated from cross-referencing BRAID-NEXT-PROPOSAL, BRAID-CONSOLIDATED-TASKS, STATUS, today's work, and looped architecture research.*
