# src/extensions/core/ — Core Infrastructure Extensions

Extensions that provide core infrastructure. They are loaded unconditionally
and provide features that other extensions depend on.

## Sub-extensions

| Path | Purpose |
|---|---|
| `agent-environment/` | Provides the agent's working environment (path configuration, env vars, file system access). |
| `scratchpad/` | The agent's working memory. Provides `scratchpad` tool. |
| `metacognition/` | Provides `think`, `hypothesize`, `verify`, `finalize` tools for structured reasoning. |
| `input-polisher/` | Polishes user input before sending to the LLM (cleans up typos, normalizes formatting). |
| `prompt-builder/` | Builds the agent's system prompt. Composed of multiple parts (L1 environment, past insights, contrast phrases). |
| `polyfill/` | Polyfills for missing pi core features. |
| `workspace-snapshot/` | Provides `workspace_snapshot` tool for capturing workspace state. |

## Local Contracts

- These are the **always-loaded** extensions. They define the agent's basic capabilities.
- Other extensions can assume these are present.
- If you need a new core extension, it should be added to the manifest's "core" group.
