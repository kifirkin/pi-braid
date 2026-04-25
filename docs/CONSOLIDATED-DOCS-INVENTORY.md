# pi-braid Documentation Inventory

**Date**: 2026-04-24
**Purpose**: Catalog all docs, identify what's missing, archive obsolete ones

---

## Archive Actions

Docs moved to `docs/archive/`: OVERNIGHT-PLAN-UPDATED, OVERNIGHT-QUICKSTART, OVERNIGHT-DEVELOPMENT-PLAN, BRAID-CONSOLIDATED-TASKS, STATUS, BRAID-WORK-TRACKER.

Total existing archive: ~37 items (research syntheses, old roadmaps, historical audits, proposals now implemented).

---

## Active Top-Level Documents (12)

| Doc | Purpose |
|-----|---------|
| `README.md` | Project overview |
| `DEVELOPMENT.md` | Technical guide, testing, conventions |
| `RESEARCH-MASTER.md` | Architecture audit, gap registry, research, execution order |
| `WHAT-IS-MISSING.md` | Gap list: 17 items, priority + progress |
| `OVERNIGHT-RESULTS.md` | Apr 20 session: enforcement refactor, 85 tests, v0.13.0 |
| `OVERFLOW-INVESTIGATION.md` | Context overflow analysis, compaction strategy |
| `BRAID-NEXT-PROPOSAL.md` | v0.14.0+ roadmap (10 epics) |
| `BIDIRECTIONAL-VERIFIER-PROPOSAL.md` | Cross-model output verification |
| `REPE-PROMPT-CONTRAST-PROPOSAL.md` | REPE prompt contrast technique |
| `NUDGE-FATIGUE.md` | Agent nudge adaptation |
| `NUDGE-QUALITY-RESEARCH.md` | Whisper quality analysis |
| `SKILL-LOADING-RESEARCH.md` | Skill activation strategy |
| `prompt-builder-refactor.md` | Prompt builder rewrite notes |
| `CONSOLIDATED-DOCS-INVENTORY.md` | This document |

*(14th: `CONSOLIDATED-DOCS-INVENTORY.md` created this session)*

---

## Extension Documentation (docs/extensions/)

**Status**: 4 extension docs created. 26 extensions still need docs. 3 extensions disabled (ux, rate-limiter, watchdog).

### Extension Registry

| Extension | Size | Tools | Events | State | Notes |
|-----------|------|-------|--------|-------|-------|
| `enforcement` | 967L | 0 | 11 | 0 | Core. 17 tests. 5 handler modules. Structured signal emitters. |
| `heartbeat-scheduler` | 1022L | 11 | 5 | 3 | "Infrastructure theater". recaller, dreamer, context-hygiene. |
| `context-manager` | 50L | 0 | 1 | 0 | 49-line stub? Verify implementation. |
| `context-lifecycle` | 579L | 2 | 3 | 2 | context_proposals, context_signal. |
| `three-memory-stores` | 740L | 4 | 3 | 2 | Write-only problem. 21 tests. |
| `planner` | 216L | 8 | 0 | 3 | analyze/implement/verify. budget tracking. |
| `metacognition` | 130L | 1 | 1 | 2 | cognition_evaluate. tool_execution_end hook. |
| `topic-drift` | 269L | 2 | 0 | 5 | check_topic_drift, reset_topic_anchors. |
| `analytics` | 533L | 2 | 4 | 0 | get-session-metrics, get-tool-reliability. |
| `cognitive-systems` | 518L | 6 | 0 | 0 | Implicit. explore_paths, memory_store, memory_recall, memory_list, memory_get, memory_episodes. |
| `user-message-preprocessor` | 567L | 2 | 2 | 0 | Recently fixed `result.content` string→array bug. |
| `scratchpad` | 817L | 1 | 0 | 0 | Task management. |
| `polyfill` | 366L | 0 | 1 | 0 | TypeScript compat. before_agent_start. |
| `prompt-builder` | 515L | 0 | 1 | 0 | before_agent_start. |
| `prompt-guardian` | 112L | 0 | 3 | 0 | Safety. |
| `feedback` | 693L | 2 | 6 | 0 | Nudge Frequency Test, Require Reasoning Block Test. |
| `error-capture` | 289L | 4 | 1 | 0 | error_list, error_get, error_clear. |
| `rate-limiter` | 171L | 0 | 2 | 0 | session_shutdown, context. |
| `latent-activator` | 476L | 4 | 1 | 0 | activate_behavior, deactivate_behavior, get_active_behaviors. |
| `watchdog` | 78L | 0 | 4 | 0 | session_start, message_end, agent_start, agent_end. |
| `browser` | 739L | 6 | 1 | 0 | 6 browser tools. |
| `prompt-builder` | 515L | 0 | 1 | 0 | |
| `docs` | 360L | 2 | 0 | 0 | read_document, render_pdf_page. |
| `codebase-tree` | 621L | 1 | 0 | 0 | |
| `healthcheck` | 862L | 2 | 0 | 0 | |
| `evolve` | 732L | 2 | 1 | 0 | Self-evolution. |
| `reasoning` | 158L | 0 | 2 | 0 | before_agent_start, message_end. |
| `ux` | 256L | 0 | 2 | 0 | agent_end, input. |
| `web-fetch` | 452L | 1 | 0 | 0 | |
| `timer` | 181L | 3 | 1 | 0 | |
| `vision` | 613L | 1 | 0 | 0 | analyze_image. |
| `assistant` | 203L | 0 | 2 | 0 | session_start, session_tree. |
| `repl` | 230L | 1 | 0 | 0 | JavaScript REPL. |
| `agent-environment` | 253L | 1 | 2 | 0 | time_status. |
| `verification` | 249L | 2 | 0 | 0 | verify_claim, verify_decomposition. |

### Priority Extension Docs

**P0 (missing = crash risk)**:
- `enforcement` — 11 event handlers, 5 handler modules. Core behavior.
- `context-manager` — 50-line stub. IMPLEMENT OR DELETE.
- `heartbeat-scheduler` — 11 tools, 5 events. Most complex extension.

**P1 (critical features)**:
- `three-memory-stores` — write-only problem needs doc.
- `planner` — 8 tools, budget tracking.
- `context-lifecycle` — context_proposals, context_signal.

**P2 (user-facing tools)**:
- `analytics`, `topic-drift`, `cognitive-systems`, `scratchpad`, `verification`, `browser`, `web-fetch`, `vision`, `repl`, `docs`, `codebase-tree`, `healthcheck`, `evolve`

**P3 (infra, low usage)**:
- All remaining extensions.

---

## Skills Documentation (docs/skills/)

**Status**: ✅ All 12 skills have SKILL.md. `docs/skills/README.md` catalog exists.

| Skill | File | Purpose |
|-------|------|---------|
| `agent-testing` | `skills/agent-testing/SKILL.md` | pi RPC mode, benchmarks, Python/JS harness |
| `code-search` | `skills/code-search/SKILL.md` | ast-grep vs ripgrep, refactoring |
| `documentation` | `skills/documentation/SKILL.md` | Architecture docs generation |
| `healthcheck` | `skills/healthcheck/SKILL.md` | Self-diagnostic, process cleanup |
| `meta-improvement` | `skills/meta-improvement/SKILL.md` | Skill creation, self-improving experiments |
| `npm-approval` | `skills/npm-approval/SKILL.md` | FSTEK compliance pipeline |
| `paper-writer` | `skills/paper-writer/SKILL.md` | LaTeX research papers |
| `pi-reference` | `skills/pi-reference/SKILL.md` | pi SDK, extensions, configuration |
| `process-control` | `skills/process-control/SKILL.md` | tmux, nohup, parallel workers |
| `research` | `skills/research/SKILL.md` | Web search, fact-checking |
| `software-engineer` | `skills/software-engineer/SKILL.md` | Universal coding protocol |
| `tone-quality` | `skills/tone-quality/SKILL.md` | Writing quality |
| `vcs-tools` | `skills/vcs-tools/SKILL.md` | Git/Pijul, worktrees |

Need: `docs/skills/README.md` — one-liner catalog per skill.

---

## Library Documentation (docs/lib/)

**Status**: 23 lib files, `docs/lib/README.md` exists (overview only).

| Lib File | Purpose | Documented? |
|----------|---------|-------------|
| `extension-state.ts` | Session-scoped state factory | DEV.md |
| `evidence-pool.ts` | Evidence tracking, conflict detection | RESEARCH-MASTER |
| `conflict-qa.ts` | Conflict QA + resolution | RESEARCH-MASTER |
| `error-classifier.ts` | Error classification + retry | No |
| `mars-reflector.ts` | MARS reflection engine | No |
| `belief-policy-engine.ts` | Belief policy + signal emission | No |
| `topic-drift-detector.ts` | Topic drift detection | No |
| `reasoning-metrics.ts` | Reasoning metrics | No |
| `degradation-detector.ts` | Degradation detection | No |
| `logger.ts` | Structured logging | DEV.md |
| `extension-utils.ts` | Extension helpers | No |
| `planner.ts` | Goal management | No |
| `goal-manager.ts` | Goal state management | No |
| `belief-store.ts` | Belief state | No |
| `cognitive-memory.ts` | Cognitive memory | No |
| `metacognitive-state.ts` | Metacognitive state | No |
| `session-manager.ts` | Session management | No |
| `timer-bus.ts` | Timer event bus | No |
| `async-storage.ts` | Async storage | No |
| `model-resolver.ts` | Model resolution | No |
| `file-mutation-queue.ts` | File mutation queue | No |
| `global-state.ts` | Global state | No |
| `language-hint.ts` | Language hints | No |

---

## Missing Documentation Categories

| Category | Status | Action |
|----------|--------|--------|
| Extension docs | ✅ 35/35 exist | All extensions documented |
| Skills catalog | 0 exist | Create `docs/skills/README.md` |
| Lib docs | 0/23 exist | Create `docs/lib/README.md` |
| Runtime test guide | 0 exist | Create `docs/TESTING.md` |
| Version history | ✅ Created | `docs/CHANGELOG.md` |
| Error reference | ✅ Created | `docs/ERRORS.md` |

---

## Version State

| Version | Date | Notes |
|---------|------|-------|
| v0.13.0 | Apr 20 | Enforcement refactor, 17 enforcement tests, 85 total tests |
| v0.14.0 | Apr 23 | Structured signals wiring, compaction fix, auto-finalize, extension docs (35/35), CHANGELOG, ERRORS |
| v1.0.0 | future | Full integration, theater items wired |

---

## Archive Structure

```
docs/archive/
├── README.md
├── research/
│   ├── synthesis.md
│   ├── CROSS_REFERENCES.md
│   ├── knowledge-conflicts-synthesis.md
│   ├── implicit-framing-synthesis.md
│   ├── agent-architecture-synthesis.md
│   ├── cognitive-control-synthesis.md
│   ├── context-engineering-synthesis.md
│   └── measurement-synthesis.md
├── subagent-tasks/
├── ROADMAP-v0.9.md
├── ROADMAP-v1.0-FULL.md
├── RESEARCH_CONFLICT_QA.md
├── RESEARCH_SYNTHESIS_COMPLETE.md
├── OVERNIGHT-PLAN-UPDATED.md
├── OVERNIGHT-QUICKSTART.md
├── OVERNIGHT-DEVELOPMENT-PLAN.md
├── BRAID-CONSOLIDATED-TASKS.md
├── STATUS.md
├── SYSTEM_PROMPT_IMPROVEMENT.md
├── TOOL_IMPROVEMENTS_PROPOSAL.md
├── ROADMAP-v0.6*.md
├── PROPOSAL_TOPIC_DRIFT_DETECTOR.md
├── CONTEXT-MANAGEMENT-DESIGN.md
├── BUGS-AND-FIXES.md
├── EXTERNAL-TASKS.md
├── SELF-IMPROVEMENT-*.md
├── SKEPTIC-AUDIT.md
├── INTEGRATION-PLAN.md
├── GAP-ANALYSIS*.md
├── CODEBASE-AUDIT-FULL.md
├── RESEARCH_SYNTHESIS_20260419_EVENING.md
├── REVIEW-v0.5.7.md
├── AUDIT-2026-04-14.md
├── CONTEXT-OVERFLOW-FIX.md
├── IMPLEMENTATION-CRITICAL-REVIEW.md
├── PI_BRAID_STATE_INVESTIGATION.md
└── TOOLS_ISSUES_REPORT.md
```

---

## Runtime Tests (22 test files)

| Test | Lines | Purpose |
|------|-------|---------|
| `verify-async` | 274 | Async extension state verification |
| `test-verification` | 292 | verify_claim, verify_decomposition |
| `test-integration` | 207 | Integration tests |
| `test-finalize-bcr` | 197 | Finalize boundary condition |
| `quick-benchmark` | 329 | Benchmark harness |
| `test-memory-stores` | 171 | Three memory stores |
| `test-goal-state-persistence` | 148 | Goal persistence |
| `test-metacognition-handlers` | 149 | Metacognition handlers |
| `test-cognition-evaluator` | 148 | Cognition evaluator |
| `test-harness` | 143 | Test harness itself |
| `test-context-manager-handlers` | 144 | Context manager handlers |
| `test-nudge-dedup` | 122 | Nudge deduplication |
| `test-web-fetch-headers` | 105 | Web fetch headers |
| `test-conflict-qa` | 87 | Conflict QA |
| `test-evidence-pool` | 91 | Evidence pool |
| `test-browser-screenshot` | 55 | Browser screenshot |
| `test-heartbeat` | 70 | Heartbeat tests |
| `test-pdf-safety` | 82 | PDF safety |
| `test-reasoning-metrics` | 48 | Reasoning metrics |
| `test-error-classifier` | 45 | Error classifier |
| `test-all` | 61 | Run all tests |
| `test-topic-drift` | 124 | Topic drift |

**Note**: ✅ `docs/TESTING.md` exists.

---

## Evaluation Benchmarks (3 scripts)

| Script | Purpose | Status |
|--------|---------|--------|
| `benchmark_comprehensive.py` | Unified feature test runner (12 tests) | ✅ 100% pass |
| `br4_latent_multi_turn.py` | BR4: latent activator ON/OFF comparison | ✅ Fixed |
| `bm1_multi_turn_debug.py` | BM1: multi-turn debugging quality | ✅ Fixed |

**Coverage**: Core, metacognition, memory, policy, infrastructure, research
**Latest**: v0.18.0
