# Timer Extension

Non-blocking Pomodoro-style reminders. Agent sets a timer, continues working, gets a reminder when it fires.

## Public API

All exported from `extensions/tools/timer/index.ts`:

| Function | Purpose |
|---|---|
| `scheduleTimer(delayMs, reason, tag?)` | Schedule a timer. Returns timer ID. |
| `cancelTimer(id)` | Cancel a timer by ID. |
| `cancelTimersByTag(tag)` | Cancel all timers matching a tag. Returns count cancelled. |
| `onTimerFire(handler)` | Subscribe to fire events. Returns unsubscribe function. |

## Tag conventions

| Tag | Set by | Cancelled on |
|---|---|---|
| `compaction-resume` | `context_compress` tool | New `context_compress`, new `auto-compact`, `session_compact` |
| `auto-compaction-resume` | `context-lifecycle` auto-compact | New `context_compress`, new `auto-compact`, `session_compact` |
| `<user-tag>` | `timer_set` tool | `timer_cancel` tool only |

**Always cancel stale resume tags** when scheduling a new one — the `timers` Map is process-global and never garbage-collected. Without explicit cancellation, an old resume timer can fire during a later, unrelated TURN_END and produce a misplaced `[timer]` whisper (the "strange order" issue).

## Whisper contract

Timer fires deliver a `[timer] <reason>` whisper via `sendTrackedMessage` with:

- `customType: "timer"`
- `deliverAs: "steer"`, **`triggerTurn: false`**
- `details._braidInjected: true`, `details._braidSource: "timer/fire"`, `details.timerId`

`triggerTurn: false` matches the `[enforcement]` whisper contract. **Do not** set it to `true` — the host would start a new turn mid-tool-execution, causing re-entrant `before_agent_start` calls and a stack overflow. See `test/runtime/lib/test-post-compaction-fixes.mjs` for the regression test.

## Busy guard

The 1s `setInterval` poller bails while the agent is mid-tool-execution. `TOOL_CALL` sets `poller.busy = true`; `TURN_END` clears it. The `TURN_END` handler is the fallback fire path (catches anything the poll missed while busy).

## Local Contracts

- Timer state is module-level (`timerManager.timers` is a `Map`). It survives compaction but is reset only on `session_shutdown`.
- `TimerPoller.piRef` is the most recently registered pi instance. If a new session starts, the old reference is replaced.
- The poller runs as a single `setInterval` for the whole process; not per-session.
