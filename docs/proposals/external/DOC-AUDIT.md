# Documentation Audit — 2026-04-29

## Scope

- 43 active docs (docs/)
- 49 archived docs (docs/.archive-old/)
- 3 active proposals (docs/proposals/)
- 3 research docs (docs/research/)

## Proposal Status

| Proposal                   | Status         | Implementation | Assessment                                                                                                                                                                                                                                                        |
| -------------------------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BIDIRECTIONAL-VERIFIER** | Not started    | 0%             | Valuable — would fix HWE-Bench coordination failures. Not wired to any extension. Phase 1-4 plan is concrete.                                                                                                                                                     |
| **RepE Prompt Contrast**   | Partially done | ~60%           | Phrases (TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC STABILITY, KNOWLEDGE BOUNDARY) embedded in prompt-builder identity. MISSING: structured CONTRAST_VECTORS section, per-scenario toggle, Week 2 lie-detection classifier, Week 1 phrase library as standalone doc. |
| **SAE Steering**           | Obsolete       | 0%             | Correctly superseded — stepfun/minimax don't expose activations/logprobs. RepE Prompt Contrast is the correct approach for API-only providers.                                                                                                                    |

### Proposal Action Items

1. **BIDIRECTIONAL-VERIFIER**: Keep as proposal. Consider for next research phase. Wire into existing infrastructure (belief-store, heartbeat, three-memory).
2. **RepE Prompt Contrast**: Add CONTRAST_VECTORS section to prompt-builder. Build phrase library as standalone doc. Add per-scenario toggle. Defer lie-detection classifier (lower priority).
3. **SAE Steering**: Mark COMPLETE (obsoleted by RepE Prompt Contrast research).

---

## Archive Verdict

All 49 archive files are from v0.5-v0.9 era (March-April 2026). Verdict: **Keep all**. They document the evolution of ideas and contain useful historical context. No critical content missing.

| File                              | Verdict | Reason                                                                           |
| --------------------------------- | ------- | -------------------------------------------------------------------------------- |
| ROADMAP-v1.0-FULL.md (1942 lines) | KEEP    | Comprehensive master roadmap — reference for tracking completed vs planned items |
| ROADMAP-v0.6.md                   | KEEP    | Historical — early planning decisions                                            |
| RESEARCH_SYNTHESIS_COMPLETE.md    | KEEP    | Research direction decisions                                                     |
| CONTEXT-MANAGEMENT-DESIGN.md      | KEEP    | Early design rationale                                                           |
| CONTEXT-OVERFLOW-FIX.md           | KEEP    | Early compaction investigation                                                   |
| BRAID-CONSOLIDATED-TASKS.md       | KEEP    | Historical task list                                                             |
| DEAD-EXTENSION-CLEANUP.md         | KEEP    | Audit trail                                                                      |
| All others                        | KEEP    | Historical evolution                                                             |

---

## Active Docs: Redundancy Analysis

### Redundant (Content covered elsewhere)

| Doc                   | Duplicates                                                                       | Action                                                            |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CONTEXT-MANAGEMENT.md | Overlaps with context-manager.md + context-lifecycle.md + CONTEXT-TERMINOLOGY.md | Partial — keep as user-facing overview, consolidate overlap later |
| PI-API-RESEARCH.md    | Superseded by SDK patterns in PYTHON-TO-JS-MIGRATION.md + newer docs             | Deprecate — migration to SDK complete, RPC dead-end documented    |

### Well-structured (No redundancy)

- ARCHITECTURE.md — codebase map
- CHANGELOG.md — version history
- MODULES.md — module system docs
- WHAT-IS-MISSING.md — gap analysis (source of truth)
- COUPLING.md — extension coupling map
- NUDGE-FATIGUE.md — research synthesis
- OVERFLOW-INVESTIGATION.md — compaction deep-dive
- EXTENSION-HOOKS.md — event reference
- FEATURE-AUDIT.md — feature inventory

### Extension Docs (37 docs — complete)

All 37 extension docs in docs/extensions/ exist and are up-to-date. No action needed.

### Library Docs (20 docs — complete)

All 20 lib docs in docs/lib/ exist. Key ones: belief-policy-engine.md, belief-store.md, evidence-pool.md, error-classifier.md.

---

## Implemented Features vs Proposals

### Fully Implemented (from BRAID-NEXT-PROPOSAL.md)

| Item                   | Status                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| D0 heartbeat-scheduler | ✅ COMPLETE — belief-store, policy-engine, dreamer, meta-learning all in place |
| D1 session isolation   | ✅ COMPLETE — registerSessionCleanup wired                                     |
| D5 evidence pool XoT   | ✅ COMPLETE — classify + whisper pipeline                                      |
| R5 three-memory        | ✅ COMPLETE — turn_end auto-recall, similarity > 0.3                           |
| R6 mid-task recall     | ✅ COMPLETE — skill transitions (3rd → recall), retry-recovery                 |
| R9 analytics wiring    | ✅ COMPLETE — getNextRecommendation from analytics                             |
| BR2 tool addiction     | ✅ COMPLETE — analytics rolling 50-window, single source                       |
| PB1 simplification     | ✅ COMPLETE — 245 lines, removed 5 sections                                    |
| PB2 latent runtime     | ✅ COMPLETE — RepE-style contrast phrases in identity                          |

### Partially Implemented

| Item                    | Status     | Gap                                                     |
| ----------------------- | ---------- | ------------------------------------------------------- |
| R7 L1 environment       | 🟡 Partial | discoverPiPackage() unused in prompt-builder (cosmetic) |
| BR3 nudge effectiveness | 🟡 Partial | Nudge dedup exists, A/B measurement not implemented     |
| BR4 latent multi-turn   | 🟡 Partial | SDK harness exists, full comparison not run             |
| BR1 self-reflection     | 🟡 Partial | SDK harness exists, stepfun already safe on traps       |

### Not Started

| Item                     | Priority | Reason                                |
| ------------------------ | -------- | ------------------------------------- |
| BM2 code quality         | Medium   | Time-intensive, not blocked           |
| BM3 real-world tasks     | Medium   | No task suite defined                 |
| PB4 benchmark validation | Low      | stepfun already 100/100 on compliance |

---

## Cleanup Recommendations

### Immediate (Safe — no decision needed)

1. Add `## Status: OBSOLETE` to SAE-STEERING-PROPOSAL.md
2. Add `## Status: PARTIAL — phrases embedded, structured section + toggle needed` to REPE-PROMPT-CONTRAST-PROPOSAL.md

### Recommended (User decision)

1. **Archive PI-API-RESEARCH.md** → superseded by SDK migration complete (in PYTHON-TO-JS-MIGRATION.md)
2. **Merge CONTEXT-MANAGEMENT.md** into existing docs → consolidate into context-manager.md + context-lifecycle.md + CONTEXT-TERMINOLOGY.md

### Deferred (Low priority)

1. Extension docs for the 3 most impactful extensions (latent-activator, belief-policy-engine, analytics)
2. Create RepE contrast phrase library as standalone doc
3. Add CONTRAST_VECTORS section to prompt-builder

---

## What's NOT in Archive (Missing?)

Checked for potentially missing content:

- **Latent activator research** → ✅ docs/extensions/latent-activator.md exists
- **Degradation detector** → ✅ docs/lib/degradation-detector.md exists
- **Three memory stores (2604.14475)** → ✅ docs/extensions/three-memory-stores.md exists
- **RepE research** → ✅ docs/proposals/REPE-PROMPT-CONTRAST-PROPOSAL.md + SAEs referenced
- **Heartbeat scheduling (2604.14178)** → ✅ docs/extensions/heartbeat-scheduler.md exists
- **MARS** → ✅ docs/lib/mars-reflector.md exists

**Nothing critical missing.**

---

## Archive Statistics

```
docs/                    43 files  (active)
  ├── extensions/        37 files  (complete extension docs)
  ├── lib/               20 files  (complete lib docs)
  ├── proposals/          3 files  (see status above)
  ├── research/          3 files  (bicameral, braid-loop, silicon-mirror)
  ├── skills/            2 files  (skill loading, skills index)
  ├── daemon-orchestrator/ 1 file (proposal, not started)
  └── top-level         10 files  (architecture, changelog, gap analysis, etc.)

docs/.archive-old/       49 files  (historical v0.5-v0.9)
  └── research/          8 files   (synthesis docs)
  └── subagent-tasks/   2 files   (research tasks)
  └── all others               (roadmaps, audits, proposals, fixes)
```
