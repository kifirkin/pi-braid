<!-- status: current -->

# src/extensions/self/ - Self-Management Extensions

Extensions that manage the agent's own state and behavior. Mostly opt-in
because they're specialized tools the user enables when they want them.

## Sub-extensions

| Path | Tool | Purpose |
|---|---|---|
| `health-maintenance/` | `health_maintenance` | Health check, checkpoint, rollback, evolution triggers. |
| `error-tracking/` | `error` (action=list\|get\|clear\|stats) | Auto-captures extension errors, logs to disk, provides query tool. |
| `watchdog/` | (TUI command) | Passive session monitor: uptime, idle time, message count. No LLM tool. |
| `auto-recovery/` | (whisper-only) | On turn_start, checks for system degradation and suggests recovery. |
| `latent-activator/` | `behavior` | Activates atomic behavior modes (planner, executor, reviewer, etc). |

## Local Contracts

- Most are **opt-in** (`disabledByDefault: true` in the manifest).
- `auto-recovery` and `latent-activator` are always-on.
- These extensions manipulate the agent's own state, not external state.

## Distinction from related categories

- `self/` = about the AGENT'S STATE (health, errors, modes, recovery)
- `memory/` = about the agent's PERSISTENT KNOWLEDGE (episodes, semantic memory)
- `scheduling/` = about TIME-BASED TRIGGERS (reminders, watchdogs)
- `monitoring` (if added later) would be about PASSIVE OBSERVABILITY - but currently
  we have nothing that doesn't fit under `self/`
