# Extension: error-capture

**Status**: ✅ Working
**Tests**: None (file I/O, hard to unit test)
**Version**: v0.4.x

## Purpose

Auto-captures and logs extension errors with contextual metadata (source, turn count, stack trace). Provides 4 query tools and automatic TTL-based cleanup.

## Architecture

Persistent JSONL storage at `~/.pi/agent/errors/error-log.jsonl` with in-memory cache for fast querying. Errors auto-pruned when exceeding MAX_ERRORS (100) — keeps the most recent.

## Events Handled

| Event | Handler |
|-------|---------|
| `tool_execution_end` | Capture errors when `isError=true`. Extracts source from tool metadata, captures turn count from ctx |
| `turn_end` | Scan for remaining erorred tool calls from previous turn |

## Tools

| Tool | Description |
|------|-------------|
| `error_list` | List recent errors with counts (optional: filter by source, unhandled only) |
| `error_get` | Get detailed error by ID — full stack, context, timestamp |
| `error_clear` | Mark an error as handled (updates `handled:true` in JSONL) |
| `error_stats` | Error statistics by source and type |

## Key Patterns

- **Dual capture**: Errors caught both from tool execution results (isError) and end-of-turn scan for leftover errors.
- **Structured storage**: JSONL format with `ErrorEntry` schema — id, timestamp, source, message, stack, context, handled.
- **Auto-prune**: On each save, if >100 errors, slice to keep only the 100 most recent.
- **Overwrite on clear**: `error_clear` rewrites the full JSONL file with the updated entry — not append. For low-frequency operations this is acceptable.
