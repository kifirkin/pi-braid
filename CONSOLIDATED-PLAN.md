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
| ❌ **Conflict Resolution Feedback (Phase 1.4)** | Not started | Wire conflict detection → resolution tracking → whisper feedback loop |
| ❌ **Enforcement God Object Split (Phase 5)** | Partial | 6 turn-end analysis handlers created, but dispatch-turn-end-analysis.ts still interleaves concerns |
| ❌ **Any Cast Reduction (Phase 4.1)** | Partial | 4 remaining in handler-registry.ts (target <10) |
| ❌ **Tool Consolidation (NEW)** | Not started | 57 tools with redundancy and overengineering to address |

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
| **Browser** | 14 | contrib/pi-browser |
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

## Tool Consolidation Plan

### P0: Consolidate context tools (10 → 4)

**Problem**: 10 separately registered tools for context management. The agent has to remember too many command names.

**Plan**:
- `context_snapshot` + `context_audit` + `context_prune` → one `context_inspect` tool with levels (`quick`|`detailed`|`prune`)
- `context_compact` + `context_archive` → one `context_compress` tool with modes (`compact`|`archive`)
- `context_log` + `context_checkout` + `context_tag` → one `context_navigate` tool with actions (`log`|`checkout`|`tag`)
- `context_proposals` + `context_signal` → keep as-is (different concerns)

**Result**: 10 tools → 5 tools.

**Risk**: Low — tools are not called by other code, only by agent.

### P1: Consolidate behavior tools (4 → 1)

**Problem**: 4 tools to set one state value.

**Plan**:
- Merge `activate_behavior`, `deactivate_behavior`, `get_active_behaviors`, `activate_mix` → one `behavior` tool with action enum.

**Result**: 4 tools → 1 tool.

**Risk**: None.

### P2: Split scratchpad (1 tool → 3 tools)

**Problem**: 25 sub-actions buried inside one tool description. The agent never discovers them.

**Plan**:
- `scratchpad` — keep for goal/plan/decision/note tracking (the core use case)
- Extract task operations → `task` tool with actions (`add`, `list`, `complete`, `fail`, `next`, `remove`, `stats`, `clear`)

**Result**: 1 overloaded tool → 2 focused tools.

**Risk**: Medium — some agents rely on existing scratchpad for task tracking.

### P3: Verify rationalization

**Problem**: 3 verify tools with overlapping scope.

**Plan**:
- `verify` (metacognition) — keep as primary verification tool (takes criteria arrays, auto-generates if omitted)
- `verify_claim` (cognitive/verification) — keep as specialized claim checker (calls LLM via classify())
- `verify_decomposition` — could merge into `verify` as a criteria mode, but separate tool is cleaner

**Result**: Keep all 3 but add cross-references in descriptions so agent knows when to use which.

**Risk**: None.

### P4: Memory unification

**Problem**: 10 memory tools spread across 3 extensions.

**Plan**:
- Audit whether `memory_episodes` + `memory_heuristics` + `memory_tool_stats` from three-memory-stores are actually used by the agent or are internal plumbing
- If internal, hide them from agent tool listing (keep registered but don't advertise)
- `memory_store`/`recall`/`list`/`get` + `session_search`/`query` are distinct enough to keep

**Result**: Investigate and possibly reduce surface.

### P5: Timer + singleton merge

**Problem**: `auto_singleton_*` is a specialized timer with different semantics (one-shot, auto-renewing).

**Plan**: Keep separate — they solve different problems. But add cross-references in descriptions.

**Result**: No structural change, just documentation.

---

## Remaining Refactoring Work

### Conflict Resolution Feedback Loop (Phase 1.4)

**Problem**: `evidence-pool.ts` + `conflict-qa.ts` detect and classify conflicts, but no feedback loop exists to track whether the agent resolved them.

**Action**:
1. When conflict QA is generated, store its ID in enforcement state
2. On `message_end`, check if agent's response addressed the conflict (keyword matching)
3. If resolved, mark complete via `resolveQA()`
4. If unresolved after 5 turns, escalate whisper severity

**Files**: `conflict-qa.ts`, `evidence-pool.ts`, `register-message-end.ts`

### Enforcement God Object Final Split (Phase 5)

**Problem**: `dispatch-turn-end-analysis.ts` still interleaves 6 concerns in one ~170-line function.

**Action**: Split into independently registered turn-end handlers:
- drift-handler, bpe-handler, mars-handler, dreamer-handler, reflection-handler, feedback-handler

**Files**: `handlers/analysis/` (already started — 6 files exist, just need the dispatch function to call them directly instead of inline)

### Any Cast Reduction (Phase 4.1)

**Target**: 4 remaining `any` casts in `handler-registry.ts`. Replace with typed overloads.

---

## Execution Order

```
IMMEDIATELY (this session)
┌────────────────────────────────────────────────────────────┐
│ P0: context_* consolidation (10→5)                        │
│ P1: behavior consolidation (4→1)                          │
└────────────────────────────────────────────────────────────┘

NEXT SESSION
┌────────────────────────────────────────────────────────────┐
│ P2: scratchpad split (task ops extraction)                 │
│ Phase 1.4: Conflict resolution feedback loop                │
└────────────────────────────────────────────────────────────┘

FOLLOW-UP
┌────────────────────────────────────────────────────────────┐
│ P4: Memory surface investigation                          │
│ Phase 5: Enforcement dispatch split                        │
│ Phase 4.1: Any cast reduction                              │
└────────────────────────────────────────────────────────────┘

ONGOING
┌────────────────────────────────────────────────────────────┐
│ Maintain code-refactoring skill with new patterns          │
│ Keep tool descriptions cross-referenced                    │
└────────────────────────────────────────────────────────────┘
```

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
