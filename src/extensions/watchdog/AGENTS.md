# src/extensions/watchdog/ — Session Health Monitor

A **background monitor** that tracks session metrics (uptime, idle time, message
count) and surfaces them via a TUI command. No LLM-callable tools.

## Disambiguation: this is NOT the only "watchdog" in the codebase

There are TWO different things called "watchdog" in pi-braid:

| Concept | Path | Purpose | Interface |
|---|---|---|---|
| **Session watchdog (this one)** | `extensions/watchdog/` | Tracks session uptime / idle time / message count | `pi.registerCommand("watchdog-status")` — TUI-only, not LLM-callable |
| **Auto-singleton watchdog** | `extensions/tools/auto-singleton/` | Timer that fires ONCE after N seconds of inactivity, then auto-cancels. Agent-controlled via `auto_singleton_set`. | `pi.registerTool` — LLM-callable tools |

They are different concerns:
- `watchdog/` is a **passive observer** (it doesn't act).
- `auto-singleton/` is an **active reminder** (it fires a steer to wake the agent).

## Files

| File | Purpose |
|---|---|
| `index.ts` | The only file. ~102L. Tracks per-session state in a Map keyed by session file path. Subscribes to `analytics_alert` events. |

## Local Contracts

- Module is opt-in (`disabledByDefault: true`).
- Module id: `watchdog` (kebab-case).
- Not LLM-callable. The agent cannot trigger it — only the user can, via the `watchdog-status` command.
- For agent-controlled inactivity timers, see `extensions/tools/auto-singleton/AGENTS.md`.
