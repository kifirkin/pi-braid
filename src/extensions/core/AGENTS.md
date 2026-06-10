# src/extensions/core/ — Always-On Infrastructure

Extensions that provide infrastructure that other extensions depend on.
They are loaded unconditionally and other extensions can assume they are present.

## Sub-extensions

| Path | Purpose | Depended on by |
|---|---|---|
| `polyfill/` | Polyfills for missing pi core features. | (foundation) |
| `agent-environment/` | L1 environmental awareness: working dir, time, machine info. | `prompt-builder` |
| `prompt-builder/` | Builds the agent's system prompt. Composed of L1 environment, past insights, contrast phrases. | (final assembly) |

## Local Contracts

- These are the **always-loaded** infrastructure. Other extensions can assume they are present.
- If you need a new infrastructure piece, add it here.
- Agent-facing working tools (scratchpad, input polisher, workspace snapshot) live in `agent/`.
- Cognitive analysis tools (think/verify/etc, detectors) live in `cognitive/`.
