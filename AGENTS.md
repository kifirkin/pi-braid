# pi-braid Developer Guide

## Extension Loading

Every extension is a self-contained subdirectory under `src/extensions/`, with
`index.ts` exporting a default factory. The flat registry lives in
[`src/extensions/manifest.ts`](./src/extensions/manifest.ts) - there is **no
module-grouping abstraction**. The `module` field on each manifest entry is a
label used by the subagent API to enable/disable a group of extensions
(e.g., `BRAID_MODULES=+heartbeat`); it has no structural role in the
directory tree.

The runtime loader is `src/loader/loader.ts`. Config sources (highest
priority first): subagent API → `~/.pi/agent/settings.json` under `braid.modules`
→ `BRAID_MODULES` env var → manifest defaults.

### Common `BRAID_MODULES` patterns

```bash
# Default - all non-opt-in extensions enabled
unset BRAID_MODULES

# Toggle individual extensions: +name to enable, -name to disable
export BRAID_MODULES="all,-error-tracking"           # everything except error-tracking
export BRAID_MODULES="core,+health-maintenance"     # core + opt-in health-maintenance
export BRAID_MODULES="-heartbeat"                   # everything except heartbeat group

# Group toggle (only works for entries with a `module` field)
export BRAID_MODULES="+heartbeat"                   # enable both heartbeat extensions
```

The `module` field is set on sub-extensions that should be toggled as a group
(heartbeat). Single-extension modules use their own id as the label.

## Build & Test

```bash
npm run typecheck  # TypeScript check only
npm run build      # Compile to dist/
npm run test       # Build + run runtime tests
npm run clean      # Remove dist/ and .tsbuildinfo
```

## State Management

Use `getExtensionState(ctx, key, factory)` for per-session state. Module-level
`let` for mutable state leaks across sessions - use the state factory instead.

Event handlers receive `(event, ctx: ExtensionContext)`. Tool execute functions receive `(toolCallId, params, signal, onUpdate, ctx)`.

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are auto-enabled on first session
- Prompt-builder overrides the system prompt entirely (no native loading)
- Decompose large handlers into `handlers/*.ts` sub-modules

## Tool Inventory

42 tools are registered across extensions. The full audit with
overlap analysis, out-of-scope candidates, and consolidation plan
is in `docs/TOOL-INVENTORY-AUDIT.md`. Key points:

- **In scope** (braid's value-add): cognitive, metacognition, memory,
  context management, error tracking, health, behavior, timer. Keep these.
- **Out of scope** (debug/research affordances): `prompt_preview`,
  `time_status`, `set_ab_variant`, `context_signal`. Candidate removal.
- **CRUD-shaped (consolidation candidates)**: `error_*` (4), `timer_*`
  (3), `verify_claim`/`verify_decomposition`,
  `check_topic_drift`/`reset_topic_anchors`, `session_search`/`session_query`,
  `memory_list`/`memory_get`. Each can be one tool with actions.
- **scratchpad vs task**: both track progress but serve different
  purposes. scratchpad = structured state (goal/plan/decisions/learnings
  with priority + persistence + recycling). task = simple TODO list
  with priority + dependencies. Document the distinction in each tool's
  description; do not merge.
