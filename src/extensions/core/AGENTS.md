<!-- status: current -->

# src/extensions/core/ - Input/Output Shaping

Extensions that shape what the LLM sees at runtime: platform shims,
environmental awareness, system prompt assembly, and user input transformation.

## Sub-extensions

| Path | Purpose | Depended on by |
|---|---|---|
| `polyfill/` | Polyfills for missing pi core features. | (foundation) |
| `agent-environment/` | L1 environmental awareness: working dir, time, machine info. | `prompt-builder` |
| `prompt-builder/` | Builds the agent's system prompt. Composes sections; orchestrates once-per-session whisper deliveries from `memory/` and `cognitive/`. | (final assembly) |
| `input-polisher/` | Proofreads and translates user input before sending to the LLM. Uses utility model. | (event handler) |

## Local Contracts

- These are the **always-loaded** infrastructure. Other extensions can assume they are present.
- `input-polisher` is an event handler (not a tool); it transforms `user_message` events.
- If you need a new infrastructure piece, add it here.
- Agent-facing working tools (scratchpad, workspace snapshot) live in `memory/`.
- Cognitive analysis tools (think/verify/etc, detectors) live in `cognitive/`.
- Self-management extensions live in `self/`.
- Time-based events live in `scheduling/`.
- Whisper deliveries (hints, past insights, OpenSpec) live in their natural homes (`cognitive/`, `memory/`). The prompt-builder orchestrates the once-per-session call to each `deliver*` function but does not own the data pipeline.
