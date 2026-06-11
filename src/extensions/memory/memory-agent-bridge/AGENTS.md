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
- The `explore_paths` tool — spawns parallel sub-agents to
  investigate hypotheses concurrently (different from subagent API).

## Tools exposed

| Tool             | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `memory_store`   | Save a memory entry (delegates to lib/memory)                  |
| `memory_recall`  | Search/list/get memories (delegates to lib/memory)             |
| `memory_episodes`| Browse episodes (delegates to three-memory-stores)             |
| `memory_heuristics` | Inspect/manage heuristic rules                              |
| `explore_paths`  | Parallel sub-agent exploration of root causes                  |

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
