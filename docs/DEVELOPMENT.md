# Development Guide

> **Start here**: This is the developer guide for pi-braid.
> For system overview see [ARCHITECTURE.md](ARCHITECTURE.md).
> For module system see [MODULES.md](MODULES.md).
> For skill system see [SKILLS.md](SKILLS.md).

**Key stats**: 0 TypeScript errors | 32 tests | 35 extensions | 14 modules

## Setup

```bash
npm install
```

## Build & Test

```bash
# Type-check (fast, no output)
npm run typecheck

# Build (tsc tree output to dist/)
npm run build

# Run tests
npm test

# Run individual test
node test/runtime/test-<name>.mjs

# Clean build artifacts
npm run clean
```

## Pre-commit Checklist

Before every commit:

```bash
npm run typecheck && npm test
```

## Extension Structure

Every extension lives at `src/extensions/<module>/<extension>/index.ts`. Extensions are grouped by module (see [MODULES.md](MODULES.md)).

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";

export default function myExtension(pi: ExtensionAPI) {
  const log = createLogger("my-extension");

  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "...",
    parameters: Type.Object({ ... }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const state = getExtensionState(ctx, "my-extension", () => ({ counter: 0 }));
      return { content: [{ type: "text" as const, text: `Counter: ${state.counter}` }], details: {} };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = getExtensionState(ctx, "my-extension", () => ({ counter: 0 }));
    state.counter = 0;
  });
}
```

## Extension Loading Order

Extensions load in the order defined in `src/modules/definitions.ts`. The `core` module loads first; others follow declaration order. See [MODULES.md](MODULES.md) for runtime toggling.

## Adding a New Extension

1. Create `src/extensions/<module>/<extension>/index.ts`
2. Add to the module's `extensions` array in `src/modules/definitions.ts`
3. Register tools and event handlers
4. Use `getExtensionState(ctx, "extension-name", factory)` for session state
5. Add test in `test/runtime/test-<extension>.mjs`
6. Run `npm test` before committing

## State Management

Use `getExtensionState(ctx, key, factory)` for all mutable session state:

```typescript
const state = getExtensionState(ctx, "my-ext", () => ({
  counter: 0,
  lastTurn: null,
}));
```

**Rule**: Never use module-level `let` for mutable session state. Use module-level `let` only for disk-persisted config or process constants.

## Event Reference

| Event                | When                      | Use for                                |
| -------------------- | ------------------------- | -------------------------------------- |
| `session_start`      | New session begins        | Initialize state, recover from entries |
| `turn_end`           | Turn completes            | Record metrics, update state           |
| `agent_end`          | Agent finishes responding | Capture errors, trigger retries        |
| `before_agent_start` | Before new turn           | Build system prompt, inject context    |

## Error Handling

See [ERRORS.md](ERRORS.md) for common errors and resolutions.

## Releasing

```bash
git checkout main && git pull
npm run typecheck && npm test
git tag -a v0.X.Y -m "v0.X.Y — changelog summary"
```
