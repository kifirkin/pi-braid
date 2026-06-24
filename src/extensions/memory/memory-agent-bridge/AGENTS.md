<!-- status: current -->

# Memory Agent Bridge Extension

The agent-facing interface to cognitive memory. Provides tools for
the LLM to store, recall, and search memories; manages the
session-scoped state and bridges to `lib/memory/index.ts` (the
storage layer).

## Architecture

| File               | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `index.ts`         | Extension entry point; tool registrations and event handlers         |
| `explore-paths.ts` | The `explore_paths` tool: parallel sub-agent exploration             |

## What this extension owns

- The LLM-callable tool surface for memory (the three-memory-stores
  extension owns the *storage* layer; this extension owns the
  *tool shape* and *agent-facing semantics*).
- The `explore_paths` tool - spawns parallel sub-agents to
  investigate hypotheses concurrently (different from subagent API).
- The unified `memory` tool covering all three memory domains
  (semantic recall, episodic case-based reasoning, procedural
  heuristics). Previously this surface was split across three
  tools (`memory_recall`, `memory_episodes`, `memory_heuristics`)
  that have now been consolidated.

## Tools exposed

| Tool             | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `memory_store`   | Save a memory entry (delegates to lib/memory)                  |
| `memory`         | Unified read/write across recall (semantic), episodes, heuristics. 9 actions: `recall_search\|recall_list\|recall_get\|episodes_search\|episodes_list\|episodes_add\|heuristics_list\|heuristics_add\|heuristics_evolve` |
| `explore_paths`  | Parallel sub-agent exploration of root causes                  |
| `conflict_qa`    | View/resolve conflict questions from the evidence pool         |

## Relationship to three-memory-stores

This is the agent-facing surface. three-memory-stores is the storage
backend. The split is intentional: tools are about *how the agent
talks to memory*, storage is about *how memory is organized*.

## Local Contracts

- **Session-scoped state** via `getExtensionState(ctx, key, factory)`
  for the in-memory cache. Disk persistence is in three-memory-stores.
- **Parallel sub-agents** in `explore_paths` are spawned via the
  subagent API (`BRAID_MODULES=+<module>` toggle), not via OS
  processes. See `src/loader/loader.ts` for the subagent mechanism.
- **No whisper emission**: pure tool surface.
- **Unified `memory` tool action namespace**: flat 9-action enum
  with prefix-by-domain (recall_*, episodes_*, heuristics_*).
  Mirrors the scratchpad tool's pattern.
