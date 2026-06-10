# src/ — Top-Level Architecture

The pi-braid codebase is organized into four top-level directories, each
with a distinct role.

## The four-way split

| Directory | Role | What's inside |
|---|---|---|
| `extensions/` | Extension modules (loaded by the manifest) | One subdir per extension, each with `index.ts` exporting a default factory. |
| `lib/` | Library code (imported by extensions) | Pure utilities, state, types, event infrastructure. NOT loaded as extensions. |
| `loader/` | Extension loader and subagent API | The flat-extension loader. Reads `BRAID_MODULES` / `settings.json` / runtime overrides, invokes each factory. |
| `types/` | Ambient `.d.ts` declarations | Type augmentations for the `ExtensionContext` interface. Listed in `tsconfig.json` `typeRoots`. |

## The contract between `extensions/` and `lib/`

- **`extensions/`** contains code that gets loaded by the manifest and registered with pi core as an extension. Each subdir's `index.ts` exports a default function `(pi: ExtensionAPI) => void | Promise<void>`.
- **`lib/`** contains code that gets imported by extensions. It is never directly loaded by the manifest.
- **`extensions/` can import from `lib/`.** `lib/` MUST NOT import from `extensions/`. (Exceptions noted where unavoidable.)
- If a module needs to be both, put it in `lib/` and have the extension import it.

## Why a flat `extensions/` tree?

Each extension is one subdir of `extensions/`. There is no nested grouping
in the directory tree (e.g., no `extensions/ai/`, `extensions/utilities/`).
Grouping happens at the manifest level via the `module` tag on each entry.
The flat tree keeps the layout predictable and makes `find src/extensions/...` reliable.

## Sub-extensions

Some extensions are large enough to have their own sub-structure:

- `extensions/memory/` — 5 sub-extensions (context-lifecycle, context-manager, memory-agent-bridge, session-recall, three-memory-stores)
- `extensions/heartbeat/` — 2 sub-extensions (heartbeat-scheduler, analytics)
- `extensions/cognitive/` — 6 sub-extensions (metacognition, reasoning, sycophancy-detector, tool-safety, topic-drift, turn-outcome)
- `extensions/core/` — 3 sub-extensions (polyfill, agent-environment, prompt-builder)
- `extensions/agent/` — 3 sub-extensions (scratchpad, input-polisher, workspace-snapshot)
- `extensions/tools/` — 4 sub-extensions (timer, auto-singleton, auto-recovery, latent-activator)

A sub-extension follows the same pattern: a subdir with `index.ts`.

## See also

- `extensions/AGENTS.md` — not present; each extension subdir has its own AGENTS.md
- `lib/AGENTS.md` — index of all `lib/` subdirs
- `../AGENTS.md` (root) — build, test, extension loading

## Top-level extension layout

| Directory | Role | Sub-extensions |
|---|---|---|
| `core/` | Always-on infrastructure (other extensions depend on) | polyfill, agent-environment, prompt-builder |
| `cognitive/` | Reasoning tools + detectors | metacognition, reasoning, sycophancy-detector, topic-drift, turn-outcome, tool-safety |
| `agent/` | Agent's working-state tools | scratchpad, input-polisher, workspace-snapshot |
| `enforcement/` | Heavy event handling, turn pipeline | (single root extension) |
| `error-tracking/` | Error capture/replay | (single root extension) |
| `health-maintenance/` | Health checks + self-evolution | (single root extension) |
| `heartbeat/` | Proactive cognitive scheduling | heartbeat-scheduler, analytics |
| `memory/` | Three-store memory + context lifecycle | context-lifecycle, context-manager, memory-agent-bridge, session-recall, three-memory-stores |
| `tools/` | Utility tool providers | timer, auto-singleton, auto-recovery, latent-activator |
| `watchdog/` | Cross-cutting safety checks | (single root extension) |
