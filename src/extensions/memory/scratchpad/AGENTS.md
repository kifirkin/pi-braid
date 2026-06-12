# src/extensions/memory/scratchpad/ - Working Memory

The agent's working memory: goals, plans, decisions, hypotheses, notes,
learnings, constraints. Persists to per-project file so state survives
compaction and even across sessions.

## Distinction from `memory/` data layer

- `lib/memory/` = the long-term engine (episodes, semantic memory, etc).
- `extensions/memory/` = the agent-facing tools (memory_store, memory, ...)
- `extensions/memory/scratchpad/` = the WORKING memory tool (in-session, structured)

The scratchpad is a state tool, not a knowledge tool. It's where the agent
writes "what I'm doing right now" not "what I've learned in general."

## Tool

| Tool | Actions | Purpose |
|---|---|---|
| `scratchpad` | set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, add_learning, ... | Structured session state management. |

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry point. |
| `persistence.ts` | Read/write the per-project scratchpad file. |
| `types.ts` | TypeScript types for scratchpad items. |
