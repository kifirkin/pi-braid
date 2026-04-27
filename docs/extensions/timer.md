# Extension: timer

**Status**: ✅ Working
**Tests**: None
**Version**: v0.9.x

## Purpose

Non-blocking timers — sets timed reminders that fire at the specified delay and inject a reminder message. Useful for builds, background processes, pomodoro cycles, and escalation chains.

## Architecture

In-memory timer store with `setTimeout`-based firing. Timers expire after firing — only active (non-expired) timers shown in `timer_list`. Max 1 hour (3600s).

## Events Handled

| Event | Handler |
|-------|---------|
| `tool_execution_start` | Check for expired timers and deliver pending reminders |

## Tools

| Tool | Description |
|------|-------------|
| `timer_set` | Set a timer. Params: `delay_seconds` (1-3600), `reason` (description), `tag` (optional). Returns immediately — reminder fires asynchronously. |
| `timer_list` | List all active (non-expired) timers |
| `timer_cancel` | Cancel a timer by ID before it fires |

## Key Patterns

- **Non-blocking**: `timer_set` returns immediately — the timer fires asynchronously. The agent doesn't wait.
- **Reminder injection**: When a timer fires, a reminder is injected into the next `tool_execution_start` event. This means the agent sees the reminder on its next tool call.
- **One-shot**: Timers fire exactly once and are removed. No recurring timers.
- **Safety cap**: Max delay 3600s (1 hour) prevents runaway timers.
