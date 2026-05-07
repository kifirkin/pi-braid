# pi-braid Implementation Proposals

**Status**: Implementation roadmap — verified May 2026

## By Implementation Status

### ✅ FULLY IMPLEMENTED (archived — design complete, code exists)

| Proposal                                                     | Files                                                                                          | Notes                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **CONTRAST-PHRASE-LIBRARY.md**                               | `src/extensions/prompt/prompt-builder/contrast-phrase-library.ts`                              | 4 modes, per-scenario toggle via enforcement signals                        |
| **REPE-PROMPT-CONTRAST-PROPOSAL.md**                         | Prompt-builder §8c, enforcement signals → contrast mode                                        | 4 modes: TRUTH-SEEKING, CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY |
| **HEARTBEAT-AS-EVENT-BUS.md**                                | `src/lib/event-bus.ts`, `event-consumers.ts`, 7 event types                                    | Unified event bus with 7 consumer handlers + observatory integration        |
| **MEMORY-LEAK-PREVENTION-AND-IMPLICIT-EXPLICIT-BOUNDARY.md** | `deriveProjectId()`, cross-project penalty (-0.7), `_crossSession` flag, contamination signal  | P1.7 + P2.3 memory isolation complete                                       |
| **AGENT-TIMER-POMODORO.md**                                  | `timer_set/timer_list/timer_cancel` tools, heartbeat integration, enforcement whisper delivery | Non-blocking timers with real-time polling                                  |

### ❌ ABANDONED

| Proposal                          | Reason                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **STRUCTURED-OUTPUT-CATALYST.md** | TOOL_RESULT/STATUS/DATA blocks caused "Tool not found" errors — weaker LLMs confused structured text with API-level tool calls. Removed v0.2.0-alpha.1 |

### 🔴 NOT STARTED

| Proposal                                      | Priority | Blockers                                                                         |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| **SELF-EVOLUTION-META-COGNITION-PROPOSAL.md** | P0       | None — mars-reflector, three-memory-stores, belief-policy-engine all ready       |
| **SELF-EVOLUTION-RESEARCH-SYNTHESIS.md**      | P0       | Research only — theoretical foundation for self-evolution                        |
| **SAE-STEERING-PROPOSAL.md**                  | P2       | API providers don't expose activations/logprobs. Needs open model (Llama/Ollama) |

### 🟡 PARTIALLY IMPLEMENTED

| Proposal                                        | Status                                     | What's Missing                                                                                                  |
| ----------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md** | Compaction v0.26+ done                     | Semantic unit classification, adaptive ratios based on info density, compression metadata for retrieval scoring |
| **BIDIRECTIONAL-VERIFIER-PROPOSAL.md**          | Phase 1 done (verify tool)                 | Backward verification, file dependency graph, derived-file check injection                                      |
| **BENCHMARK-IMPROVEMENTS-PROPOSAL.md**          | SDK harnesses exist (BM1-3, BR1, BR4, PB4) | Multi-turn loop, BM3 real-world suite, variant generation framework                                             |
| **VAR-MATH-VARIANTS.md**                        | Evaluation infrastructure exists           | Variant generation not implemented, cross-bench comparison reports missing                                      |
| **CONSOLIDATION-CHANNEL-PHASE3-PROPOSAL.md**    | Phase 1-2 infra (episodic→semantic) exists | Full consolidation loop not wired                                                                               |
| **00-WORKER-TASKS.md**                          | Core extensions exist                      | Not all worker-task patterns automated                                                                          |

---

## Proposals by Priority (for execution planning)

### P0 — Critical Path

1. `SELF-EVOLUTION-META-COGNITION-PROPOSAL.md` — Full self-evolution loop (mars-reflector + SOP extraction + consolidation channel)

### P1 — High Value

2. `HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md` — Semantic classification, adaptive ratios
3. `BENCHMARK-IMPROVEMENTS-PROPOSAL.md` — Multi-turn, real-world suite, variant generation
4. `VAR-MATH-VARIANTS.md` — Variant generation + cross-bench reports

### P2 — Medium

5. `BIDIRECTIONAL-VERIFIER-PROPOSAL.md` — Phase 2 backward verification
6. `SAE-STEERING-PROPOSAL.md` — Blocked until open model provider
7. `CONSOLIDATION-CHANNEL-PHASE3-PROPOSAL.md` — Full consolidation loop

### P3 — Lower Priority

8. `00-WORKER-TASKS.md` — Worker task automation patterns

---

_Last updated: 2026-05-05_
