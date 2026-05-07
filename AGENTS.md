# pi-braid Developer Guide

## Module System

Extensions are grouped into **modules** (`src/modules/definitions.ts`). Each module maps to a research track or logical concern.

### Config-Driven Loading

Modules are loaded based on `BRAID_MODULES` environment variable:

```bash
# Enable everything (default)
export BRAID_MODULES="all"

# Enable specific modules
export BRAID_MODULES="core,cognitive,memory,retry"

# Disable specific modules
# (format not supported — use runtime API instead)
```

### Subagent API (runtime toggling)

Researcher subagents can toggle modules during benchmark sessions:

| Command | Effect |
|---------|--------|
| `/modules-list` | Show all modules and their state |
| `/modules-enable <name>` | Enable a module (next session) |
| `/modules-disable <name>` | Disable a module (next session) |
| `/modules-toggle <name>` | Toggle a module on/off |
| `/modules-status` | Show current load state |
| `/modules-reset` | Reset all runtime overrides |

This enables A/B testing of feature sets without editing config.

## Build & Test

```bash
npm run typecheck  # TypeScript check only
npm run build      # Compile to dist/
npm run test       # Build + run 34 runtime tests
npm run clean      # Remove dist/ and .tsbuildinfo
```

## State Management

You're someone who manages session-scoped state carefully. Use `getExtensionState(ctx, key, factory)` for per-session state. Module-level `let` for mutable state leaks across sessions — use the state factory instead.

Event handlers receive `(event, ctx: ExtensionContext)`. Tool execute functions receive `(toolCallId, params, signal, onUpdate, ctx)`.

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are auto-enabled on first session
- Prompt-builder overrides the system prompt entirely (no native loading)
- Decompose large handlers into `handlers/*.ts` sub-modules
