# lib/timer-bus.ts

**Purpose**: Timer event bus — non-blocking timers that fire asynchronously. Powers the `timer` extension's `timer_set`/`timer_list`/`timer_cancel` tools.

## Key Functions

| Function                          | Description                                 |
| --------------------------------- | ------------------------------------------- |
| `setTimer(delayMs, reason, tag?)` | Set a non-blocking timer. Returns timer ID. |
| `cancelTimer(id)`                 | Cancel a timer before it fires              |
| `listTimers()`                    | List all active (non-expired) timers        |
| `onTimerFired(callback)`          | Register callback for timer fire events     |

## Key Patterns

- **Non-blocking**: `setTimer` returns immediately — the timer fires asynchronously via `setTimeout`.
- **One-shot**: Timers fire exactly once. No recurring timers.
- **Callback pattern**: `onTimerFired` registers callbacks that fire when any timer expires. The timer extension uses this to inject reminder messages.
- **Safety cap**: Max delay 3,600,000ms (1 hour).
