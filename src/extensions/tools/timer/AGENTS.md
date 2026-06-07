# Timer Extension

Non-blocking Pomodoro-style reminders. Agent sets a timer, continues working, gets a reminder when it fires.

## Public API

All exported from `extensions/tools/timer/index.ts`:

| Function | Purpose |
|---|---|
| `scheduleTimer(delayMs, reason, tag?, wake?)` | Schedule a timer. Returns timer ID. `wake=true` makes the fire whisper auto-resume the agent (used by post-compaction resume timer). |
| `cancelTimer(id)` | Cancel a timer by ID. |
| `cancelTimersByTag(tag)` | Cancel all timers matching a tag. Returns count cancelled. |
| `onTimerFire(handler)` | Subscribe to fire events. Returns unsubscribe function. |

## Wake flag (`triggerTurn` contract)

| `wake` | `triggerTurn` | When to use |
|---|---|---|
| `true` | `true` | Post-compaction resume timer. Auto-wakes the agent if it didn't continue on its own. Safe because the busy guard prevents mid-tool firing. |
| `false` (default) | `false` | User-scheduled timers ("check the build in 60s"). Whisper is visible but does not force a new turn. |

The post-compaction stack overflow was caused by `triggerTurn: true` firing **mid-tool-execution**. The fix is the **busy guard** (below), not removing the auto-resume. The resume path needs auto-resume; user timers don't.

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
- `deliverAs: "steer"`, `triggerTurn: timer.wake === true` (see Wake flag above)
- `details._braidInjected: true`, `details._braidSource: "timer/fire"`, `details.timerId`, `details.wake`

The whisper survives compaction (via `_braidInjected`), matching the `[enforcement]` contract. See `test/runtime/lib/test-post-compaction-fixes.mjs` for the regression test on the triggerTurn derivation.

## Busy guard

The 1s `setInterval` poller bails while the agent is mid-tool-execution. `TOOL_CALL` sets `poller.busy = true`; `TURN_END` clears it. The `TURN_END` handler is the fallback fire path (catches anything the poll missed while busy).

## Local Contracts

- Timer state is module-level (`timerManager.timers` is a `Map`). It survives compaction but is reset only on `session_shutdown`.
- `TimerPoller.piRef` is the most recently registered pi instance. If a new session starts, the old reference is replaced.
- The poller runs as a single `setInterval` for the whole process; not per-session.
