# pi-braid Implementation Plan

**Single source of truth.** All features, their status, priority, and execution order.

**Last updated**: 2026-04-30
**Purpose**: Executable plan for weeks/months of incremental feature development.

---

## System Status: v0.2.0-alpha.2

| Dimension | Status |
|---|---|
| Core extensions | 13 modules, ~35 sub-extensions |
| Tests | 34/34 passing |
| Build | 0 errors |
| Docs | 12 top-level + 42 extension + 15 proposals |
| Modules | core, cognitive, memory, heartbeat, retry, prompt, tools (13 total) |

### Recently Implemented (v0.2.0-alpha.2)

| Feature | Commit | Status |
|---|---|---|
| RepE structured contrast vectors (4 modes) | `dc85563` | ✅ Done |
| Structured output format | `f745364` | 🔶 Removed (caused tool-call errors) |
| resources_discover handler (bundled skills) | `2ac5834` | ✅ Done |
| Browser/ → tools/ (CDP, web-fetch, vision) | `58b1844` | ✅ Done |
| Compaction v0.26 (queued message preservation) | `b765756` | ✅ Done |
| P1.7 session isolation + deriveProjectId (repo-level memory) | `f547ca4` | ✅ Done |
| P2.1 auto-trigger degrade detection | `9a41ec5` | ✅ Done |
| P2.2 event taxonomy (agent-events.ts, 10 domains) | `ffd1b22` | ✅ Done |
| P2.3 memory boundary (P2.3+P3.4 HaluMem: -0.7 cross-project penalty, contamination signal) | `ffd1b22` | ✅ Done |
| Recursive Verification Tool (verify tool: heuristic + LLM, 3 depth modes) | `2f7432f` | ✅ Done |
| ODAR Fast/Slow Routing (estimateComplexity + auto_depth in think tool) | `e7c6793` | ✅ Done |
| Sycophancy detector | prior | ✅ Done |
| Repl verbose output (shows code + result) | `09b2644` | ✅ Done |
| Hypothesize throws on failure (analytics) | `a8b37eb` | ✅ Done |

---

## Proposals & Research Tracks: Full Audit

### Category: 🔴 ENFORCEMENT & ALIGNMENT

#### 1. REPE Prompt Contrast — Status: PARTIAL (structurally complete)

**What exists**:
- ✅ Sycophancy resistance phrase in identity section
- ✅ RepE-style contrast principles in identity section
- ✅ Structured `CONTRAST_VECTORS` section (4 modes: TRUTH-SEEKING, CORRECTION, EPISTEMIC CALIBRATION, TOOL RELIABILITY) — prompt-builder section 8c
- 🔶 Structured output format REMOVED — TOOL_RESULT/STATUS/DATA blocks caused 'Tool not found' errors (LLM outputs text resembling tool calls instead of actual API calls). Replaced with simple code block guidance.

**What's missing**:
- Per-scenario toggle (enforcement signal state → prompt-builder contrast mode)
- Lie-detector pattern (catching agent's own contradictions)
- Contrast phrase library (see proposal #6)
- ⚠️ Structured output format REMOVED — TOOL_RESULT/STATUS/DATA blocks caused 'Tool not found' errors (LLM outputs text resembling tool calls instead of actual API calls). Replaced with simple code block guidance.

**Effort**: Medium | **Priority**: P2

**Implementation**: Wire enforcement signal state to prompt-builder contrast mode. Add per-context mode selection.

---

#### 2. Contrast Phrase Library — Status: NOT STARTED

**What**: Four contrast phrases (speak-truth, correct-hierarchy, epistemic-calibration, admit-uncertainty) with per-context activation.

**Effort**: Medium | **Priority**: P3

**Implementation**: New lib `contrast-phrase-library.ts` + integration into prompt-builder. Requires REPE proposal above.

---

#### 3. Bidirectional Verifier — Status: NOT STARTED

**What**: Agent's root-cause fixes are verified for derived-file consistency. Prevents fixing root cause but missing derived bugs.

**Effort**: Medium | **Priority**: P3

**Dependencies**: Requires R6 (session recall) + enforcement.

**Implementation**: New extension `bidirectional-verifier/` that checks derived file consistency after agent edits.

---

#### 4. Sycophancy Detector — Status: IMPLEMENTED ✅

`src/extensions/cognitive/sycophancy-detector/index.ts` — detects sycophancy signals, emits to belief-policy-engine.

---

### Category: 🟡 MEMORY & CONTEXT

#### 5. Hierarchical Memory Compression — Status: PARTIAL

**What exists**: Compaction v0.23 (dedup guard, LLM always, clear on complete/abort).

**What's missing**:
- Semantic unit classification (short/medium/long message classification)
- Signal detector: `context_lifecycle signal` fires when compaction quality degrades
- Context-density metrics → heartbeat analytics (wired but not formalized)

**Effort**: Medium | **Priority**: P1

**Dependencies**: semanticCompress (exists), filterSafeToRemove (exists), context-lifecycle signal (MISSING).

**Implementation**: Add `signal-detector.ts` to context-lifecycle, wire context_density into heartbeat density metrics.

---

#### 6. Memory Leak Prevention — Status: PARTIAL

**What exists**: D1 session_end cleanup wired (`registerSessionCleanup` in polyfill on session_end). All extension state clears on rotation.

**What's missing**:
- Proactive leak detection (identify which extensions accumulate state across rotations)
- Implicit/explicit boundary enforcement (HaluMem paper: prevent memory contamination)

**Effort**: Medium | **Priority**: P2

**Implementation**: Extend `registerSessionCleanup` with leak detection metrics. Add contamination detection to three-memory-stores.

---

#### 7. Three Memory Stores — Status: IMPLEMENTED ✅

`src/extensions/memory/three-memory-stores/index.ts` — semantic + episodic + procedural stores, 200 entries, Jaccard dedup.

---

#### 8. Session Recall — Status: IMPLEMENTED ✅

`src/extensions/memory/session-recall/index.ts` — past session search via semantic query. R6 proactive recall wired.

---

### Category: 🟢 COGNITIVE SCHEDULING

#### 9. Heartbeat as Event Bus — Status: PARTIAL

**What exists**: `emitSignal()` across 6 call sites, heartbeat-scheduler ticks, policy engine evaluation.

**What's missing**:
- Formalized unified event model (all async mechanisms as events)
- Timer-based checkpoint triggers (pomodoro pattern)
- Agent reminder pattern (heartbeat → reminder whisper to agent)

**Effort**: Medium | **Priority**: P2

**Implementation**: See #12 (Agent Timer). Heartbeat event bus emerges from timer integration.

---

#### 10. Self-Evolution & Meta-Cognition — Status: PARTIAL

**What exists**: `evolve/` extension (disabled by default), `degradation-detector.ts`, `dreamer.ts`.

**What's missing**:
- Automatic trigger (not just manual /evolve command)
- Health-based checkpointing (auto-save on degradation detection)
- Meta-learning tick interval adjustment (already in metacognition but not wired to degrade-on-idle)
- Rollback automation

**Effort**: High | **Priority**: P3

**Dependencies**: Degradation detector (exists), evolve extension (exists).

**Implementation**: Wire degradation-detector into heartbeat-scheduler → auto-trigger evolve.

---

### Category: 🔵 BENCHMARKING & VALIDATION

#### 11. Benchmark Improvements (BM1/BM2/BM3 v2) — Status: PARTIAL

**What exists**: BM1 (multi-turn debugging), BM2 (code quality), BR1 (trap tasks), BR4 (latent multi-turn). SDK harness working.

**What's missing**:
- BM1 true multi-turn (current is single-shot)
- BM3 real-world task suite
- Variant generation framework (VAR-MATH-VARIANTS proposal)
- Structured output validation (STRUCTURED-OUTPUT-CATALYST proposal)

**Effort**: High | **Priority**: P1

**Implementation**: Extend evaluation/ directory. BM1 needs proper multi-turn loop (read→fail→debug→fix→verify).

---

#### 12. Agent Timer / Pomodoro — Status: ✅ COMPLETE

**What**: Non-blocking timer for checkpoint scheduling. Agent reminder pattern: `timer_set(15min, "Check if session is productive")`.

**Effort**: Medium | **Priority**: P2

**Implemented**:
- `timer_set(delay_seconds, reason, tag?)` — registers timer, returns immediately
- `timer_list()` / `timer_cancel(timer_id)` — query and cancel
- Real-time polling (1s setInterval) — fires independently of turn_end
- `fireTimer()` sends steer + whisper on expiry — agent woken regardless of state
- Tool description says "REPLACES bash sleep — do NOT use sleep() after this"
- Session navigation auto-reset via SignalDetector entry-count-drop detection

---

#### 13. Structured Output Catalyst — Status: REMOVED ✅

**What**: Prompt format that elicits structured output (chain-of-thought headers, XML-ish tags for tool results).

**Status**: REMOVED in v0.2.0-alpha.1 — the TOOL_RESULT/STATUS/DATA block format caused 'Tool not found' errors. Weaker LLMs confused structured text output with actual API-level tool calls, generating tool calls with empty names. Replaced with simple code block + CoT guidance.

---

### Category: ⚪ RESEARCH (Meta / Not Implementation Items)

#### 14. Self-Evolution Research Synthesis — Status: RESEARCH ✅

Research synthesis document. Already done — provides theoretical foundation.

#### 15. SAE Steering — Status: OBSOLETE ✅

API-only providers (stepfun, minimax) don't expose activations/logprobs. RepE prompt contrast is the correct approach.

---

## Consolidated Execution Plan

### P0 — Immediate (before public release) — MOSTLY DONE ✅

| # | Task | Status | Action |
|---|---|---|---|
| P0.1 | RepE CONTRAST_VECTORS section | ✅ Done (`dc85563`) | 4 modes in prompt-builder §8c |
| P0.2 | Context-lifecycle signal detector | ✅ Done | generateDensitySignals() feeds into policy engine on each turn |
| P0.3 | RepE per-scenario toggle | ✅ Done | determineContrastMode() → enforcement_signals event → prompt-builder §8c |
| P0.4 | Structured output format | 🔶 Removed | TOOL_RESULT blocks caused tool-call errors |
| P0.5 | Remaining TODOs in code | ✅ Clean | Zero TODO/FIXME matches in src/ |

### P1 — Week 1-2 (High value, clear path)

| # | Task | Effort | Dependencies |
|---|---|---|---|
| DONE | Agent Timer + Pomodoro reminders | ✅ Done | real-time polling + steer reminders + contrast toggle |
| DONE | Contrast phrase library | ✅ Done | formatContrastSection() → mode-driven phrase selection |
| DONE | Semantic unit classification (compaction) | ✅ Done | semanticCompress.ts wired in session_before_compact |
| DONE | P1.7 memory contamination detection | ✅ Done | sessionId on Episode, deriveProjectId(), _crossSession flag on recall |
| P1.1 | BM1 true multi-turn benchmark | 3h | None | (excluded) |
| P1.2 | BM3 real-world task suite | 4h | None | (excluded) |
| P1.3 | Bidirectional verifier (extension) | 4h | R6 session recall, enforcement | (excluded) |

### P2 — Weeks 3-4 (Medium complexity)

| # | Task | Status | Dependencies |
|---|---|---|---|
| DONE | Evolve auto-trigger (degrade → whisper) | ✅ Done | isDegraded turn_end → emitSignal + whisper |
| DONE | P2.2 Heartbeat event bus formalization | ✅ Done | agent-events.ts (10 signal domains) + memory_contamination policy rule |
| DONE | P2.3 Implicit/explicit memory boundary | ✅ Done | -0.7 cross-project penalty + contamination signal + memoryConfidence decay |
| DONE | Meta-learning tick adjustment | ✅ Done | tickInterval adjustment in heartbeat-scheduler |
| DONE | Recursive Verification Tool (verify) | ✅ Done | heuristic+LLM checks, 3 depth modes, finalize pre-flight |
| DONE | ODAR Fast/Slow Routing | ✅ Done | estimateComplexity() + auto_depth in think tool |
| P2.5 | Benchmark variant generation framework | 4h | BM1/BM2 (excluded) |

### P3 — Weeks 5+ (Lower priority / exploration)

| # | Task | Effort | Dependencies |
|---|---|---|---|
| P3.1 | Self-evolution automatic trigger | ✅ Done | isDegraded → evolver shouldActivate auto-trigger (turn 10 + degrade) |
| P3.2 | Lie-detector pattern (RepE) | ✅ Done | cross-turn claim tracking + enforcement whisper |
| P3.3 | Rollback automation | ✅ Done | state-checkpoint.ts: auto-checkpoint every 20 clean turns + auto-rollback on degrade via heartbeat |
| P3.4 | Budget-Aware Planning (BAVT) | ✅ Done | P2 |
| P3.5 | Memory Condensation (Decocted Experience) | ✅ Done | P2 |
| P3.6 | Process Supervision (step_check) | ✅ Done | P3 |
| P3.7 | Exploratory Reasoning (explore_paths) | ✅ Already exists | cognitive-systems/index.ts — spawns parallel sub-agents |
| BR3 | Nudge A/B measurement | ✅ Done | Variant-controlled nudge suppression for effectiveness testing |
| D0 | Dreamer module testing | ✅ Done | test-dreamer.mjs: 6 tests for shouldActivate, cooldown, structure |
| R9 | Analytics feedback loop | ✅ Done | getNextRecommendation called from analytics turn_end on addiction |
| P3.4 | HaluMem memory contamination architecture | ✅ Done | P2.3 completed this (cross-project penalty + confidence decay + contamination signal) |

---

## Implementation Guidelines

### Working on a feature

1. Read the relevant proposal in `docs/proposals/`
2. Check implementation status above
3. For each file to modify, use `edit-helper.ts` (`safeEdit`, `safeEditMulti`) — avoids stale file content errors
4. Before commit: `npm run build && npm run typecheck && node scripts/run-tests.mjs`
5. After implementing: update this doc's status column

### Code quality gate (before each commit)

```
npm run build    # 0 TS errors
npm run typecheck
node scripts/run-tests.mjs  # 34/34
npm run lint:check  # 0 warnings
```

### Branch strategy

- `develop` = main development branch
- Feature work: `feature/<name>` → PR to `develop`
- Public release: tag from `develop` after manual review

---

## Current Gaps Summary

| Gap | Location | Severity |
|---|---|---|
| Budget-Aware Planning (BAVT) | planner | ✅ Done |
| Memory Condensation (Decocted Experience) | session-recall | ✅ Done |
| Process Supervision (step_check) | reasoning | ✅ Done |
| Lie-detector (RepE) | enforcement | ✅ Done | claim-tracker.ts + enforcement turn_end |
| Self-evolution auto trigger | evolve | ✅ Done | isDegraded→evolver shouldActivate |
| Rollback automation | heartbeat | ✅ Done | state-checkpoint.ts |
| BM3 real-world task suite | evaluation/ | (excluded) |

---

## Release Readiness

**Current**: v0.2.0-alpha.2 — 13 commits ahead of v0.2.0-alpha.1

**Pre-release gate**:
- [x] All P0 ✅ (P0.1-3 done, P0.4 REMOVED, P0.5 clean)
- [x] P1/P2 non-benchmark items complete
- [x] README.md + docs/proposals/README.md current
- [x] CHANGELOG.md v0.2.0-alpha.2 entry
- [x] BRAID-NEXT archived (superseded by IMPLEMENTATION.md)
- [x] `npm run build && node scripts/run-tests.mjs` — 34/34, 0 TS errors
- [ ] GitHub repo push (manual — user responsibility)
- [ ] Manual review pass (user responsibility)

**Post-release**: Execute P1 → P2 → P3 in order, with periodic status updates to this doc.

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-30 | v0.2.0-alpha.2: verify tool ✅, ODAR routing ✅, P2.2/P2.3/P1.7 ✅, deriveProjectId fix ✅, BRAID-NEXT archived, IMPLEMENTATION.md consolidated |
| 2026-04-30 | P0.2 ✅ density signals → policy engine, P0.3 ✅ contrast mode toggle, P0.5 ✅ clean, Timer/Pomodoro COMPLETE |
| 2026-04-29 | Initial version — 15 proposals audited, P0-P3 plan created |