<!-- status: current -->

# Timer Extension

Non-blocking Pomodoro-style reminders. Agent sets a timer, continues working, gets a reminder when it fires.

## Public API

All exported from `./index.ts`:

| Function                                                           | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduleTimer(delayMs, reason, tag?, wake?, intervalMs?, count?)` | Schedule a timer. Returns timer ID. `wake=true` makes the fire whisper auto-resume the agent. `intervalMs` makes it recur (see below); `count` bounds a recurring timer to N total fires. |
| `cancelTimer(id)`                                                  | Cancel a timer by ID.                                                                                                                                                                     |
| `cancelTimersByTag(tag)`                                           | Cancel all timers matching a tag. Returns count cancelled.                                                                                                                                |
| `onTimerFire(handler)`                                             | Subscribe to fire events. Returns unsubscribe function.                                                                                                                                   |

## Recurring timers (`intervalMs`)

Pass `intervalMs` to `scheduleTimer` to make a timer re-fire on a cadence until
cancelled (round 21j). On expiry `TimerManager.checkExpired` does **not** remove
the timer; it re-arms the live map entry to
`Math.max(prev firesAt + intervalMs, now + intervalMs)` (one fire per tick even
if many periods passed - no catch-up burst) and the fire path persists the
re-arm to disk (`rearmTimerOnDisk`) instead of `removeTimerFromDisk`. The
tool `timer` action=set exposes this as `interval_seconds`; every timer -
recurring included - wakes by default (the old
recurring-silent default made recurring fires arrive only as whispers
attached to the NEXT user turn, stacking overnight); pass `wake: false`
for a silent advisory reminder (baby-sit/heartbeat cadences). `cancelTimer`/
`cancelTimersByTag` stop the recurrence (the timer leaves the map + disk)
and retire the fire: no redelivery or armed wake ladder outlives a cancel
(see Failed-wake retry below).
Persisted recurrence survives a reload: `recoverPersistedTimers` threads
`intervalMs` through `restoreTimer`.

**Bounded recurrence (`count`, round 21q):** pass an optional `count` (= total
fires) alongside `intervalMs` to make a recurring timer STOP ITSELF after N
fires instead of repeating forever - the native answer to a finite baby-sit
window ("check every 60s, 5 times, then stop"). `checkExpired` tracks a `fires`
counter (delivered on the snapshot; persisted with the timer) and, once
`fires >= count`, deletes the timer exactly like a one-shot - no re-arm, and
the fire path removes the disk entry so it cannot resurrect on reload. An
unbounded recurring timer (no `count`) stays exactly as in round 21j. `timer`
action=set exposes this as `count`; `timer` action=list shows repeat state as
`repeat fires/count` (e.g. `2/5` bounded, `2/∞` unbounded). `count` is
ill-defined without `interval_seconds` (a one-shot fires once by definition) -
the tool rejects that combination.

The two fire sources (poller `setTimeout(0)` tick and `fireExpired` from
`TOOL_EXECUTION_END`/`TURN_END`) cannot double-advance a re-arming timer:
`checkExpired` re-arms synchronously/in-place inside the single shared
`TimerManager` store, so a second call in the same tick sees the future
`firesAt` and returns nothing.

## Wake flag (`triggerTurn` contract)

| `wake`             | `triggerTurn` | When to use                                                                                                                                                       |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)   | `true`        | ALL timers by default - user-scheduled one-shots AND recurring. The agent scheduled it expecting a wake-up. Safe because the busy guard prevents mid-tool firing. |
| `false` (explicit) | `false`       | Background heartbeats and silent reminders. Visible in TUI but does not force a new turn.                                                                         |

**Default is `wake: true` for every tool-surface timer (recurring included).** This is the principle: if the user (or the agent) scheduled a timer, they expect to be woken when it fires. Pass `wake: false` explicitly for silent reminders.

## Failed-wake retry + recovered-fire deferral

`wake-retry.ts` (`WakeRetryQueue`, singleton `wakeRetryQueue`) closes two
loss modes:

1. **Failed wake-fire retry**: every wake fire is tracked (`trackWake`) when
   delivered. `agent_end` records whether the run FAILED (last assistant
   `stopReason === "error"` - provider 401/413/5xx; `aborted` counts as
   delivered, content is already in history). `agent_settled` (pi-core fires
   it in the `prompt()` finally - after auto-retries/compaction, even for
   failed runs) resolves the outstanding wakes: a failure re-arms them for
   redelivery with bounded backoff 5s/15s/45s/2m/5m, max 3 redeliveries
   (owner-tunable via `braid.timers.maxWakeAttempts`). Exhausted fires get a
   final silent notice + error log - never silently lost. Delivered-once
   rule: a failed settle re-arms ONLY fires whose injected message is absent
   from the run's messages (agent_end extracts the landed timer ids); a
   newer fire of the same timer cancels the older instance's pending
   redelivery instead of stacking beside it.

   **Every redelivery states its cause verbatim** (`WakeRetryCause`,
   `WakeRetryCause` rendered into `[wake retry N/M: …]`):

   | cause     | armed by                                                         | redelivery text says                                                                                                             |
   | --------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
   | `failed`  | a failed settle                                                  | "an earlier wake-fire turn failed; re-delivered"                                                                                 |
   | `timeout` | the 240s outcome window elapsed with no settle AND no active run | "no turn outcome within the window; re-delivered"                                                                                |
   | `busy`    | a busy-send deferral (`deferBusyWake`)                           | "held while the session was busy; re-delivered" (ladder rung) / "held while the session was busy for X; delivered late" (parked) |

   The outcome timeout is the "no turn ever ran for this wake" path (a
   pre-flight abort emits no event) - it must not claim a failed turn.

   **A spent busy ladder parks, it never drops.** Nothing FAILED while a send
   was held, so the redelivery cap must not lose the fire: the busy deferral
   that would exceed `maxWakeAttempts` marks the outstanding entry
   `parkedBusy` instead of pushing it to the exhausted set. `drainParkedBusy()`
   hands each parked fire to ONE late delivery once the session is not
   positively busy (the settle's own drain first, then the poll tick). The text
   carries the whole hold span of the fire being delivered (`[held while the
session was busy for 5m; delivered late]`), and a log line distinguishes
   that late delivery from a drop. The line is emitted only once the send
   decision is known, so it can never claim a delivery the hold withdrew. A
   send that is deferred again is held again: it arms one fresh rung (the
   backoff restarts at the first tier) and is parked again only once the cap
   is hit again - the end state is always a park. The hold origin belongs to
   the fire: a chain re-track (a redelivery, or the parked handoff of the same
   fire) keeps it, while a newer fire of the same recurring id starts its own,
   so its late-delivery text reports its own hold and not the predecessor
   chain's. The park survives a settle of an unrelated run - `onAgentSettled`
   KEEPS busy-deferred entries instead of clearing them - and a cancel still
   withdraws it (`retireTimer` drops the parked entry; the in-flight guard
   suppresses the deferred send).

   **Long-run grace**: `drainDue` does NOT arm (or count) an outcome timeout
   while an agent run is active for a wake whose send was not busy-deferred
   - a multi-minute run is plausibly the wake's own turn, and arming mid-run
     both redelivers mid-turn and (via the alert feed) pages "wedged loop" for
     a healthy run. The active-run predicate is wired by the timer extension
     from the captured session ctx (`ctx.isIdle()` live-read - wake-gate.ts);
     absent or throwing it degrades to the pre-grace arming (a wake is never
     silently lost), never the grace. The 240s window keeps its job for the
     send that never started a turn: no settle + no run arms `timeout`.

   **Cancel retires the fire**: `cancelTimer` / `cancelTimersByTag` / the
   session-shutdown clear withdraw the fire with the timer - the outstanding
   wake, the armed ladder, parked recovered fires, and the timeout-count
   bookkeeping are dropped (`retireTimer` / `retireTimersWhere`), and the id
   is marked retired so an in-flight send (a fire still inside the
   deferred-delivery window, or a popped retry not yet sent) is suppressed
   at send time. The retirement lives in THIS queue, not the manager: a
   fired one-shot is deleted from the manager map at expiry, so
   `cancelTimer` on it misses the manager lookup - the queue's own records
   are what the cancel reaches (the tool's cancel case reads
   `hasWakeFireState` BEFORE cancelling, so "already fired + ladder
   retired" reports success instead of throwing not-found). Retirement is a
   WITHDRAWAL, not a delivery: it never counts as a delivered wake.

2. **Recovered-fire deferral**: `recoverPersistedTimers` (in this module,
   `recovery.ts`) no longer delivers expired persisted fires INLINE in
   `before_agent_start` (competing-turn bug) - it parks them
   (`deferRecoveredFire`); `flushRecoveredFires()` delivers post-settle from
   the timer extension's `agent_settled` handler (prompt-builder registers an
   idempotent fallback listener), where a `wake:true` fire safely starts its
   own turn.
3. **Owning-session scoping**: the per-project store is shared by every
   session in that project CWD, so `recoverPersistedTimers` processes only
   records whose `sessionId` matches the caller's current session (passed
   from `before_agent_start` via `getSessionIdSafe(ctx)`). Foreign records
   are never delivered, re-armed, or restored into the process; they stay on
   disk verbatim unless pruned by the two-window policy in `recovery.ts`
   (overdue beyond `FOREIGN_TIMER_PRUNE_OVERDUE_MS` AND owner silent in the
   pi session store beyond `FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS`), which

- never deletes a live sibling's record. Called without a session id (the
  direct test surface), the legacy unscoped sweep applies; an unresolvable
  session id (`getSessionIdSafe` sentinel "?") scopes to nothing - every
  record goes inert, the safe direction.

Retries drain on the SAME ticks that fire expired timers (poll tick +
`fireExpired`), via the poller's optional `onDrainWakeRetries` callback -
never on a user turn. The redelivery keeps the `setTimeout(0)` macrotask
discipline (`redeliverWakeFire` defers each send). See
`test/runtime/lib/test-timer-wake-retry.mjs` and
`test/runtime/lib/test-timer-wake-default.mjs`.

### Wake-delivery alert feed (out-of-band dead-wake page)

The queue is where dead wake delivery is KNOWN first; the watchdog engine
(`self/watchdog`) owns the episode latch and the out-of-band escalation
(telegram). Extensions must not import siblings, so `timer/index.ts` sets a
`WakeRetryObserver` on the queue (via `setWakeObserver`) that forwards only
threshold-crossing facts into the feed the watchdog publishes on the
global-state seam (`WATCHDOG_WAKE_DELIVERY_FEED_KEY` in
`src/lib/state/global-state.ts`):

- **Repeated outcome timeouts** for ONE fire - the Nth (default 2,
  `braid.timers.wakeAlert.outcomeTimeouts`) 240s outcome window with no
  settle AND no agent run active. One window is a normal long turn (and the
  long-run grace above suppresses arming mid-run entirely, so the feed only
  sees timeouts the queue itself decided were dead deliveries); a second
  consecutive one is the "wake send lost" signature - a pre-flight abort
  never settles wakes. The watchdog page says exactly that (no settle, no
  active run); a wedged ACTIVE run pages via the watchdog's turn-stall
  condition instead.
- **Exhausted drops** - `notifyExhaustedWake`'s site forwards the drop
  (`recordWakeUndelivered`). If outcome timeouts already opened the episode,
  the watchdog absorbs it (one alert per episode, not one per event). A
  busy-held fire is PARKED, never exhausted (above), so this page is
  unreachable for a mere busy session and stays reserved for genuinely
  unsalvageable failures.
- **Delivered settles** - `onAgentSettled`'s success branch forwards
  `recordWakeDelivered`, which closes the episode with one recovery line.

Gated by `braid.timers.wakeAlert` (default on, `outcomeTimeouts: 2`);
`mode: "off"` forwards nothing - delivery itself (budgets, backoff, caps) is
untouched either way. Observer call sites are guarded: alerting never breaks
retry arming or outcome resolution. Fixture:
`test/runtime/self/test-watchdog-wake-delivery.mjs`.

The post-compaction stack overflow was caused by `triggerTurn: true` firing **mid-tool-execution**. The fix is the **busy guard** (below). The compaction-resume timer was removed in 2026-07-11 because pi-core's agent loop automatically continues after **auto**-compaction (`_runAutoCompaction()` continues on `willRetry`/overflow or queued messages); the 3-minute fallback timer was firing as spurious noise on that path. That does NOT cover the manual `ctx.compact()` path (agent-initiated `context_compress` tool): manual compaction aborts the loop and never resumes it - the resume there is the enforcement `session_compact` re-orientation whisper with `triggerTurn: true` (see `enforcement/handlers/register-session-compact.ts`), which was verified and fixed 2026-08-02.

## Tag conventions

| Tag                      | Set by             | Cancelled on                                          | Notes                                                                                                                |
| ------------------------ | ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `compaction-resume`      | (removed)          | `context_compress`, `auto-compact`, `session_compact` | Timer removed 2026-07-11; auto path self-continues, manual path resumed by enforcement whisper (verified 2026-08-02) |
| `auto-compaction-resume` | (removed)          | `context_compress`, `auto-compact`, `session_compact` | (same as above)                                                                                                      |
| `<user-tag>`             | `timer` action=set | `timer` action=cancel only                            |

**Always cancel stale resume tags** - the `timers` Map is process-global and never garbage-collected. Without explicit cancellation, an old resume timer can fire during a later, unrelated TURN_END and produce a misplaced `[timer]` whisper (the "strange order" issue). The compaction-resume timer was removed in 2026-07-11, but the cancellation code remains as a safety measure to clean up any timers scheduled before the removal.

## Whisper contract

Timer fires deliver a `[timer] <reason>` whisper via `sendTrackedMessage` with:

- `priorityFromSource("timer/fire")` maps to **critical** (not high). Critical
  bypasses `WHISPER_CAPS.high` so the timer whisper reaches the agent even
  in a degraded turn with 3+ high-priority whispers already fired. The
  per-source cap of 2 still applies. See `wake-retry.ts` and
  `test/runtime/lib/test-timer-fire-suppression.mjs` for the regression.

- `customType: "timer"` (silent) / `"timer-fire"` (wake + retries + recovered flush)
- wake fires: `{ triggerTurn: true }` (no deliverAs - wake-gate drops triggerTurn at send time if a run region is active, so the wake takes the live shape: steer into a streaming run, append to the session in the pre-flight); silent fires: `{ delivery: "park", deliverAs: "steer" }` (see Wake flag above)
- `details._braidInjected: true`, `details._braidSource: "timer/fire"`, `details.timerId`, `details.wake`

The whisper survives compaction (via `_braidInjected`), matching the `[enforcement]` contract. See `test/runtime/enforcement/test-post-compaction-resume.mjs` for the regression test on the triggerTurn derivation.

## Busy guard

The 1s `setInterval` poller bails while the agent is mid-tool-execution. This prevents whisper injection during a tool call, which was the root cause of the post-compaction stack overflow (whisper -> synchronous re-entry -> stack overflow).

**Busy guard lifecycle (current design):**

| Event                               | `poller.busy` | Fires expired timers?       |
| ----------------------------------- | ------------- | --------------------------- |
| `TOOL_CALL` (tool starts)           | `true`        | No (tool is running)        |
| `TOOL_EXECUTION_END` (tool returns) | `false`       | **Yes (primary fire path)** |
| `TURN_END` (turn ends)              | `false`       | Yes (backup)                |

**Why `TOOL_EXECUTION_END` and not `TURN_END` for the primary path:**

An earlier design used `TURN_END` to clear busy. This had a bug: a long-running tool (e.g., `bash` with `sleep 60`) followed by a long LLM thinking phase kept `busy = true` for the entire turn. A 30s timer set just before the slow tool would be stuck waiting for `turn_end` (which might be minutes away if the LLM is thinking), even though the actual tool was long done. The user saw "timer didn't fire" even though the tool was complete.

The correct guard is per-tool-execution:

- `tool_call` -> busy=true (tool is starting)
- `tool_execution_end` -> busy=false (tool returned) + fire expired timers
- `turn_end` -> busy=false + fire expired timers (safety net for turns with no tools)

This is still safe against the post-compaction stack overflow because it blocks whisper injection only during actual tool execution, not during LLM thinking (which can't chain into synchronous re-entry).

## Local Contracts

- Timer state is module-level (`timerManager.timers` is a `Map`). It survives compaction but is reset only on `session_shutdown`.
- `TimerPoller.piRef` is the most recently registered pi instance. If a new session starts, the old reference is replaced.
- The poller runs as a single `setInterval` for the whole process; not per-session.
