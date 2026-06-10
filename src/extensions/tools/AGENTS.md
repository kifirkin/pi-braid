# src/extensions/tools/ — LLM-callable Tools + "Tool-Provider" Extensions

Extensions that provide tools the agent can call directly. Most also have
event handlers. Each subdir is a self-contained tool extension.

## Sub-extensions

| Path | Tools | Event handlers? | Purpose |
|---|---|---|---|
| `timer/` | `timer` (action=set\|list\|cancel) | Yes | Set/list/cancel reminders. |
| `auto-singleton/` | `auto_singleton` (action=set\|cancel\|status) | Yes | Singleton fire-once timer. |
| `auto-recovery/` | (whisper-only) | Yes | Auto-recovery on errors. |
| `latent-activator/` | (whisper-only) | Yes | Activates latent knowledge at the right moment. |

## Local Contracts

- **All tool names use snake_case.**
- Tools should be **idempotent** when possible.
- Each tool has its own `AGENTS.md` documenting its specific contract.

## Disambiguation: "watchdog" in pi-braid

There are TWO different "watchdog" concepts in the codebase. They are
deliberately separate:

- **`extensions/watchdog/`** (NOT in this dir) — A *passive observer* that
  tracks session uptime/idle/message count. Has a TUI command but no LLM tools.
  See `extensions/watchdog/AGENTS.md`.
- **`extensions/tools/auto-singleton/`** (IN this dir) — An *active reminder*
  that fires once after N seconds of inactivity. LLM-callable tools.
  See `extensions/tools/auto-singleton/AGENTS.md`.

## The "pure tool provider" pattern

Several other extensions live in `extensions/<other>/` and are "pure tool
providers" — they register LLM tools but have NO `pi.on(...)` event handlers.
This is a valid pattern for stateless tools:

- `topic-drift/` — 1 tool, 0 handlers
- `latent-activator/` — 0 tools (whisper-only; also in this dir)
- `workspace-snapshot/` — 1 tool, 0 handlers (now in `agent/`)
- `scratchpad/` — 1 tool, 0 handlers (now in `agent/`)
- `context-manager/` — 1 tool, 0 handlers
- `memory-agent-bridge/` — 2 tools, 0 handlers (memory_store, memory_recall)
- `error-tracking/` — 1 tool, 0 handlers

The reason they're not all in `extensions/tools/` is historical — they
were added before that pattern was formalized. A future refactor could
consolidate them, but it's not blocking.
