# pi-braid: Master Research & Development Document

**Date**: 2026-04-23
**Version**: 1.0
**Sources**: BRAID-NEXT-PROPOSAL.md, BRAID-CONSOLIDATED-TASKS.md, STATUS.md, WHAT-IS-MISSING.md, braid-loop-research.md, implicit-framing project, today's session work

---

## Part 1: Executive Summary

This document consolidates ALL research and development work on pi-braid into a single source of truth. It covers:

- What exists and actually works
- What exists but doesn't work (infrastructure theater)
- What's missing (gaps)
- What's proposed (new research directions)
- Recommended execution order

**The core insight**: Braid has built extensive infrastructure (extensions, stores, tests) but most of it is **unwired**. The agent doesn't actually use most of what was built. This is "compliance theater" at the architecture level — code that satisfies test assertions but produces no behavioral change.

---

## Part 2: Current Architecture Audit

### Extensions Inventory (Verified Status)

| Extension | Files | Claimed Status | Actual Status | Test Coverage |
|-----------|-------|---------------|---------------|---------------|
| `heartbeat-scheduler` | 4 modules | ✅ Done | 🟡 Scheduler runs, modules registered | 4/4 pass |
| `cognitive-systems` | 3 modules | ✅ Done | 🟡 Code exists, used by other extensions | Implicit |
| `three-memory-stores` | 1 module | ✅ Done | 🟡 Stores work, NOT auto-recalled | 21/21 pass |
| `prompt-builder` | 8 files | ✅ Done | ✅ Functional, recently refactored | Manual |
| `enforcement` | 5 files | ✅ Done | ✅ Judge/whisper/nudge work | 17/17 pass |
| `analytics` | 2 files | 🟡 Partial | 🟡 Exports to file, no feedback loop | Manual |
| `rate-limiter` | 1 module | ❌ Disabled | ❌ Disabled — no tool exposes it | — |
| `latent-activator` | 1 module | ✅ Done | ✅ Works, manual activation | Manual |
| `feedback` | 2 files | ✅ Done | ✅ Works | Manual |
| `watchdog` | 1 module | ❌ Disabled | ❌ Disabled — feature never materialized | — |
| `ux` | 1 module | ❌ Disabled | ❌ Disabled — logs nothing useful | — |
| `metacognition` | 2 files | ✅ Done | ✅ think/hypothesize/finalize work | Manual |
| `planner` | 1 module | ✅ Done | ✅ Goal/plan management | Manual |
| `session-recall` | 1 module | ✅ Done | 🟡 Triggers on rotation only | Manual |
| `agent-environment` | 1 module | ✅ Done | ✅ L1 environment | Manual |
| `error-capture` | 1 module | ✅ Done | ✅ Captures tool errors | Unit tests |

**Key finding**: All extensions have positive test coverage. But "tests pass" ≠ "behavior works". The integration layer is largely missing.

### Library Inventory

| Library | Purpose | Status | Used By |
|---------|---------|--------|---------|
| `belief-store.ts` | Store beliefs with confidence | ✅ Exists | heartbeat-scheduler (claimed) |
| `path-utils.ts` | Path normalization/discovery | ✅ Exists | agent-environment (partial) |
| `logger.ts` | Structured logging | ✅ Exists | Multiple extensions |
| `polyfill.ts` | Type compatibility | ✅ Cleaned | Extension registration |

**Key finding**: `belief-store.ts` exists but is **not imported by heartbeat-scheduler**. `path-utils.ts` exists but `discoverPiPackage()` is **not used by prompt-builder**.

---

## Part 3: Infrastructure Theater Analysis

Infrastructure theater = code that exists, compiles, tests pass, but never activates in the agent loop.

### Theater Item 1: Belief Store (D0)

**What exists**: `src/lib/belief-store.ts` with CRUD operations, confidence scoring, expiration.
**What works**: Unit tests pass.
**What's missing**: The heartbeat-scheduler never imports or uses it.
**Impact**: Beliefs are never formed, never updated, never drive behavior.

### Theater Item 2: Policy Engine (D0)

**What exists**: Policy engine concept in heartbeat-scheduler.
**What works**: None. Not implemented.
**What's missing**: `PolicyEngine.evaluate()` is referenced in docs but not in code.
**Impact**: No trigger → action rules. No proactive behavior.

### Theater Item 3: Dreamer Module (D0)

**What exists**: Mentioned in docs, "self-reflection episodes".
**What works**: None. Not implemented.
**What's missing**: No dreamer code in heartbeat-scheduler.
**Impact**: No offline learning, no simulation.

### Theater Item 4: Meta-Learning Optimizer (D0)

**What exists**: Docs claim "tick interval adjusts based on activation history".
**What works**: Heartbeat has fixed tick interval (20 turns).
**What's missing**: No adaptive tick adjustment.
**Impact**: Heartbeat fires at fixed rate regardless of effectiveness.

### Theater Item 5: Three-Memory Auto-Recall (R5)

**What exists**: Three memory stores (episodic, semantic, procedural) with full CRUD.
**What works**: Stores persist data. 21/21 tests pass.
**What's missing**: No auto-recall in agent loop. Agent must manually query.
**Impact**: Memory is write-only. Past insights don't inform current reasoning.

### Theater Item 6: Session Recall Mid-Task (R6)

**What exists**: Session recall triggers on context rotation.
**What works**: Recalls past sessions when context rotates.
**What's missing**: No proactive recall before tackling similar tasks.
**Impact**: Agent starts tasks blind even when similar work exists in memory.

### Theater Item 7: Analytics Feedback Loop (R9)

**What exists**: Metrics export to `~/.pi/logs/braid-metrics.jsonl`.
**What works**: Data is written to file.
**What's missing**: No analysis of metrics. No behavior adjustment based on scores.
**Impact**: Analytics are write-only. No self-improvement loop.

### Theater Item 8: Path Utils Integration (R7)

**What exists**: `discoverPiPackage()` finds pi package path automatically.
**What works**: Function returns correct path.
**What's missing**: `prompt-builder/index.ts` still does manual path walking.
**Impact**: Fragile path resolution. Breaks if pi installation moves.

### Theater Summary

| Item | Code Exists | Tests Pass | Actually Used | Impact |
|------|------------|------------|---------------|--------|
| Belief store | ✅ | ✅ | ❌ | High |
| Policy engine | 🟡 | ❌ | ❌ | High |
| Dreamer | ❌ | ❌ | ❌ | Medium |
| Meta-learning | 🟡 | ❌ | ❌ | Medium |
| Three-memory recall | ✅ | ✅ | ❌ | High |
| Session recall proactive | 🟡 | 🟡 | ❌ | Medium |
| Analytics feedback | ✅ | 🟡 | ❌ | Medium |
| Path utils | ✅ | ✅ | ❌ | Low |

**Theater rate**: 8/8 items have code that doesn't produce behavioral change.

---

## Part 4: Complete Gap Registry

### Critical Gaps (Block Functionality)

| ID | Gap | Source | Effort | Blocked By |
|----|-----|--------|--------|------------|
| C1 | Belief store unwired | D0 | 2h | None |
| C2 | Policy engine unimplemented | D0 | 4h | C1 |
| C3 | Three-memory not auto-recalled | R5 | 3h | None |
| C4 | Session end cleanup missing | D1 | 1h | None |
| C5 | UX stdout pollution in print mode | Today's fix | 30min | None (FIXED) |
| C6 | Benchmark config broken | Today's fix | 30min | None (FIXED) |

### High Gaps (Reduce Effectiveness)

| ID | Gap | Source | Effort | Blocked By |
|----|-----|--------|--------|------------|
| H1 | Meta-learning optimizer | D0 | 2h | C2 |
| H2 | Dreamer module | D0 | 3h | C2 |
| H3 | Session recall mid-task | R6 | 2h | C3 |
| H4 | Analytics feedback loop | R9 | 4h | C3 |
| H5 | Path utils integration | R7 | 1h | None |
| H6 | Self-reflection validation | BR1 | 3h | None |
| H7 | Tool addiction measurement | BR2 | 4h | H4 |
| H8 | Whisper stakes audit | PB3 | 2h | None |
| H9 | True multi-turn debugging BM | BM1 | 4h | None |
| H10 | Recursive verification tool | Loop research | 4h | None |
| H11 | Budget-aware planning | Loop research | 4h | H4 |

### Medium Gaps (Nice to Have)

| ID | Gap | Source | Effort |
|----|-----|--------|--------|
| M1 | XoT two-stage reasoning | D5 | 3h |
| M2 | Latent behaviors still in prompt | PB2 | 2h |
| M3 | Evidence pool source labels | D5 | 2h |
| M4 | Async migration remainder | D2 | 2h |
| M5 | Code quality benchmark | BM2 | 3h |
| M6 | Real-world task suite | BM3 | 4h |
| M7 | Fast/slow routing | Loop research | 3h |
| M8 | Memory condensation | Loop research | 3h |
| M9 | Exploratory reasoning | Loop research | 4h |
| M10 | Latent activator multi-turn test | BR4 | 3h |
| M11 | Nudge effectiveness measurement | BR3 | 3h |

### Low Gaps (Cleanup)

| ID | Gap | Source | Effort |
|----|-----|--------|--------|
| L1 | Polyfill documentation | H5 | 30min |
| L2 | Error-capture subprocess test | H6 | 1h |
| L3 | Extension docs generator polish | H8 | 2h |
| L4 | README architecture diagram | H9 | 1h |
| L5 | Daemon docs unarchive | D0 | 30min |

---

## Part 5: Today's Work (2026-04-23)

### Changes Applied

| Change | File | Lines | Status |
|--------|------|-------|--------|
| Sycophancy resistance block | `prompt-builder/index.ts` | +3 | ✅ Applied |
| Stakes awareness block | `prompt-builder/index.ts` | +2 | ✅ Applied |
| Epistemic stability block | `prompt-builder/index.ts` | +2 | ✅ Applied |
| Drift self-audit | `prompt-builder/index.ts` | +2 | ✅ Applied |
| IMPLICIT_NORMS rewrite | `prompt-builder/index.ts` | -20 net | ✅ Applied |
| UX `isTTY` guard | `extensions/ux/index.ts` | +2 | ✅ Applied |
| Benchmark OSC stripping | `benchmark_multi_turn.py` | +8 | ✅ Applied |

### Documents Created

| Document | Location | Purpose |
|----------|----------|---------|
| Prompt gap analysis | `implicit-framing/docs/research/agent-architecture/prompt-gap-analysis.md` | Research → prompt mapping |
| Benchmark root cause (v1) | `implicit-framing/docs/research/agent-architecture/benchmark-root-cause.md` | Initial analysis |
| Benchmark root cause (v2) | `implicit-framing/docs/research/agent-architecture/benchmark-root-cause-v2.md` | Deeper analysis |
| Benchmark root cause (RESOLVED) | `implicit-framing/docs/research/agent-architecture/benchmark-root-cause-RESOLVED.md` | Final resolution |
| What is missing | `pi-braid/docs/WHAT-IS-MISSING.md` | Gap analysis |
| Braid loop research | `pi-braid/docs/research/braid-loop-research.md` | Looped architecture research |
| Claude mythos synthesis | `OpenMythos/docs/claude-mythos-synthesis.md` | Recurrent transformer research |

### Validation Results

| Test | Result | Notes |
|------|--------|-------|
| flatten_deep single task, braid-full | 3/3 | Post-UX-fix |
| All tasks, braid-full, 2 trials | 12/12 | Post-UX-fix |
| Full 3-config benchmark | Timeout | 54 runs too slow |

---

## Part 6: Research Cross-Reference

### Papers Applied to pi-braid

| Paper | ID | Applied To | Status |
|-------|-----|-----------|--------|
| Context Over Content | 2604.15224 | Stakes awareness in prompt | ✅ Applied |
| LLMs know they're wrong | 2604.19117 | Sycophancy resistance in prompt | ✅ Applied |
| Missing Knowledge Layer | 2604.14881 | Epistemic stability in prompt | ✅ Applied |
| Layered Mutability | 2604.14717 | Drift self-audit in prompt | ✅ Applied |
| Heartbeat Scheduling | 2604.14178 | Heartbeat-scheduler extension | 🟡 Infrastructure theater |
| Credo | 2604.14401 | Policy engine concept | 🟡 Unimplemented |
| AgentOS | 2602.20934 | Three-memory stores | 🟡 Infrastructure theater |
| Faithful Explanations | 2604.14170 | Evidence pool | 🟡 Partial |

### Papers Proposed for Implementation

| Paper | ID | Proposed Feature | Priority |
|-------|-----|-----------------|----------|
| Agentic Verifier | 2604.10980 | Recursive verification tool | 1 |
| BAVT | 2604.13408 | Budget-aware planning | 2 |
| Asymmetric Verification | 2510.06135 | Dual verification strategies at test-time | 1 |
| Hippocampus | 2602.13594 | Wavelet-matrix memory with binary signatures | 2 |
| Muse | 2510.08002 | Self-evolving agent with experience replay | 3 |
| ODAR | 2604.08890 | Fast/slow routing | 4 |
| Decocted Experience | 2604.03213 | Memory condensation | 5 |
| Loop Think Generalize | 2604.07822 | Process supervision | 6 |
| Poly-EPO | 2604.17094 | Exploratory reasoning | 7 |
| Single Agent = Multi | 2604.08734 | Justify single-agent approach | — |

---

## Part 7: Recommended Master Plan

### Principle: Wire Before Building

The #1 mistake so far: building new infrastructure while existing infrastructure sits unwired. The master plan prioritizes **integration** over **construction**.

### Phase 1: Critical Wiring (Week 1)

**Goal**: Make existing infrastructure actually work.

| Day | Task | Effort | Deliverable |
|-----|------|--------|-------------|
| 1 | Wire belief store into heartbeat | 2h | Beliefs form and update |
| 1 | Wire three-memory auto-recall | 3h | Past insights inject automatically |
| 2 | Implement policy engine (basic) | 4h | Trigger → action rules work |
| 2 | Add session_end cleanup | 1h | No memory leaks |
| 3 | Integrate path-utils | 1h | Robust path resolution |
| 3 | Validate self-reflection (trap tasks) | 3h | Evidence of behavior change |

**Exit criteria**: All "infrastructure theater" items from Part 3 are resolved.

### Phase 2: Validation & Measurement (Week 2)

**Goal**: Measure what we have before adding more.

| Day | Task | Effort | Deliverable |
|-----|------|--------|-------------|
| 4 | Run BR4 latent multi-turn test | 3h | Comparison data |
| 4 | Measure BR2 tool addiction | 4h | Distribution data |
| 5 | Audit PB3 whisper stakes | 2h | Clean whispers |
| 5 | Full benchmark validation | 2h | Regression confirmed |
| 6 | Analytics feedback loop (basic) | 4h | Metrics → behavior adjustment |

**Exit criteria**: We have data on what works and what doesn't.

### Phase 3: New Research Implementation (Week 3-4)

**Goal**: Add validated research-backed features.

| Week | Task | Effort | Source |
|------|------|--------|--------|
| 3 | Recursive verification tool | 4h | 2604.10980 |
| 3 | Budget-aware planning | 4h | 2604.13408 |
| 4 | Fast/slow routing | 3h | 2604.08890 |
| 4 | Memory condensation | 3h | 2604.03213 |

**Exit criteria**: New features are wired, tested, and validated.

### Phase 4: Polish (Week 5)

**Goal**: Clean up, document, archive.

| Day | Task | Effort |
|-----|------|--------|
| 21 | Process supervision | 4h |
| 22 | Exploratory reasoning | 4h |
| 23 | Documentation pass | 4h |
| 24 | Final benchmark | 2h |
| 25 | Archive obsolete | 2h |

---

## Part 8: Metrics & Success Criteria

### Baseline (Current State)

| Metric | Value |
|--------|-------|
| Benchmark pass rate (standard problems) | 100% (144/144 — saturated) |
| Variant benchmark pass rate | 13% (2/15 on 5 JS variants) |
| Config variations | 4 configs all pass 100% on standard, 0-20% on variants |
| Problem saturation | 5/6 problems at 100% (saturated) |
| Infrastructure theater items | 8/8 (not yet wired) |
| Auto-recalled memories | 0% (not wired yet) |
| Feedback loop closure | 0% (not wired yet) |

**Key finding**: Standard = 100% (saturated), variants = 13% (same skill, different structure → 87pp drop). Confirms VAR-MATH contamination model. Variants needed for differentiation.

### Targets (After Phase 1)

| Metric | Target |
|--------|--------|
| Infrastructure theater items | 0/8 |
| Auto-recalled memories | >70% of tasks |
| Belief-driven actions | >50% of heartbeats |
| Session isolation | No leaks detected |

### Targets (After Phase 2)

| Metric | Target |
|--------|--------|
| Benchmark pass rate (all configs) | >95% |
| Latent activator effectiveness | Measured |
| Tool addiction score | Measured |
| Nudge effectiveness | Measured |

### Targets (After Phase 3)

| Metric | Target |
|--------|--------|
| Verification pass rate | >90% |
| Token savings (budget-aware) | >30% |
| Routing accuracy (fast/slow) | >80% |
| Memory condensation ratio | >50% |

---

## Part 9: Open Questions

1. **Does the meta-learning optimizer actually help?** We don't know because it was never wired.
2. **Is three-memory recall useful?** Stores work, but we don't know if recalled insights improve task performance.
3. **Does self-reflection reduce errors?** Prompt updated, but no trap-task validation.
4. **What's the optimal heartbeat tick interval?** Fixed at 20 turns, never optimized.
5. **Should we merge planner and metacognition?** Two planning systems may conflict.
6. **How much does prompt simplification help?** Token count reduced, but no behavioral measurement.
7. **Is single-agent sufficient?** Research says yes for many tasks, but we haven't tested multi-agent.

---

## Part 10: Proposals & Research Threads

### Activation Hook Testing (2026-04-23)

| Provider | logprobs | hidden states | embeddings | Verdict |
|----------|----------|---------------|------------|---------|
| **stepfun** | ❌ Not supported | ❌ Not exposed | ⚠️ Quota exceeded | **API-only, no activation access** |
| **minimax** | ❌ Not supported | ❌ Not exposed | ✅ Works (embo-01, 1024 dim) | **API-only, no activation access** |

**Consequence**: RepE contrast injection, SAE steering, UniR logit addition — ALL BLOCKED. Only prompt-level approaches work for pi-braid.

### Active Proposals

| Proposal | Path | Priority | Status |
|----------|------|----------|--------|
| Bidirectional Verifier | `docs/proposals/BIDIRECTIONAL-VERIFIER-PROPOSAL.md` | P1 | Not started |
| SAE Steering | `docs/proposals/SAE-STEERING-PROPOSAL.md` | P1 | **Obsolete for API providers** — blocked by no activation access |
| RepE Prompt Contrast | `docs/proposals/REPE-PROMPT-CONTRAST-PROPOSAL.md` | **P0** | **Ready to start** — API-only approach to RepE principles |
| OpenMythos Loop Analysis | `implicit-framing/docs/research/agent-architecture/OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md` | P1 | Not started |

### New Research (2026-04-23)

| Research | Path | Key Finding |
|----------|------|-------------|
| Benchmark contamination + latent steering | `implicit-framing/docs/research/agent-architecture/BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md` | Most benchmark problems are in LLM training data; SAE steering could provide circuit-level behavioral control |
| New papers synthesis | `implicit-framing/docs/research/agent-architecture/NEW_PAPERS_20260423.md` | BeHonest (2406.13261), HWE-Bench (2604.14709), AgentV-RL (2604.16004), DeepInsightTheorem (2604.16278) |

### New Papers (2026-04-23)

| Paper | arXiv | Key Contribution |
|-------|-------|-----------------|
| BeHonest | 2406.13261 | 3-dimension honesty benchmark (self-knowledge, non-deceptiveness, consistency) |
| HWE-Bench | 2604.14709 | 3 failure modes: localization, reasoning, coordination |
| AgentV-RL | 2604.16004 | Bidirectional forward+backward verification with RL |
| DeepInsightTheorem | 2604.16278 | Hierarchical dataset structuring for informal proof reasoning |
| VAR-MATH | 2507.12885 | RL-trained models drop 48-73% on variabilized benchmarks |
| YaPO | 2601.08441 | Sparse steering vectors via DPO in SAE latent space |
| FGAA | 2501.09929 | Feature Guided Activation Additions in SAE space |
| RepE | 2310.01405 | Representation Engineering: top-down transparency via population-level representations |
| SAE Features | 2310.01405 | Sparse autoencoders extract monosemantic features from residual stream |
| UniR | 2505.19075 | Universal Reasoner: plug-and-play reasoning module for frozen LLMs |
| AntiLeakBench | 2412.13670 | Contamination-free benchmark construction |

### Deep Latent Space Research (2026-04-23)

| Research | Path | Key Finding |
|----------|------|-------------|
| Latent space + novel capability | `implicit-framing/docs/research/agent-architecture/LATENT-SPACE-AND-NOVEL-CAPABILITY.md` | Confirmed: Latent space manipulation enhances Level 2 recombination, not Level 3 novelty. RepE contrast vectors suppress unwanted behaviors. UniR modules add new capabilities. Three-level capability model. |
| Benchmark contamination | `implicit-framing/docs/research/agent-architecture/BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md` | VAR-MATH: 48-73% drop on variabilized benchmarks. Most benchmark problems in training data. |

---

## Part 11: Archive of Decisions

| Decision | Date | Rationale |
|----------|------|-----------|
| Single model default for utility/judge | 2026-04-23 | Bicameral research: 85-90% of dual-model benefits at 1× cost |
| Benchmark: remove `--no-extensions` | 2026-04-23 | Extensions load via settings.json; flag was blocking provider initialization |
| Prompt-builder: rewrite IMPLICIT_NORMS | 2026-04-23 | 25+ directives → 5 declarative principles; reduces compliance theater |
| 4 research blocks added to prompt-builder | 2026-04-23 | Sycophancy resistance, stakes awareness, epistemic stability, drift self-audit |
| Remove 5 prompt sections | 2026-04-23 | Compliance theater from implicit-framing research |
| Add sycophancy resistance | 2026-04-23 | 2604.19117 — same circuit as lying |
| Add stakes awareness | 2026-04-23 | 2604.15224 — stakes corrupt reasoning |
| Add epistemic stability | 2026-04-23 | 2604.14881 — detect instability early |
| Add drift self-audit | 2026-04-23 | 2604.14717 — memory drift is invisible |
| Rewrite IMPLICIT_NORMS | 2026-04-23 | Declarative > imperative (same research) |
| Add UX `isTTY` guard | 2026-04-23 | OSC 777 pollution in print mode |
| Add benchmark OSC stripping | 2026-04-23 | Defensive safety net |
| Keep planner separate | 2026-04-22 | Complementary to metacognition |
| Keep latent activator manual | 2026-04-22 | Auto-routing is future work (ODAR research) |

---

## References

### Internal Documents
- `BRAID-NEXT-PROPOSAL.md` — Original proposal
- `BRAID-CONSOLIDATED-TASKS.md` — Task list
- `STATUS.md` — Current status
- `WHAT-IS-MISSING.md` — Gap analysis
- `research/braid-loop-research.md` — Looped architecture research
- `NUDGE-QUALITY-RESEARCH.md` — Enforcement research
- `prompt-builder-refactor.md` — Prompt changes

### External Research
- `~/projects/vibe/implicit-framing/docs/research/` — Implicit framing, sycophancy, cognitive control
- `~/projects/agents/OpenMythos/docs/` — Looped transformers, recurrent depth

### Papers Cited
- 2604.15224 — Context Over Content (stakes signaling)
- 2604.19117 — LLMs know they're wrong (sycophancy)
- 2604.14881 — Missing Knowledge Layer (epistemic control)
- 2604.14717 — Layered Mutability (drift)
- 2604.14178 — Heartbeat Scheduling
- 2604.14401 — Credo
- 2602.20934 — AgentOS (three-memory)
- 2604.14170 — Faithful Explanations
- 2604.10980 — Agentic Verifier
- 2604.13408 — BAVT
- 2604.08890 — ODAR
- 2604.03213 — Decocted Experience
- 2604.07822 — Loop, Think, Generalize
- 2604.17094 — Poly-EPO
- Thinking-Claude (richards199999) — Structured thinking protocol (53KB), deprecated April 2026. Insight: adaptive depth, verification loops, natural monologue format maps to `think` tool improvements.
- SABER (2512.07850) — Semantic-aligned backdoor. Security research, not harness-relevant.

---

### Thinking-Claude Protocol Insights (Applied to pi-braid)

The Thinking-Claude protocol (deprecated April 2026 because Claude gained built-in reasoning) contains structural elements that map to pi-braid's `think` tool:

| Thinking-Claude Feature | pi-braid Equivalent | Gap |
|------------------------|---------------------|-----|
| Adaptive depth based on query complexity | `think` has `depth` param | ✅ Covered |
| Verification loops within thinking | `verify` tool (proposed) | 🔴 Missing |
| Multiple hypothesis generation | `hypothesize` tool | ✅ Exists |
| Natural language inner monologue | System prompt instruction | 🟡 Partial (IMPLICIT_NORMS has "think silently") |
| Error recognition and correction | No equivalent | 🔴 Missing |
| Progress tracking | No equivalent | 🔴 Missing |
| Cross-check conclusions against evidence | Evidence pool | 🟡 Partial |

**Key insight**: The Thinking-Claude protocol's value is in STRUCTURE, not content. Pi-braid's `think` tool should support:
1. **Verification sub-blocks**: Within a `think` call, the agent can self-verify before proceeding
2. **Progress checkpoints**: Agent tracks what's established vs. what remains
3. **Error correction**: Agent can signal "I was wrong about X, revising to Y"

These can be implemented as OPTIONAL fields in the `think` tool schema, not mandatory (to avoid compliance theater).

---

## Part 11: Document Cleanup (2026-04-23)

### Actions Taken

| Action | File(s) | Reason |
|--------|---------|--------|
| Archived | `BRAID-CONSOLIDATED-TASKS.md` | Superseded by RESEARCH-MASTER |
| Archived | `GAP-ANALYSIS-STATUS.md` | Superseded by RESEARCH-MASTER |
| Archived | `STATUS.md` | Superseded by RESEARCH-MASTER |
| Archived | `EXTERNAL-TASKS.md` | Superseded by RESEARCH-MASTER |
| Archived | `HANDOFF-session-11-12.md` | Old session, stale |
| Archived | `PAPER_EXPERT_REVIEW.md` | Stale research |
| Kept | `RESEARCH-MASTER.md` | Single source of truth |
| Kept | `README.md` | Updated index |
| Kept | `BRAID-NEXT-PROPOSAL.md` | Historical reference |
| Kept | `WHAT-IS-MISSING.md` | Detailed gap analysis |
| Kept | `DEVELOPMENT.md` | Workflow reference |
| Kept | `NUDGE-QUALITY-RESEARCH.md` | Active research |
| Kept | `NUDGE-FATIGUE.md` | Active research |
| Kept | `SKILL-LOADING-RESEARCH.md` | Active research |
| Kept | `prompt-builder-refactor.md` | Active reference |
| Moved | `braid-loop-research.md` → `research/` | New research thread |

### Final Document Structure

```
pi-braid/docs/
├── README.md                           ← Index
├── RESEARCH-MASTER.md                  ← Single source of truth
├── WHAT-IS-MISSING.md                  ← Gap analysis
├── BRAID-NEXT-PROPOSAL.md              ← Historical proposal
├── DEVELOPMENT.md                      ← Workflow
├── NUDGE-QUALITY-RESEARCH.md           ← Enforcement research
├── NUDGE-FATIGUE.md                    ← Nudge dedup
├── SKILL-LOADING-RESEARCH.md           ← Skill system
├── prompt-builder-refactor.md          ← Prompt changes
├── research/
│   └── braid-loop-research.md          ← Looped architecture
├── daemon-orchestrator/
│   └── BRAID-OS-DAEMON-LAYER-PROPOSAL.md  ← Superseded
├── archive/                            ← 31 files
│   ├── BRAID-CONSOLIDATED-TASKS.md
│   ├── GAP-ANALYSIS-STATUS.md
│   ├── STATUS.md
│   ├── EXTERNAL-TASKS.md
│   └── ... (27 more)
└── .archive/                           ← 2 files
    ├── MEASUREMENT_GAP_SOLUTION.md
    └── VALIDATION_PROTOCOL.md
```

---

*This document is a living reference. Update it when status changes, new gaps are found, or research is applied.*

