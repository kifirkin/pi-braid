# Extension: three-memory-stores

**Status**: ⚠️ Partial (write-only reads, tool reliability gaps)
**Tests**: 21 tests in `test/memory-stores/`
**Version**: v0.13.0

## Purpose

Three complementary memory stores (Episodes + Heuristics + ToolReliability) based on paper 2604.14475 (Evo-MedAgent). MCQ accuracy: 0.68 → 0.79 with this approach.

## Architecture

| Store | Purpose | API |
|-------|---------|-----|
| Retrospective Episodes | Case-based reasoning from past tasks | `memory_episodes` |
| Adaptive Procedural Heuristics | Priority-tagged rules that evolve | `memory_heuristics` |
| Tool Reliability Controller | Per-tool trustworthiness tracking | `memory_tool_stats` |

## Tools (4)

| Tool | Description |
|------|-------------|
| `memory_episodes` | Search/add/list episodes by task similarity |
| `memory_heuristics` | List/evolve rules matching context |
| `memory_tool_stats` | Tool reliability stats |
| `get-tool-reliability` | Convenience wrapper |

## Events (3)

| Event | Description |
|-------|-------------|
| `tool_execution_end` | Track tool success/failure |
| `agent_end` | Check session start time |
| `session_shutdown` | Cleanup |

## State

```typescript
interface MemoryStoresState {
  episodes: Episode[];
  heuristics: HeuristicRule[];
  toolStats: Map<string, ToolStat>;
  currentSessionTools: string[];
  sessionStartTime: number;
}
```

## Known Issues

- **Write-only reads**: Episode/heuristic search reads from disk but doesn't populate the in-memory stores. Agents search memory successfully but don't benefit from live updates.
- **Tool reliability gaps**: Reliability data is stored but may not reflect actual success rates due to session isolation.
