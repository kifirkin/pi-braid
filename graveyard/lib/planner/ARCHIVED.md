# planner.ts — Plan-Execute-Review Cycle

**Origin**: initial commit — same first-wave prototype as goal-manager.

**What it was supposed to do**: Provide `Plan`, `PlanStep`, `PlanStatus` types with a planning
cycle for strategic decomposition before execution. Based on the same never-written
`docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md`.

**Why it was abandoned**: The planner extension tools (`plan_with_budget`, `check_budget`,
`set_budget`) were **removed on 2026-05-04** — they were too verbose, filled context, and the
agent rarely used them. The library file (`planner.ts`) was left behind as an orphan. The
metacognition `think` tool provides structured reasoning without the overhead of a formal plan.

**What replaced it**: `src/extensions/core/metacognition/` — `think` tool for structured reasoning
with depth levels (quick/standard/deep), hypothesis generation, and verification.

**Tests**: `test/runtime/test-planner.mjs` — was a removal-verification test (checks planner dir
no longer exists). Deleted as the file is now archived.

**Docs**: `docs/lib/planner.md` — moved to graveyard.

**Git history**: `git log --oneline --follow src/lib/planner.ts`
- `18a3d4b4` chore: spaces not tabs + fmt test fixes
- `65781910` initial commit