# Contributing to pi-braid

Thanks for your interest. Here's how to get started.

## Development Setup

```bash
git clone https://github.com/kifirkin/pi-braid.git
cd pi-braid
npm install
npm run build
```

## Commands

| Command             | Purpose                      |
| ------------------- | ---------------------------- |
| `npm run typecheck` | TypeScript check (no emit)   |
| `npm run build`     | Compile to `dist/`           |
| `npm run test`      | Build + run 61 runtime tests |
| `npm run lint`      | ESLint check                 |
| `npm run format`    | Prettier formatting          |
| `npm run clean`     | Remove build artifacts       |

## Project Structure

```
src/
  index.ts              # Extension registration entry point
  extensions/           # All extensions (cognitive, memory, tools, etc.)
  lib/                  # Shared libraries (cognitive-memory, belief-store, etc.)
  modules/              # Module definitions and loader
skills/                 # Bundled skills (SKILL.md per skill)
test/runtime/           # Runtime test files (test-*.mjs)
docs/                   # Documentation
```

## Code Style

- TypeScript strict mode
- ESM modules (`.js` extension in imports)
- `createLogger(name)` for logging — no `console.log`
- `getExtensionState(ctx, key, factory)` for session-scoped state
- Async functions must use `fs/promises`, not sync I/O
- Empty `catch {}` blocks only for JSON.parse of untrusted data — otherwise log

## Extension Anatomy

Extensions register via the pi SDK:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "What it does",
    parameters: {
      /* TypeBox schema */
    },
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      return { result: "done" };
    },
  });

  pi.on("turn_start", (event, ctx) => {
    // Handle event
  });
}
```

## Testing

Tests are in `test/runtime/` as `.mjs` files. Each test file:

1. Imports from `dist/` (compiled output)
2. Runs assertions
3. Exits with code 0 (pass) or 1 (fail)

```bash
# Run all tests
npm test

# Run a single test
node test/runtime/test-enforcement.mjs
```

## Pull Requests

1. Create a branch from `develop`
2. Make your changes
3. Ensure `npm run typecheck` and `npm test` pass
4. Open a PR against `develop`

## Module System

Extensions are grouped into modules defined in `src/modules/definitions.ts`. New extensions should be added to the appropriate module or a new one created.

Modules are loaded based on the `BRAID_MODULES` environment variable (default: all enabled).

## Storage Convention

All braid-specific data goes under `~/.pi/agent/braid/`. Use constants from `src/lib/braid-paths.ts` — never hardcode paths.

## Questions?

Open an issue on [GitHub](https://github.com/kifirkin/pi-braid/issues).
