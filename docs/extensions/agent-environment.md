# Extension: agent-environment

**Status**: ✅ Working
**Tests**: None (state only)
**Version**: v0.5.x

## Purpose

L1 environmental awareness — provides the agent with runtime context (PID, session duration, turn count, tool timing, machine info) surfaced through:
1. `time_status` tool — explicit time/state queries
2. L1 system prompt injection — automatic context awareness via `gatherL1Environment()`/`formatL1EnvironmentSection()`

Prevents the agent from needing to ask "how long have I been running?" or losing track of session progression.

## Architecture

Pure module-level state (`_state`) gathered in-process. The `gatherL1Environment()` function is consumed by `prompt-builder` for system prompt injection. `formatL1EnvironmentSection()` renders the L1 block.

## Events Handled

| Event | Handler |
|-------|---------|
| `session_start` | Reset all counters and timestamps |
| `message_end` | Increment turn count on assistant messages, update `lastEventTime` on user messages |

## Tools

| Tool | Description |
|------|-------------|
| `time_status` | Action: `status` (full report), `mark` (label current time), `elapsed_since` (time since last event) |

## State

Module-level singleton (`_state`):
```typescript
{
  sessionStart: number,
  lastEventTime: number,
  turnCount: number,
  toolCallStarts: Map<string, number>,
  metrics: { totalToolCalls, totalToolTime, userMessageCount, assistantMessageCount }
}
```

## Key Patterns

- **L1 injection**: `prompt-builder` calls `gatherL1Environment()` → `formatL1EnvironmentSection()` to build the L1 block in the system prompt. No events needed — pure function call.
- **Tool timing**: `toolCallStarts` Map tracks when each tool call began, used to compute average tool duration.
- **OS normalization**: Platform names normalized (`darwin`→`macOS`, `win32`→`Windows`, `linux`→`Linux`) for readability.
