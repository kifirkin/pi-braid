<!-- status: current -->

# Contributing to pi-braid

Thanks for your interest. This file is for **braid contributors** — people working on braid itself. If you only want to *use* braid, see [`README.md`](README.md) and [`docs/SETUP.md`](docs/SETUP.md).

---

## Development setup

```bash
git clone https://github.com/kifirkin/pi-braid.git
cd pi-braid
npm install
npm run build
```

Verify your environment:

```bash
npm run typecheck   # tsc --noEmit, no output is success
npm run test        # 81+ runtime tests
npm run check:deps  # layer-boundary check
npm run check:docs  # every .md has a status marker
npm run check:doc-drift  # no API references in 'current' docs that aren't in code
npm run ci:check    # all of the above in one shot
```

---

## Commands

| Command               | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `npm run typecheck`   | TypeScript check (no emit)               |
| `npm run build`       | Compile to `dist/`                       |
| `npm run test`        | Build + run runtime tests                |
| `npm run lint`        | ESLint check                             |
| `npm run format`      | Prettier formatting                      |
| `npm run clean`       | Remove build artifacts                   |
| `npm run check:deps`  | Layer-boundary check (no cross-import violations) |
| `npm run check:docs`  | Every .md in scope has a `<!-- status: -->` marker |
| `npm run check:doc-drift` | No drift between `current`-marked docs and code |
| `npm run ci:check`    | typecheck + check-deps + check-docs + check-doc-drift + test |

---

## Project structure

The layout follows an **agent-loop model** (see [`src/AGENTS.md`](src/AGENTS.md) for the full rationale):

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

The directory tree mirrors the *runtime loop*, not the *feature taxonomy* — the goal is that someone reading the source can predict "where would code for X live?" by understanding how the agent runs.

---

## Code style

- TypeScript strict mode
- ESM modules (`.js` extension in imports, even for `.ts` sources)
- `createLogger(name)` for logging — **never** `console.*`
- `getExtensionState(ctx, key, factory)` for session-scoped state — **never** module-level `let` for mutable state
- Async functions must use `fs/promises`, not sync I/O
- Empty `catch {}` blocks only for `JSON.parse` of untrusted data — otherwise log the error
- No Python — the project is pure JS/TS

---

## Extension anatomy

Extensions register via the pi SDK:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

---

## The dox framework

Every `src/**/AGENTS.md`, every `docs/*.md`, and every top-level `*.md` is a *living contract* for that subtree. Read the parent and child AGENTS.md along any path you intend to edit.

All such files must carry a `<!-- status: ... -->` marker near the top:
- **`current`** — doc describes code as-is
- **`forward-looking`** — doc describes planned state, not yet shipped
- **`aspirational`** — doc describes long-term vision
- **`historical`** — doc describes past state, archived or completed

`npm run check:docs` enforces the marker. `npm run check:doc-drift` greps tracked API names (e.g. `completeSimple`, `behaviorModeSection`) in docs vs source — fails if a `current`-marked doc references an API not present in code.

When you change an API surface, update both code and any docs that reference it, or mark the doc `forward-looking` if it's the plan.

See [`AGENTS.md`](AGENTS.md) for the full DOX contract.

---

## Testing

Tests are in `test/runtime/` as `.mjs` files. The runner (`scripts/run-tests.mjs`) recursively discovers all `.mjs` files in the test tree.

```bash
# Run all tests
npm run test

# Run a single test (bypassing the build step)
node test/runtime/test-enforcement.mjs
```

Test quality bar: each test must have **real assertions on real behavior**, not just file-existence checks or reimplementations of algorithms. A test with zero real assertions is a "nonsense test" — delete it.

When testing prompt-builder / identity constants, mirror the pattern in `test/runtime/lib/test-prompt-builder-directive.mjs`: existence, render-into-prompt, single-sentence / N-sentence check, no-meta-LLM, no-software-only-vocab.

---

## Pull requests

1. Branch from `main`
2. Make your changes
3. Run the quality gates:
   ```bash
   npm run typecheck
   npm run test
   npm run check:deps
   npm run check:docs
   npm run check:doc-drift
   ```
4. Open a PR against `main`

Each commit message should reference the relevant P-tier item from `docs/ROADMAP.md` or use the prefix conventions below.

### Commit message conventions

| Prefix      | Use for                                                    |
| ----------- | ---------------------------------------------------------- |
| `feat:`     | New feature (extension, tool, mode)                        |
| `fix:`      | Bug fix                                                    |
| `refactor:` | Internal change with no behavior delta                     |
| `test:`     | Test-only changes                                          |
| `docs:`     | Documentation-only                                         |
| `chore:`    | Build / CI / dependency bumps                              |
| `prompt-builder:` | Identity framing / behavior-mode edits — touches the system prompt |

---

## Module system

Extensions are registered in the flat manifest at [`src/extensions/manifest.ts`](src/extensions/manifest.ts). The `module` field on each entry is a label used by the subagent API to enable / disable a group of extensions. It has no structural role in the directory tree.

Config resolution order (highest priority first):

1. Runtime subagent API (`/modules-toggle`, `/modules-enable`, `/modules-disable`)
2. `~/.pi/agent/settings.json` → `braid.modules`
3. `BRAID_MODULES` env var
4. Defaults (all non-opt-in extensions enabled)

See [`docs/SETUP.md`](docs/SETUP.md) § Module toggling for the user-facing form of the same.

---

## Storage convention

All braid-specific data goes under `~/.pi/agent/braid/`. Use constants from [`src/lib/config/braid-paths.ts`](src/lib/config/braid-paths.ts) — never hardcode paths.

---

## Release process

Cutting a new release involves: version bump, CHANGELOG update, build verification, and npm publish.

### 1. Update CHANGELOG.md

Add a new section at the top under `## [VERSION] - DATE` with:

- **Added** — new features, new tools, new modules
- **Changed** — modifications to existing behavior, refactors
- **Fixed** — bug fixes
- **Removed** — deleted features, dropped tools, removed files

Use the previous release's section as a template for tone and depth.

### 2. Bump the version in `package.json`

| Change type   | Bump      | Example          |
| ------------- | --------- | ---------------- |
| Breaking      | `MAJOR`   | 0.2.5 → 1.0.0   |
| New feature   | `MINOR`   | 0.2.5 → 0.3.0   |
| Bug fix only  | `PATCH`   | 0.2.5 → 0.2.6   |

### 3. Verify the build

```bash
npm run clean
npm run build
npm run typecheck
npm run test
```

### 4. Inspect the publish tarball

```bash
npm pack --dry-run
```

Check the output for:

- **Total files** — ~600 (was 1007 before publish-prep)
- **Package size** — ~785 KB
- **No source maps** (`.map` files) — confirmed by the `dist/**/*.js` + `dist/**/*.d.ts` pattern in `package.json` `files`
- **No Python** (`.py` files) — confirmed by `.npmignore` and the project's pure-JS/TS policy
- **No dev configs** (eslint, prettier, .gitignore) — confirmed by `.npmignore`

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

---

## Questions?

Open an issue on [GitHub](https://github.com/kifirkin/pi-braid/issues).
