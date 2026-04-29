# pi-braid Status

**Date**: 2026-04-22  
**TypeScript**: ✅ `npx tsc --noEmit` clean (0 errors)  
**Tests**: ✅ 44/44 runtime tests pass (21 memory + 18 topic drift + 5 nudge dedup)

## Active Documentation

| File                                                              | Purpose                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [STATUS.md](STATUS.md)                                            | This file — current project state                                              |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)                        | Developer guide: structure, conventions                                        |
| [docs/BRAID-NEXT-PROPOSAL.md](docs/BRAID-NEXT-PROPOSAL.md)        | **Full R&D proposal** — all items prioritized (D0-D5, R5-R9, BR1-BR4, BM1-BM3) |
| [docs/SKILL-LOADING-RESEARCH.md](docs/SKILL-LOADING-RESEARCH.md)  | Skill resolution paths                                                         |
| [docs/NUDGE-QUALITY-RESEARCH.md](docs/NUDGE-QUALITY-RESEARCH.md)  | Enforcement/judge quality research                                             |
| [docs/NUDGE-FATIGUE.md](docs/NUDGE-FATIGUE.md)                    | Session 12 nudge dedup fix                                                     |
| [docs/HANDOFF.md](docs/HANDOFF.md)                                | Session 11-12 handoff for next agent                                           |
| [docs/archive/](docs/archive/)                                    | 34 historical documents                                                        |
| [../implicit-framing/evaluation/results/](docs/EXTERNAL-TASKS.md) | Experiment results                                                             |

## Archive Recovery (D0-D5, from BRAID-NEXT-PROPOSAL.md)

- ✅ **D0 heartbeat-scheduler** — 4 modules done, belief store + policy engine + dreamer + meta-learning missing
- ✅ **D0 cognitive-systems** — functional (explore_paths, semantic memory, conflict QA)
- ❌ **D0 daemon docs** — accidentally archived in `docs/archive/daemon-orchestrator/`
- 🔴 **D1 session isolation** — enforcement state singletons, cognitive-memory `process.cwd()`, no `session_end` cleanup
- 🟡 **D2 async migration** — ~70% done (user-message-preprocessor, prompt-guardian, repl remaining)
- 🟡 **D5 evidence pool** — source labels, faithful conflict handling, XoT reasoning missing

## System Improvements (R5-R9, H5-H6)

- 🔴 **R5 three-memory** — extension exists but NOT wired into agent loop
- 🟡 **R6 session recall** — triggers on rotation only, not mid-task
- ✅ **R7 cognitive-systems** — verified functional (not a stub)
- 🟡 **R8 planner conflict** — planner extension vs metacognition think tool overlap
- 🟡 **R9 analytics wiring** — extensions exist but never export metrics
- 🟢 **H5 polyfill** — 4 intentional `as any` casts, global pollution risk
- 🟡 **H6 error-capture** — captures tool errors but not subprocess errors from bash

## Behavior Research (BR1-BR4)

- 🔴 **BR1 self-reflection** — compliance theater vs actual behavior change (from Wormhole session)
- 🔴 **BR2 tool addiction** — over-use of `think`, under-use of `read` suspected
- 🟡 **BR3 nudge effectiveness** — rotation nudge experiment needed
- 🔴 **BR4 latent activator** — failed in single-shot (78% < baseline), may work in multi-turn

## Benchmarking (BM1-BM3)

- 🔴 **BM1 multi-turn debugging** — current benchmarks single-shot, pi-braid designed for multi-turn
- 🟡 **BM2 code quality** — pass rate ignores robustness, documentation, edge cases
- 🟡 **BM3 real-world tasks** — algorithm puzzles don't reflect actual coding work |

## What's Complete

- ✅ Nudge deduplication: rotation handler suppresses duplicate nudges after agent action (50-turn / 5-min cooldown)
- ✅ Type safety: 4/4 `as any` casts in polyfill — intentional
- ✅ Topic drift detector verified: 18/18 tests pass
- ✅ Three-memory stores verified: 21/21 tests pass
- ✅ Unload handlers added: evolve, heartbeat-scheduler, browser
- ✅ Polyfill partially refactored: typed `getSessionManager()` wrapper created
- ✅ Safety extension removed (structured metadata > text scraping)
- ✅ Identity framing throughout system prompts
- ✅ MARS learning phase + anomaly detection
- ✅ Depth budgets for think tool
- ✅ Compliance scoring in judge

## How to Reload

```bash
cd /Users/kifir/projects/agents/pi-braid
npx tsc --noEmit          # Must be clean
pi -e /Users/kifir/projects/agents/pi-braid/src/index.ts
```

## Historical Documents

Archived in `docs/archive/` — older audits, task pools, research syntheses, and session handoffs.
