# src/extensions/heartbeat/ - Background Daemons

Background services that run continuously during a session. Unlike
cognitive/ detectors (which fire on events), heartbeat services run on
their own schedule.

## Sub-extensions

| Path | Purpose |
|---|---|
| `heartbeat-scheduler/` | The main heartbeat engine. Runs policies on a schedule. Includes modules: `timer-reminder`, `behavioral-drift`, `evolver`, `recaller`, `context-hygiene`, `measurement`, `budget`, `reflection-consolidator`. |
| `analytics/` | Analytics engine. Tracks tool usage, success rates, and produces A/B test variants. |

## Local Contracts

- Heartbeat services are **decoupled from the turn loop** - they run on timers or on `turn_end` events.
- They don't emit whispers directly to the agent. They emit signals that the enforcement layer translates.
- See `extensions/heartbeat/heartbeat-scheduler/policies.ts` for the policy DSL.
- See `extensions/heartbeat/heartbeat-scheduler/modules/` for the built-in policies.
