# src/extensions/health-maintenance/ — Health & Checkpointing

Provides the `health_maintenance` tool, which monitors agent health, detects
degradation, and supports checkpoint/rollback.

## Naming convention: module id vs tool name

| Concept | Name | Where used | Convention |
|---|---|---|---|
| **Module id** | `health-maintenance` | `manifest.ts`, env config (`BRAID_MODULES=+health-maintenance`), settings | **kebab-case** (config convention) |
| **Tool name** | `health_maintenance` | `pi.registerTool({ name: ... })`, LLM-facing | **snake_case** (LLM convention) |

These are TWO different names for the same module, in two different
namespaces. The kebab-case version appears in module/group config (e.g.,
`BRAID_MODULES=+health-maintenance`). The snake_case version is what the
LLM calls as a tool.

**Do not unify them** — module config and tool APIs have different naming
conventions for good reason (config keys prefer hyphens for readability;
tool names prefer underscores because the LLM's prompt grammar treats
underscores as word boundaries and hyphens as part of the word).

## Files

| File | Purpose |
|---|---|
| `index.ts` | The extension factory. Registers the `health_maintenance` tool. |
| `helpers.ts` | Analytics helpers. |
| `format.ts` | Output formatting. |
| `types.ts` | Local types. |

## Local Contracts

- This extension is **opt-in** (`disabledByDefault: true`). The user has
  to explicitly enable it via `BRAID_MODULES=+health-maintenance` or
  `~/.pi/agent/settings.json`.
- Uses `getMetacognitiveState` from `lib/state/metacognitive-state.ts` to read
  per-session metric history; no other extension is a hard dependency.
- The tool is the only LLM-visible entry point; all the analytical logic
  runs in the background and is exposed via the tool's output.
