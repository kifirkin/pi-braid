<!-- status: current -->

# Timer Extension

Non-blocking Pomodoro-style reminders. Agent sets a timer, continues working, gets a reminder when it fires.

## Public API

All exported from `extensions/tools/timer/index.ts`:

| Function                                      | Purpose                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduleTimer(delayMs, reason, tag?, wake?)` | Schedule a timer. Returns timer ID. `wake=true` makes the fire whisper auto-resume the agent (used by post-compaction resume timer). |
| `cancelTimer(id)`                             | Cancel a timer by ID.                                                                                                                |
| `cancelTimersByTag(tag)`                      | Cancel all timers matching a tag. Returns count cancelled.                                                                           |
| `onTimerFire(handler)`                        | Subscribe to fire events. Returns unsubscribe function.                                                                              |

## Wake flag (`triggerTurn` contract)

| `wake`           | `triggerTurn` | When to use                                                                                                                                      |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `true` (default) | `true`        | User-scheduled reminders (`timer` action=set). The agent scheduled it expecting a wake-up. Safe because the busy guard prevents mid-tool firing. |
| `false`          | `false`       | Background heartbeats and silent reminders. Visible in TUI but does not force a new turn.                                                        |

**Default is `wake: true`.** This is the principle: if the user (or the agent) scheduled a timer, they expect to be woken when it fires. Pass `wake: false` explicitly for silent reminders.

The post-compaction stack overflow was caused by `triggerTurn: true` firing **mid-tool-execution**. The fix is the **busy guard** (below), not removing the auto-resume. The resume path needs auto-resume; user timers want it.

## Tag conventions

| Tag                      | Set by                           | Cancelled on                                                  |
| ------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `compaction-resume`      | `context_compress` tool          | New `context_compress`, new `auto-compact`, `session_compact` |
| `auto-compaction-resume` | `context-lifecycle` auto-compact | New `context_compress`, new `auto-compact`, `session_compact` |
| `<user-tag>`             | `timer` action=set               | `timer` action=cancel only                                    |

**Always cancel stale resume tags** when scheduling a new one - the `timers` Map is process-global and never garbage-collected. Without explicit cancellation, an old resume timer can fire during a later, unrelated TURN_END and produce a misplaced `[timer]` whisper (the "strange order" issue).

## Whisper contract

Timer fires deliver a `[timer] <reason>` whisper via `sendTrackedMessage` with:

- `priorityFromSource("timer/fire")` maps to **critical** (not high). Critical
  bypasses `WHISPER_CAPS.high` so the timer whisper reaches the agent even
  in a degraded turn with 3+ high-priority whispers already fired. The
  per-source cap of 2 still applies. See commit 79fd88e9 and
  `test/runtime/lib/test-timer-fire-suppression.mjs` for the regression.

- `customType: "timer"`
- `deliverAs: "steer"`, `triggerTurn: timer.wake === true` (see Wake flag above)
- `details._braidInjected: true`, `details._braidSource: "timer/fire"`, `details.timerId`, `details.wake`

The whisper survives compaction (via `_braidInjected`), matching the `[enforcement]` contract. See `test/runtime/lib/test-post-compaction-fixes.mjs` for the regression test on the triggerTurn derivation.

## Busy guard

The 1s `setInterval` poller bails while the agent is mid-tool-execution. This prevents whisper injection during a tool call, which was the root cause of the post-compaction stack overflow (whisper → synchronous re-entry → stack overflow).

**Busy guard lifecycle (current design):**

| Event                               | `poller.busy` | Fires expired timers?       |
| ----------------------------------- | ------------- | --------------------------- |
| `TOOL_CALL` (tool starts)           | `true`        | No (tool is running)        |
| `TOOL_EXECUTION_END` (tool returns) | `false`       | **Yes (primary fire path)** |
| `TURN_END` (turn ends)              | `false`       | Yes (backup)                |

**Why `TOOL_EXECUTION_END` and not `TURN_END` for the primary path:**

An earlier design used `TURN_END` to clear busy. This had a bug: a long-running tool (e.g., `bash` with `sleep 60`) followed by a long LLM thinking phase kept `busy = true` for the entire turn. A 30s timer set just before the slow tool would be stuck waiting for `turn_end` (which might be minutes away if the LLM is thinking), even though the actual tool was long done. The user saw "timer didn't fire" even though the tool was complete.

The correct guard is per-tool-execution:

- `tool_call` → busy=true (tool is starting)
- `tool_execution_end` → busy=false (tool returned) + fire expired timers
- `turn_end` → busy=false + fire expired timers (safety net for turns with no tools)

This is still safe against the post-compaction stack overflow because it blocks whisper injection only during actual tool execution, not during LLM thinking (which can't chain into synchronous re-entry).

## Local Contracts

- Timer state is module-level (`timerManager.timers` is a `Map`). It survives compaction but is reset only on `session_shutdown`.
- `TimerPoller.piRef` is the most recently registered pi instance. If a new session starts, the old reference is replaced.
- The poller runs as a single `setInterval` for the whole process; not per-session.
