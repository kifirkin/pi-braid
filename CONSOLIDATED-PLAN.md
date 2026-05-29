# pi-braid Consolidated Plan

A living document merging the original refactor roadmap, completed work, and the new tool audit.
Replaces `REFACTOR-PLAN.md`, `REVIVAL-PLAN.md`, `TASKS.md`, and `TOOL-AUDIT.md`.

---

## Status Summary

| Domain | Status | What was done |
|--------|--------|---------------|
| ✅ **Revival Tiers 1-2** | Complete | Nudge merge, enforcement_signals wiring, state leak fix, logging-only consumers removed, dead code (~2000 lines), turn-end coordinator created, BehavioralState decomposed, paper citations fixed |
| ✅ **Safety + Pre-Fix (Phase 0)** | Complete | Integration smoke tests for enforcement created (500+ lines, passes), eslint baseline established |
| ✅ **Event Bus Wiring (Phase 1.1)** | Complete | error-tracking, context-lifecycle, watchdog all subscribed to event bus |
| ✅ **Consolidation Pipeline (Phase 1.3)** | Complete | `processConsolidationTick` wired from heartbeat scheduler |
| ✅ **LLM Fixes (Phase 3)** | Complete | Text classifier tier order fixed (heuristic-first), judge prompts improved, fallback order corrected |
| ✅ **Agent-Patch (Phase 2.1)** | Complete | Version gate simplified, idempotent patch always applies |
| ✅ **Orphaned Timeouts (Phase 2.2)** | Complete | `AbortSignal` + `clearTimeout` in llm-call.ts |
| ✅ **Async-Storage Data Loss (Phase 2.3)** | Complete | Microtask batching + `beforeExit` handler |
| ✅ **Whisper Double-Tag (Phase 2.4)** | Complete | `[enforcement]` prefix kept (intentional — `customType` is SDK metadata, invisible to agent) |
| ✅ **Logger Context Binding (Phase 3.4)** | Complete | `bindContext`/`unbindContext`/`hasContext` removed, TUI routing removed |
| ✅ **Degradation→Checkpoint (Phase 1.2)** | Complete | turn_end handler at priority 99 checks `isDegraded()` and triggers `autoRollback()` |
| ✅ **File I/O Consolidation (Phase 6.4)** | Complete | `consolidation-channel.ts` sync→async fs/promises |
| ✅ **Scratchpad Race Fix** | Complete | Per-slug mutex via promise chaining for task store |
| ✅ **Triple-Critic Migration** | Complete | `classify()` + `CRITICS` from `critic-registry.ts` replaces heuristic/regex |
| ✅ **Module Flattening** | Complete | `definitions.ts` → `manifest.ts` flat manifest |
| ✅ **Lib Restructure (T6)** | Complete | 51 flat files → 11 functional subdirectories (core/, state/, config/, constants/, events/, store/, ai/, reasoning/, detection/, utils/, cognitive-memory/) |
| ✅ **Dist Cleanup** | Complete | Stale dist/ artifacts removed from git tracking |
| ✅ **Refactoring Skill** | Complete | `skills/code-refactoring/SKILL.md` extracted from hands-on experience |
| ✅ **Tool Audit** | Complete | Full inventory of 57 registered tools, 7 issues identified |
| ✅ **Conflict Resolution Feedback (Phase 1.4)** | Complete | Wire conflict detection → resolution tracking → whisper feedback loop. Done in prior commits: register-message-end.ts tracks pendingConflictIds, escalates after 5 turns, checks agent responses for resolution |
| ✅ **Enforcement God Object Split (Phase 5)** | Complete | 6 focused turn-end handlers (drift, BPE, MARS, dreamer, feedback, reflection) + turn-end-handler.ts. Replaced 170-line dispatch-turn-end-analysis.ts. Done in commit 7096d598 |
| ✅ **Any Cast Reduction (Phase 4.1)** | Complete | Zero `as any` casts remaining in src/extensions/ and src/lib/. Fixed 5 casts (handler-registry, context-lifecycle, register-session-compact, compaction.ts ×2). Done in commit 4a52765c |
| ✅ **Tool Consolidation (P0, P1, P2)** | Complete | Context tools 10→5, behavior tools 4→1, scratchpad split into scratchpad+task. Net reduction: 57→50 tools. Done in commits 8da84d27 + 192c918e |
| ⬜ **P4: Memory Surface Investigation** | Audited — no change needed | 3 memory tools (episodes/heuristics/tool-stats) are legitimately agent-facing. Used by context-manager (shared.ts) and behavioral-drift. Keep as-is |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        MODULE SYSTEM                         │
│  (manifest.ts + loader.ts + api.ts — solid)                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐ │
│  │  CORE   │  │  ENFORCEMENT │  │  MEMORY  │  │  CONTRIB  │ │
│  │  (7 ext)│  │  (1 big ext) │  │  (5 ext) │  │  (8 ext)  │ │
│  └────┬────┘  └──────┬───────┘  └────┬─────┘  └───────────┘ │
│       │              │               │                       │
│       └──────────────┼───────────────┘                       │
│                      │                                       │
│              ┌───────▼────────┐                              │
│              │   TURN_END     │  ← coordinator dispatches    │
│              │  COORDINATOR   │     priority-ordered handlers│
│              └───────┬────────┘                              │
│                      │                                       │
│         ┌────────────┼────────────┐                          │
│         ▼            ▼            ▼                          │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│   │ analysis │ │ loop     │ │ claim    │  ...               │
│   │ (drift,  │ │ (burst,  │ │ tracker  │                    │
│   │ BPE,     │ │ overflow,│ │          │                    │
│   │ MARS,    │ │ nudge)   │ │          │                    │
│   │ dreamer) │ │          │ │          │                    │
│   └──────────┘ └──────────┘ └──────────┘                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              EVENT BUS (wired, all consumers active)    │  │
│  │  heartbeat_tick → enforcement (adaptive thresholds)     │  │
│  │  tool_error    → error-tracking (error_list tools)      │  │
│  │  memory_evict  → context-lifecycle (proposal adjust)    │  │
│  │  analytics_alert → watchdog (monitoring alerts)         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │        PI BRAID PATHS (~/.pi/agent/braid/)              │  │
│  │  memory/  checkpoints/  errors/  feedback/  metrics/    │  │
│  │  consolidated-hints.jsonl  tools-config.json             │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Tool Inventory

Total: **57 registered tools** + ~10 builtins = ~67 agent-visible tools.

### By Module

| Module | Tools | Source |
|--------|-------|--------|
| **Builtins** (pi core) | ~10 | pi-agent-core |
| **Metacognition** | 10 | core/metacognition, core/scratchpad, core/agent-environment, cognitive/verification, cognitive/topic-drift, core/prompt-builder |
| **Context Management** | 10 | memory/context-manager (8), memory/context-lifecycle (2) |
| **Memory** | 10 | memory/memory-agent-bridge (5), memory/three-memory-stores (3), memory/session-recall (2) |
| **)_** | 14 | contrib/pi-browser |
| **Behavior** | 4 | tools/latent-activator |
| **Timers** | 6 | tools/timer (3), tools/auto-singleton (3) |
| **Monitoring** | 4 | contrib/system-monitor, contrib/healthcheck, heartbeat/analytics (2) |
| **Data Access** | 3 | contrib/pi-docs (2), contrib/pi-vision (1) |
| **Code Intelligence** | 2 | contrib/pi-codebase-graph, contrib/pi-codebase-tree (if registered) |
| **Utilities** | 4 | contrib/diff, contrib/research, contrib/observatory, health-maintenance |

### Issues Found

| # | Issue | Severity | Affected |
|---|-------|----------|----------|
| 1 | **scratchpad monolith** — 25 sub-actions in one tool (goals + planning + tasks + decisions + notes + learning) | High | 1 tool |
| 2 | **context-* sprawl** — 10 tools where 3-4 would suffice. `snapshot`/`audit` overlap, `prune`/`compact` are sequential | High | 10 tools |
| 3 | **Memory fragmentation** — same domain split across 3 extensions with different APIs | Medium | 10 tools |
| 4 | **Verify duplication** — `verify` + `verify_claim` + `verify_decomposition` overlap | Medium | 3 tools |
| 5 | **Behavior toggle** — 4 tools for CRUD on one state value | Low | 4 tools |
| 6 | **auto_singleton + timer** — overlapping timed operation responsibility | Low | 6 tools |
| 7 | **healthcheck vs system_monitor** — similar names, different domains | Low | 2 tools |

---

## Tool Consolidation Plan (executed)

### ✅ P0: Context tools (10 → 5) — Done 8da84d27

**What changed:**
- `context_inspect` — merged `context_snapshot` + `context_audit` + `context_prune` dry-run
- `context_compress` — merged `context_compact` + `context_archive` + `context_prune` execute
- `context_navigate` — merged `context_log` + `context_checkout` + `context_tag`
- Kept `context_proposals` + `context_signal` (separate domains)
- Removed 8 old tool files

### ✅ P1: Behavior tools (4 → 1) — Done 8da84d27

**What changed:**
- Single `behavior` tool with `action=activate|deactivate|list|mix`
- Removed `activate_behavior`, `deactivate_behavior`, `get_active_behaviors`, `activate_mix`

### Remaining tool tasks
- **P2: scratchpad split** (task ops extraction) — not started
- **P3: verify rationalization** — cross-reference descriptions (keep as-is)
- **P4: Memory surface investigation** — not started
- **P5: Timer + singleton merge** — keep separate (document only)

---

## Completed Refactoring Work

All items from the original refactor plan are now complete.
See the Status Summary table above for the full list.

### Conflict Resolution Feedback Loop (Phase 1.4)
**Status**: ✅ Complete (done in prior commits).
`register-message-end.ts` tracks `pendingConflictIds` in enforcement state, escalates after 5 turns, and checks agent responses for resolution via `checkResponseForResolution()`.

### Enforcement God Object Final Split (Phase 5)
**Status**: ✅ Complete (commit 7096d598).
Replaced 170-line `dispatch-turn-end-analysis.ts` monolith with 6 focused turn-end handlers in `handlers/analysis/`.

### Any Cast Reduction (Phase 4.1)
**Status**: ✅ Complete (commit 4a52765c).
Zero `as any` casts remain in `src/extensions/` and `src/lib/`. 2 remain in `src/contrib/` (auto-symlinked workspace artifacts).

### P4: Memory Surface Investigation
**Status**: ✅ Audited — no change needed.
3 memory tools (episodes/heuristics/tool-stats) are legitimately agent-facing and used by context-manager and behavioral-drift.

### Tool Consolidation (P0, P1, P2)
**Status**: ✅ Complete.
- P0: Context tools 10→5
- P1: Behavior tools 4→1
- P2: Scratchpad split 1→2 (scratchpad + task)
- Net: 57→50 registered tools

## Execution Status

### ✅ ALL COMPLETE
Every item from the original refactor roadmap, revival plan, and tool consolidation is done.

- **P0: Context tools (10→5)** — merged into `context_inspect`, `context_compress`, `context_navigate`
- **P1: Behavior tools (4→1)** — merged into single `behavior` tool
- **P2: Scratchpad split (1→2)** — extracted `task` tool from scratchpad monolith
- **Phase 1.4: Conflict feedback loop** — `register-message-end.ts` tracks resolution
- **Phase 5: Enforcement dispatch split** — 6 focused turn-end handlers in `analysis/`
- **Phase 4.1: Any cast reduction** — zero `as any` in `src/extensions/` + `src/lib/`
- **T4, T8, T5, T6, T7** — various infrastructure improvements
- **P4: Memory surface investigation** — audited, keep as-is

---

## How to Find This Later

```bash
# In-repo document
cat CONSOLIDATED-PLAN.md

# Memory recall
memory_recall("pi-braid consolidated plan tool audit")

# Session search
grep -r "consolidated plan" ~/.pi/agent/sessions/*.jsonl
```
