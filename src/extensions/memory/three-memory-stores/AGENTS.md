# Three-Memory-Stores Extension

The persistent memory system. Stores agent knowledge across three
complementary memory tiers, all session-scoped but with cross-session
promotion paths.

## Architecture

| File              | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `index.ts`        | Extension entry point; tool registrations and event listeners                            |
| `types.ts`        | Type definitions for MemoryRecord, MemoryType, Episode                                   |
| `heuristics.ts`   | BUILTIN_HEURISTICS: 7 hand-coded episodic rules for the lightweight `memory_store` tool   |
| `episodes.ts`     | Episode storage: how a chain of tool calls becomes an episodic memory                    |
| `tool-reliability.ts` | Tracks per-tool success rates; contributes to cross-session `episodic` memory      |

## Three memory tiers

| Tier           | Purpose                                                   | Lifetime          |
| -------------- | --------------------------------------------------------- | ----------------- |
| `episodic`     | Specific events: "tool X failed 3 times on Y"             | Session + cross-session promotion |
| `semantic`     | General knowledge: "Project X uses pattern Y"             | Cross-session    |
| `procedural`   | How-to: "to do X, follow steps 1, 2, 3"                   | Cross-session    |

## Tools exposed

| Tool                | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `memory_store`      | Store a new memory (heuristic auto-categorizes type)          |
| `memory_recall`     | Search memories (action=search|list|get)                       |
| `memory_episodes`   | Browse episodes (chronological or by tool)                    |
| `memory_heuristics` | Read/manipulate the heuristic rules                           |

## Heuristic tier (BUILTIN_HEURISTICS)

7 hand-coded rules in `heuristics.ts` decide what type a new memory
should be. The rules are keyword-fragile but cheap (Tier 1). For
non-matching cases, the LLM-based classifier in `critic-registry.ts`
takes over (Tier 2). The rules were audited in 2026-06-10 and kept
intentionally as a fast-path.

## Cross-session promotion

`semantic` and `procedural` memories are written to disk on
`session_shutdown` and loaded on the next session. The `episodic`
tier promotes high-relevance episodes to `semantic` if the agent
references them 3+ times across sessions.

## Event-bus contract

| Emits           | Listens to    |
| --------------- | ------------- |
| `memory_evict`  | (none - passive emit on eviction) |

## Local Contracts

- **Session-scoped state** via `getExtensionState(ctx, key, factory)`
  for in-memory caches. Disk persistence in `BRAID_DATA_DIR/memory/`.
- **Three-tier promotion** is automatic but agent-overridable: the
  agent can pin a memory to a specific tier via the `type` field.
- **Heuristic tier is hand-coded and intentionally fragile** - kept
  as a fast-path; LLM critic is the fallback.
