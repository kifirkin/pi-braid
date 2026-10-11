<!-- status: current -->

# src/extensions/watchdog/ - Session Health Monitor

A **background monitor** that tracks session metrics (uptime, idle time, message
count) and surfaces them via a TUI command. No LLM-callable tools.

## Disambiguation: this is NOT the only "watchdog" in the codebase

This is the only thing called "watchdog" now. Previously there was an
`auto-singleton/` watchdog (an agent-callable inactivity timer), but that
was removed in the 2026-06 tool-inventory audit. The `timer` tool covers the
use case it addressed.

The Session watchdog is purely a **passive observer** (it doesn't act).

## Files

| File       | Purpose                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | The only file. ~102L. Tracks per-session state in a Map keyed by session file path. Subscribes to `analytics_alert` events. |

## Local Contracts

- Module is opt-in (`disabledByDefault: true`).
- Module id: `watchdog` (kebab-case).
- Not LLM-callable. The agent cannot trigger it - only the user can, via the `watchdog-status` command.
