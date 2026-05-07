# Extension: analytics

**Status**: ✅ Working
**Tests**: None
**Version**: v0.8.x

## Purpose

Tool usage analytics — tracks tool call counts, durations, success/failure rates, and sequences per session. Persists to `~/.pi/logs/braid-metrics.jsonl` for cross-session analysis.

Provides `/analytics` (current session) and `/analytics:all` (historical) commands, plus programmatic `get-session-metrics` and `get-tool-reliability` tools.

## R9 Integration

A/B experiment variant tracking (`analytics:setVariant` command). Variant name (`control` by default) is exported in every metrics JSONL entry.

## Events Handled

| Event                  | Handler                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `session_start`        | Initialize session ID, clear pending tool calls, ensure logs directory |
| `tool_execution_start` | Track start time + tool name per `toolCallId`                          |
| `tool_execution_end`   | Record duration, success/failure, update metrics                       |
| `session_shutdown`     | Flush remaining metrics to disk                                        |

## Tools

| Tool                   | Description                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `get-session-metrics`  | Structured JSON: tool counts, durations, sequences, success rates for current session |
| `get-tool-reliability` | Historical tool success rates from analytics export file                              |

## Commands

| Command                 | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `/analytics`            | Show current session: tool counts, avg duration, common sequences |
| `/analytics:all`        | Show all historical sessions aggregated: top tools, sequences     |
| `/analytics:setVariant` | Set A/B experiment variant name for this session                  |

## State

Module-level singleton (`state`):

```typescript
{
  sessionId: string,
  sessionStartTime: number,
  toolMetrics: Map<string, ToolMetrics>,
  toolCallSequence: string[],
  storagePath: string,
  abVariant: string
}
```

## Key Patterns

- **Timing via paired events**: `tool_execution_start`/`tool_execution_end` pair tracks actual call duration, not just sequence.
- **Disk persistence**: Every session writes one JSONL entry at `session_shutdown`. Historical data reloaded from same file.
- **Tool sequence mining**: Sliding window of length 2 (default) extracts common patterns like `"read → edit"` with support threshold.
