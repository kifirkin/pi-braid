# Heartbeat Scheduler Extension

Proactive cognitive scheduling based on paper 2604.14178. Triggers
interventions before problems arise: silence, context overflow, error
accumulation, behavioral drift, budget exhaustion.

## Architecture

This file (`index.ts`) is the **extension entry point** — registers pi
event handlers and the heartbeat tick. The actual scheduling logic is
decomposed into sub-modules for clarity and testability:

| File                             | Purpose                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `types.ts`                       | Type definitions for heartbeats, modules, policies                                               |
| `state.ts`                       | State management and configuration                                                                |
| `policies.ts`                    | Default policies (verification, context monitor)                                                 |
| `meta-learning.ts`               | Adaptive tick interval adjustment                                                                |
| `modules/recaller.ts`            | Periodic memory recall injection                                                                 |
| `modules/dreamer.ts`             | Pattern detection from past trajectories (dormant, no production listener)                      |
| `modules/measurement.ts`         | Tool reliability and success-rate tracking                                                       |
| `modules/budget.ts`              | Token/cost budget tracking                                                                       |
| `modules/behavioral-drift.ts`    | Detects when the agent is drifting from the original goal                                        |
| `modules/context-hygiene.ts`     | Context-usage monitoring and overflow prevention                                                 |
| `modules/evolver.ts`             | Adapts module behavior based on observed outcomes                                                |
| `modules/reflection-consolidator.ts` | Post-turn reflection: consolidates learnings and feeds them back to memory                   |
| `modules/timer-reminder.ts`      | Drains `pendingReminders` from `lib/events/timer-bus.ts` and surfaces them as whispers           |

**Each module is independently toggleable** via its own config in
`policies.ts`. Disabling a module is a one-line change.

## Tick loop

```
register_session_start
  → registerSessionStartHandler (queues until first session_start)
  → on session_start: init policy engine, register eventBus listeners

turn_end (every N turns, controlled by meta-learning.ts)
  → for each enabled module: module.tick(turnState, context)
  → if module requests whisper: sendTrackedMessage (priority from module)
  → aggregate emitted events to eventBus (heartbeat_tick, sop_suggestion, etc.)
```

Tick interval is adaptive: starts at every 5 turns, increases to every
20 if the system is quiet, decreases back when activity resumes. See
`meta-learning.ts`.

## Event-bus contract

| Emits                  | Listens to            |
| ---------------------- | --------------------- |
| `heartbeat_tick`       | `enforcement/handlers/register-session-start.ts:70` |
| `sop_suggestion`       | `enforcement/handlers/register-session-start.ts:89` |
| `tool_error` (via downstream) | `self/error-tracking/index.ts:129` |
| `analytics_alert` (via analytics/) | `self/watchdog/index.ts:51` |

The `enforcement_violation`, `context_full`, `turn_complete`,
`memory_evict` events are emitted by OTHER extensions and consumed
here (via register-session-start.ts).

## Whisper contract

All modules emit whispers via `sendTrackedMessage`. Each module
declares its own priority (see `modules/*.ts`). Per-turn and
per-source caps are enforced in `injection-tracker.ts`.

## Local Contracts

- **Process-global**: state is per-session (via `getExtensionState(ctx, key, factory)`).
  The poller does not run when no session is active (gated by `SessionPhase`).
- **Opt-in**: enable via `BRAID_MODULES=+heartbeat`. Off by default in
  core (timer) to avoid surprising users; on by default in
  `all,-heartbeat-scheduler` config.
- **First-tick timing**: the first heartbeat fires 5 turns after
  session_start, not on session_start itself. This avoids racing
  with the user's first message.
- **Compaction survival**: all module state is per-session, so it
  survives the in-place compaction. The full state is reset only on
  `session_shutdown`.
