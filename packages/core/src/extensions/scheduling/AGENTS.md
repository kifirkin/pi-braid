<!-- status: current -->

# src/extensions/scheduling/ - Time-Based Events

Extensions that fire on time-based triggers (recurring reminders, inactivity
watchdogs). Distinct from `self/` (which is self-management) and `heartbeat/`
(which runs scheduled background policies).

## Sub-extensions

| Path     | Tool                               | Purpose                                                                                                     |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `timer/` | `timer` (action=set\|list\|cancel) | Non-blocking Pomodoro-style reminders. Agent schedules, continues working, gets a whisper when timer fires. |

## Local Contracts

- **All tool names use snake_case.**
- The timer extension is always-on (not opt-in).
- Scheduling is per-session but the timer map is process-global; new sessions replace the `pi` reference.

## Distinction from related categories

- `scheduling/` = when the AGENT (or user) wants to be reminded
- `self/auto-recovery` = when the SYSTEM detects degradation
- `self/latent-activator` = proactive cognitive mode injection (not time-based)
- `heartbeat/` = proactive background policies (scheduled, but not "remind me in 5 min")
