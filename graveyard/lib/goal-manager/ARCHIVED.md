# goal-manager.ts — Hierarchical Goal Tracking

**Origin**: initial commit (`65781910) — part of the first rapid-prototyping wave alongside think/plan/enforcement.

**What it was supposed to do**: Provide a `GoalManager` class with hierarchical goal decomposition,
dependency resolution, status tracking (pending → active → completed/failed), and file persistence.
Based on a planned `docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md` that was never written.

**Why it was abandoned**: Never wired to any extension. The `pi-registerTool()` call that would
have exposed it to the agent was never written. The scratchpad extension's task management now
provides the same capabilities through `task_add`, `task_list`, `task_complete` tools.

**What replaced it**: `src/extensions/core/scratchpad/` — task management with priorities,
dependencies, and status tracking. Simpler, agent-facing, actually in production.

**Tests**: `test/runtime/test-goal-manager.mjs` — was actively testing the dead `GoalManager` class.
Deleted — the class has no consumers.

**Git history**: `git log --oneline --follow src/lib/goal-manager.ts`
- `18a3d4b4` chore: spaces not tabs + fmt test fixes
- `65781910` initial commit