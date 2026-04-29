# pi-braid Implementation Plan

**Single source of truth.** All features, their status, priority, and execution order.

**Last updated**: 2026-04-29
**Purpose**: Executable plan for weeks/months of incremental feature development.

---

## System Status: v1.0.0

| Dimension | Status |
|---|---|
| Core extensions | 13 modules, ~35 sub-extensions |
| Tests | 34/34 passing |
| Build | 0 errors |
| Docs | 11 top-level + 42 extension + 15 proposals |
| Modules | core, cognitive, memory, heartbeat, retry, prompt, tools (13 total) |

### Recently Implemented (v1.0.0)

| Feature | Commit | Status |
|---|---|---|
| RepE structured contrast vectors (4 modes) | `dc85563` | ✅ Done |
| Structured output format (CoT, XML tags) | `dc85563` | ✅ Done |
| resources_discover handler (bundled skills) | `2ac5834` | ✅ Done |
| Browser/ → tools/ (CDP, web-fetch, vision) | `58b1844` | ✅ Done |
| Compaction v0.23 (LLM always, dedup guard) | prior | ✅ Done |
| Session recall (R6 proactive recall) | prior | ✅ Done |
| Three memory stores (200 entries, Jaccard) | prior | ✅ Done |
| Sycophancy detector | prior | ✅ Done |
| D1 session_end cleanup wired | prior | ✅ Done |
| Hidden messages tool (D3) | prior | ✅ Done |
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
- ✅ Structured output format (CoT, code blocks, XML tags) — section 8d

**What's missing**:
- Per-scenario toggle (enforcement signal state → prompt-builder contrast mode)
- Lie-detector pattern (catching agent's own contradictions)
- Contrast phrase library (see proposal #6)

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

#### 12. Agent Timer / Pomodoro — Status: NOT STARTED

**What**: Non-blocking timer for checkpoint scheduling. Agent reminder pattern: `timer_set(15min, "Check if session is productive")`.

**Effort**: Medium | **Priority**: P2

**Implementation**: Extend `src/extensions/tools/timer/` with reminder injection. Add session checkpoint suggestion.

---

#### 13. Structured Output Catalyst — Status: NOT STARTED

**What**: Prompt format that elicits structured output (chain-of-thought headers, XML-ish tags for tool results).

**Effort**: Low | **Priority**: P3

**Implementation**: Add structured output format to prompt-builder section #9. No code changes needed — prompt template only.

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
| P0.2 | Context-lifecycle signal detector | 🔶 Pending | Compaction quality → belief-policy-engine |
| P0.3 | RepE per-scenario toggle | 🔶 Pending | Enforcement → prompt-builder contrast mode |
| P0.4 | Structured output format | ✅ Done (`dc85563`) | CoT, code blocks, XML tags in §8d |
| P0.5 | Remaining TODOs in code | 🔶 Pending | Search for TODO/FIXME in src/ |
| P0.5 | Fix any remaining TODOs in code | 1h | Search for TODO/FIXME comments. |

### P1 — Week 1-2 (High value, clear path)

| # | Task | Effort | Dependencies |
|---|---|---|---|
| P1.1 | BM1 true multi-turn benchmark | 3h | None |
| P1.2 | BM3 real-world task suite | 4h | None |
| P1.3 | Bidirectional verifier (extension) | 4h | R6 session recall, enforcement |
| P1.4 | Agent Timer + Pomodoro reminders | 4h | heartbeat-scheduler |
| P1.5 | Contrast phrase library (lib) | 3h | P0.1, P0.3 |
| P1.6 | Semantic unit classification (compaction) | 3h | None |
| P1.7 | Memory contamination detection | 3h | three-memory-stores |

### P2 — Weeks 3-4 (Medium complexity)

| # | Task | Effort | Dependencies |
|---|---|---|---|
| P2.1 | Evolve auto-trigger (degrade → checkpoint) | 4h | degradation-detector, evolve ext |
| P2.2 | Heartbeat event bus formalization | 4h | Agent Timer (P1.4) |
| P2.3 | Implicit/explicit memory boundary | 4h | P1.7 |
| P2.4 | Meta-learning tick adjustment (wired) | 2h | metacognition |
| P2.5 | Benchmark variant generation framework | 4h | BM1/BM2 (P1.1/P1.2) |

### P3 — Weeks 5+ (Lower priority / exploration)

| # | Task | Effort | Dependencies |
|---|---|---|---|
| P3.1 | Self-evolution automatic trigger | 6h | P2.1 |
| P3.2 | Lie-detector pattern (RepE) | 3h | P0.1 |
| P3.3 | Rollback automation | 4h | P2.1 |
| P3.4 | HaluMem memory contamination architecture | 6h | P1.7, P2.3 |

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
| RepE per-scenario toggle | prompt-builder + enforcement | HIGH |
| Context-lifecycle signal detector | context-lifecycle | MEDIUM |
| True multi-turn BM1 | evaluation/ | HIGH |
| Bidirectional verifier | new extension | MEDIUM |
| Agent Timer reminders | timer extension | LOW |
| Evolve auto-trigger | evolve/ | LOW |
| Lie-detector (RepE) | enforcement | LOW |

---

## Release Readiness

**Current**: v1.0.0 — ready for manual review and tagging

**Pre-release gate** (all items checked):
- [x] P0 items completed (P0.1 ✅ CONTRAST_VECTORS, P0.4 ✅ structured output)
- [x] README.md polished — clean, accurate, no dead links
- [x] `docs/proposals/README.md` updated with proposal statuses
- [x] CHANGELOG.md updated with v0.38.0 entry
- [x] package.json version 1.0.0, description polished
- [ ] GitHub repo setup (manual step — user responsibility)
- [ ] Manual review pass (user responsibility)
- [ ] Manual review pass

**Post-release**: Execute P1 → P2 → P3 in order, with periodic status updates to this doc.

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-29 | Initial version — 15 proposals audited, P0-P3 plan created |