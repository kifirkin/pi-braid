# Extension: scratchpad

**Status**: ✅ Working
**Tests**: None
**Version**: v0.5.x

## Purpose

Structured session memory — the agent's "working memory" for goals, plans, decisions, tasks, notes, and learnings. Provides the `scratchpad` tool with 20+ actions for structured state management.

## Architecture

Module-level session-scoped state with 7 collections:
- Goal, plan, decisions, hypotheses, notes, constraints, learnings
- Task management with priorities, dependencies, and status tracking
- Progress tracking via phase/mode indicators

## Events Handled

| Event | Handler |
|-------|---------|
| `session_start` | Reset all scratchpad state, initialize fresh session |
| `turn_end` | Auto-persist learnings if pending |

## Tools

| Tool | Description |
|------|-------------|
| `scratchpad` | 20+ actions: `read` (full state), `set_goal`, `add_plan`, `mark_done`, `add_decision`, `add_note`, `add_constraint`, `add_learning`, `persist_learnings`, `elevate_to_goal`, `elevate_to_plan`, `task_add`, `task_list`, `task_complete`, `task_fail`, `task_next`, `task_remove`, `task_stats`, `task_clear`, `update_session` |

## Key Patterns

- **Task superset**: Scratchpad's task management (task_add/list/complete/fail/next) is a superset of the deprecated task-queue library. All standalone task tools removed in favor of scratchpad.
- **Structured persistence**: Goals have priority (0-10) + success criteria + dependencies. Plans are ordered lists of steps. Tasks track status, dependencies, and priorities.
- **Phase tracking**: `update_session(phase, mode)` sets the current agent phase (exploring, planning, implementing, etc.) and mode (normal, deep_think, recovery).
- **Constraint management**: Constraints have type (blocker/warning/note), TTL expiry, and can be removed individually.
