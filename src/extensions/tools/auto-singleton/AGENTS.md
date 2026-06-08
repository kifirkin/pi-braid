# src/extensions/tools/auto-singleton/ — Inactivity Watchdog Timer

An **active reminder** — a one-shot timer that fires after N seconds of agent
inactivity, then auto-cancels. The agent explicitly re-arms for continued
protection.

## Disambiguation: this is NOT the only "watchdog" in the codebase

There are TWO different things called "watchdog" in pi-braid:

| Concept | Path | Purpose | Interface |
|---|---|---|---|
| **Auto-singleton watchdog (this one)** | `extensions/tools/auto-singleton/` | Fires once after N seconds of inactivity, agent-controlled | `pi.registerTool` — LLM-callable tools |
| **Session watchdog** | `extensions/watchdog/` | Tracks session uptime / idle time / message count | `pi.registerCommand` — TUI-only, not LLM-callable |

They are different concerns:
- `auto-singleton/` is an **active reminder** (it fires a steer to wake the agent).
- `watchdog/` is a **passive observer** (it doesn't act).

## Tools

| Tool | Purpose |
|---|---|
| `auto_singleton_set` | Arm the watchdog with a timeout. Replaces any existing one. |
| `auto_singleton_cancel` | Cancel the active watchdog. |
| `auto_singleton_status` | Show time remaining + last renewal. |

## Local Contracts

- Singleton: only ONE active watchdog per session.
- Polling-based: checks every 5s, independent of `turn_end` events.
- Auto-renew on `tool_call` and `turn_end`.
- One-shot: fires once, then deactivates.
- Agent-controlled: set, cancel, check status.
- When it fires, it sends a steer with `triggerTurn: true` to wake the agent.

## Relationship to the timer extension

`auto-singleton/` is a specialization of the more general `extensions/tools/timer/`
extension. The general timer can set multiple timers with arbitrary wake policies.
The auto-singleton is constrained to: at-most-one, auto-renew, one-shot, fires on
inactivity. The agent should use the right tool for the job:
- "remind me in 5 minutes" → `timer_set`
- "if I'm idle for 30 seconds, wake me" → `auto_singleton_set`
