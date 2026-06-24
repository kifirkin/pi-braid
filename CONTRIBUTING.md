<!-- status: current -->

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

| Command               | Purpose                                |
| --------------------- | -------------------------------------- |
| `npm run typecheck`   | TypeScript check (no emit)             |
| `npm run build`       | Compile to `dist/`                     |
| `npm run test`        | Build + run runtime tests              |
| `npm run lint`        | ESLint check                           |
| `npm run format`      | Prettier formatting                    |
| `npm run clean`       | Remove build artifacts                 |
| `npm run check:deps`  | Layer boundary check                   |
| `npm run ci:check`    | typecheck + check-deps + test          |

## Project Structure

The directory layout follows an **agent-loop model** (see
[src/AGENTS.md](src/AGENTS.md) for the full rationale):

```
src/
  index.ts                # Extension registration entry point
  extensions/             # All extensions (one subdir per extension)
    core/                 #   Input/Output (platform, env, prompt, input polish)
    cognitive/            #   Thinking (reasoning + detectors)
    memory/               #   Remembering (persistent state, working memory)
    scheduling/           #   When to act (time-based events)
    self/                 #   Self-management (health, errors, recovery, modes)
    heartbeat/            #   Background proactive services
    enforcement/          #   Turn pipeline (handlers, detection, substate)
  lib/                    # Shared libraries (imported by extensions)
  loader/                 # Runtime extension loader
  types/                  # Ambient .d.ts declarations
test/runtime/             # Runtime tests (test-*.mjs)
```

Skills previously bundled with pi-braid now live in a separate sibling
package: **[pi-braid-skills](https://github.com/kifirkin/pi-braid-skills)**.

## Code Style

- TypeScript strict mode
- ESM modules (`.js` extension in imports)
- `createLogger(name)` for logging - no `console.log`
- `getExtensionState(ctx, key, factory)` for session-scoped state
- Async functions must use `fs/promises`, not sync I/O
- Empty `catch {}` blocks only for JSON.parse of untrusted data - otherwise log
- No Python - the project is pure JS/TS

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

Multi-action tools use an action discriminator:

```typescript
const schema = Type.Object({
  action: Type.Union([Type.Literal("set"), Type.Literal("cancel")]),
  // action-specific fields are Optional<>
  durationSec: Type.Optional(Type.Number()),
});

pi.registerTool({
  name: "my_tool",
  parameters: schema,
  execute: async (id, params, signal, onUpdate, ctx) => {
    switch (params?.action) {
      case "set": /* ... */
      case "cancel": /* ... */
      default: throw new Error(`Unknown action: ${params?.action}. Use: set, cancel.`);
    }
  },
});
```

## Testing

Tests are in `test/runtime/` as `.mjs` files. The test runner
(`scripts/run-tests.mjs`) is recursive - it auto-discovers all `.mjs`
files in the test tree.

```bash
# Run all tests
npm test

# Run a single test (bypassing the build step)
node test/runtime/test-enforcement.mjs
```

Test quality bar: each test should have real assertions on real behavior,
not just file-existence checks or reimplementations of algorithms. A test
with zero real assertions is a "nonsense test" - delete it.

## Pull Requests

1. Create a branch from `main`
2. Make your changes
3. Ensure all four quality gates pass:
   ```bash
   npm run typecheck
   npm test
   npm run check:deps
   # check-duplicates.mjs is a separate script (no npm script yet)
   ```
4. Open a PR against `main`

## Module System

Extensions are registered in the flat manifest at
[`src/extensions/manifest.ts`](src/extensions/manifest.ts). The `module` field
on each entry is a label used by the subagent API to enable/disable a group
of extensions. It has no structural role in the directory tree.

Extensions are loaded based on the `BRAID_MODULES` environment variable
(default: all non-opt-in extensions enabled). See [AGENTS.md](AGENTS.md) for
the full config resolution order.

## Storage Convention

All braid-specific data goes under `~/.pi/agent/braid/`. Use constants from
[`src/lib/config/braid-paths.ts`](src/lib/config/braid-paths.ts) - never
hardcode paths.

## Release Process

Cutting a new release involves: version bump, CHANGELOG update, build
verification, and npm publish.

### 1. Update CHANGELOG.md

Add a new section at the top under `## [VERSION] - DATE` with:

- **Added** - new features, new tools, new modules
- **Changed** - modifications to existing behavior, refactors
- **Fixed** - bug fixes
- **Removed** - deleted features, dropped tools, removed files

Use the previous release's section as a template for tone and depth.

### 2. Bump the version in `package.json`

| Change type     | Bump     | Example          |
| --------------- | -------- | ---------------- |
| Breaking       | `MAJOR`  | 0.2.5 → 1.0.0   |
| New feature     | `MINOR`  | 0.2.5 → 0.3.0   |
| Bug fix only    | `PATCH`  | 0.2.5 → 0.2.6   |

### 3. Verify the build

```bash
npm run clean
npm run build
npm run typecheck
npm test
```

### 4. Inspect the publish tarball

```bash
npm pack --dry-run
```

Check the output for:
- **Total files** - should be ~600 (was 1007 before publish-prep)
- **Package size** - should be ~785 KB
- **No source maps** (`.map` files) - confirmed by the `dist/**/*.js` +
  `dist/**/*.d.ts` pattern in `package.json` `files`
- **No Python** (`.py` files) - confirmed by `.npmignore` and the
  project's pure-JS/TS policy
- **No dev configs** (eslint, prettier, .gitignore) - confirmed by
  `.npmignore`

### 5. Tag and publish

```bash
git add -A
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
npm publish
```

### 6. Post-publish

- Verify the package appears on npmjs.com
- Update any downstream consumers
- Announce in release notes (if applicable)

## Questions?

Open an issue on [GitHub](https://github.com/kifirkin/pi-braid/issues).
