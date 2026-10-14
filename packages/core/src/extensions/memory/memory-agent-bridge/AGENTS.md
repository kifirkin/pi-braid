<!-- status: current -->

# Memory Agent Bridge Extension

The agent-facing interface to cognitive memory. Provides tools for
the LLM to store, recall, and search memories; manages the
session-scoped state and bridges to `lib/memory/index.ts` (the
storage layer).

## Architecture

| File                   | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `index.ts`             | Extension entry point; MemoryBridgeStats, SESSION_SHUTDOWN, tool wiring     |
| `explore-paths.ts`     | The `explore_paths` tool: per-hypothesis file search + first-lines evidence |
| `memory-store-tool.ts` | The `memory_store` tool: persist insights to long-term memory               |
| `memory-tool.ts`       | The unified `memory` tool: recall, episodes, heuristics (9 actions)         |
| `conflict-qa-tool.ts`  | The `conflict_qa` tool: view/resolve knowledge conflicts                    |

## What this extension owns

- The LLM-callable tool surface for memory (the three-memory-stores
  extension owns the _storage_ layer; this extension owns the
  _tool shape_ and _agent-facing semantics_).
- The `explore_paths` tool - per-hypothesis local search
  (`find`/`grep` + first-lines `head`) run concurrently; no sub-agent spawn.
- The unified `memory` tool covering all three memory domains
  (semantic recall, episodic case-based reasoning, procedural
  heuristics). Previously this surface was split across three
  tools (`memory_recall`, `memory_episodes`, `memory_heuristics`) <!-- doc-ref-exempt: consolidated tools named as history -->
  that have now been consolidated.

## Tools exposed

| Tool            | Purpose                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory_store`  | Save a memory entry (delegates to lib/memory)                                                                                                                                                                            |
| `memory`        | Unified read/write across recall (semantic), episodes, heuristics. 9 actions: `recall_search\|recall_list\|recall_get\|episodes_search\|episodes_list\|episodes_add\|heuristics_list\|heuristics_add\|heuristics_evolve` |
| `explore_paths` | Per-hypothesis file search + first-lines evidence (local; session cwd default, explicit `searchRoot` override)                                                                                                           |
| `conflict_qa`   | View/resolve conflict questions from the evidence pool                                                                                                                                                                   |

## Relationship to three-memory-stores

This is the agent-facing surface. three-memory-stores is the storage
backend. The split is intentional: tools are about _how the agent
talks to memory_, storage is about _how memory is organized_.

## Local Contracts

- **Session-scoped state** via `getExtensionState(ctx, key, factory)`
  for the in-memory cache. Disk persistence is in three-memory-stores.
- **Search root**: `explore_paths` searches the session cwd by default; an
  explicit `searchRoot` overrides it (a relative one resolves against the
  session cwd); the package tree this module ships in is only the fallback
  when no session context exists.
- **Parallel local searches**: `explore_paths` runs its candidate
  lookups concurrently (`Promise.all`) as local `find`/`grep`/`head`
  calls; it never spawns sub-agents or invokes the subagent API.
- **No whisper emission**: pure tool surface.
- **Unified `memory` tool action namespace**: flat 9-action enum
  with prefix-by-domain (recall*\*, episodes*\_, heuristics\_\_).
  Mirrors the scratchpad tool's pattern.
