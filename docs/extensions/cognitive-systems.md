# Extension: cognitive-systems

**Status**: ✅ Working
**Tests**: 14 (evidence-pool), 18 (MARS reasoning metrics)
**Version**: v0.8.x

## Purpose

Unified cognitive memory and evidence pool — the agent's long-term memory and hypothesis testing system. Three-memory architecture:

1. **Episodic memory** (`memory_episodes`) — past task solutions and outcomes
2. **Procedural heuristics** (`memory_heuristics`) — adaptive rules that evolve with success/failure
3. **Tool reliability stats** (`memory_tool_stats`) — per-tool reliability by task type

Plus the **evidence pool** — structured evidence tracking with source labeling and automatic conflict detection/resolution (see `lib/evidence-pool.ts` + `lib/conflict-qa.ts`).

## Events Handled

| Event | Handler |
|-------|---------|
| `tool_execution_end` | Store tool outcomes as evidence (via `addEvidence`) for hypotheses and memory operations |
| `message_end` | Detect memory-related usage patterns and trigger MARS reflection triggers |

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store semantic memory with structured content, type, tags, importance, TTL |
| `memory_recall` | Semantic text search across all memories |
| `memory_list` | List recent memories sorted by recency |
| `memory_get` | Get full memory by ID |
| `memory_episodes` | Search/add/list retrospective episodes of past tasks |
| `memory_heuristics` | View and manage adaptive procedural heuristics |
| `memory_tool_stats` | View tool reliability statistics per task type |
| `think` | Record structured thinking with depth, alternatives, confidence calibration |
| `hypothesize` | Structure debugging approach with ranked hypotheses |
| `explore_paths` | Parallel sub-agent exploration of multiple hypotheses (file search + grep + head) |

## MARS Integration

The `think` tool (depth='deep') invokes a utility model for fresh-eyes perspective. The MARS reflector (metacognitive) analyzes tool-use patterns for:
- Tool overuse detection (same tool repeatedly)
- Error recurrence patterns
- Switched-strategy success tracking

## Key Patterns

- **Cognitive Memory** (3 stores): Episodic, heuristic, tool-reliability — each with own storage (JSONL files in `~/.pi/agent/memory/`).
- **Evidence Pool**: `addEvidence()` in `tool_execution_end` → `detectConflictsFor()` → `state.conflicts.push()`. Conflicts tracked via `conflict-qa.ts` with token-overlap and claim-extraction matching.
- **Parallel exploration**: `explore_paths` spawns sub-processes (file find, grep) to investigate hypotheses concurrently.
- **TTL-based eviction**: MAX_OUTCOMES=100, OUTCOME_TTL_MS=30min for sliding window memory.
