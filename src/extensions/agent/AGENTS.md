# src/extensions/agent/ — Agent Working-State Tools

Tools the agent uses to manage its own working state: input/output shaping,
session memory, and time-travel snapshots. These are agent-facing utilities
that don't depend on the cognitive or enforcement layers.

## Sub-extensions

| Path | Tool | Purpose |
|---|---|---|
| `scratchpad/` | `scratchpad` | Agent's working memory: goal/plan/decisions/notes/learnings. Persists to per-project file. |
| `input-polisher/` | (event handler) | Proofreads and translates user input before sending to the LLM. Uses utility model. |
| `workspace-snapshot/` | `workspace_snapshot` | Captures and restores file states for safe time-travel experimentation. |

## Local Contracts

- These are **always-on** but not depended on by other extensions.
- `input-polisher/` modifies the message stream; it does NOT expose a tool.
- `scratchpad/` and `workspace_snapshot` are the agent's primary state tools.

## Distinction from `core/`

- `core/` = always-on infrastructure that other extensions depend on (polyfill, environment, prompt assembly).
- `agent/` = always-on tools the agent uses directly (no cross-extension code dependency).
