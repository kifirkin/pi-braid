# src/extensions/tools/ — LLM-callable Tools

Extensions that provide tools the agent can call directly. Each subdir
is a self-contained tool extension.

## Sub-extensions

| Path | Tools | Purpose |
|---|---|---|
| `timer/` | `timer_set`, `timer_list`, `timer_cancel` | Set/list/cancel reminders. |
| `auto-singleton/` | `auto_singleton_set`, `auto_singleton_cancel`, `auto_singleton_status` | Singleton fire-once timers. |
| `auto-recovery/` | (whisper-only) | Auto-recovery on errors. |
| `latent-activator/` | (whisper-only) | Activates latent knowledge at the right moment. |

## Local Contracts

- **All tool names use snake_case.**
- Tools should be **idempotent** when possible.
- Each tool has its own `AGENTS.md` documenting its specific contract.
