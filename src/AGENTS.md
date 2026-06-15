# src/ - Top-Level Architecture

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

- `extensions/memory/` - 7 sub-extensions (context-lifecycle, context-manager, memory-agent-bridge, scratchpad, session-recall, three-memory-stores, workspace-snapshot)
- `extensions/cognitive/` - 6 sub-extensions (metacognition, reasoning, sycophancy-detector, tool-safety, topic-drift, turn-outcome)
- `extensions/core/` - 4 sub-extensions (polyfill, agent-environment, prompt-builder, input-polisher)
- `extensions/self/` - 5 sub-extensions (health-maintenance, error-tracking, watchdog, auto-recovery, latent-activator)
- `extensions/scheduling/` - 1 sub-extension (timer)
- `extensions/heartbeat/` - 2 sub-extensions (heartbeat-scheduler, analytics)
- `extensions/enforcement/` - 1 root + 3 private sub-dirs (detection, handlers, substate)

A sub-extension follows the same pattern: a subdir with `index.ts`.

## See also

- `extensions/AGENTS.md` - not present; each extension subdir has its own AGENTS.md
- `lib/AGENTS.md` - index of all `lib/` subdirs
- `../AGENTS.md` (root) - build, test, extension loading

## The "What does NOT belong here" pattern

Every `extensions/<name>/AGENTS.md` should contain a `### What does NOT belong here`
section that explicitly enumerates the things that other AGENTS.md or sibling
extension directories are responsible for. This prevents:

- Code that belongs to extension A drifting into extension B.
- Tool-name coupling (e.g., enforcement knowing the name of a tool registered
  by context-manager).
- New contributors putting logic in the first folder they find that imports
  the right lib module.

The first `AGENTS.md` to use this pattern was `core/prompt-builder/AGENTS.md`.
The convention is:

> If the same paragraph could be written in two siblings' AGENTS.md, write
> it once in the parent (`extensions/<category>/AGENTS.md`) or the top-level
> `src/AGENTS.md` and link to it from each child.

A `### What does NOT belong here` section should answer four questions:

1. What do sibling extensions own that I should NOT touch?
2. What does `lib/` own that I should NOT re-implement?
3. What tools / events / types do other extensions publish that I consume?
4. What is the canonical pattern for something I want to do that has
   already been done in another extension?

## Top-level extension layout (agent-loop model)

Each category corresponds to a phase of the agent's processing loop or
a cross-cutting concern:

| Directory | Loop phase | Sub-extensions |
|---|---|---|
| `core/` | Input/Output (what LLM sees) | polyfill, agent-environment, prompt-builder, input-polisher |
| `cognitive/` | Thinking (reasoning + detection) | metacognition, reasoning, sycophancy-detector, tool-safety, topic-drift, turn-outcome |
| `memory/` | Remembering (all persistent state) | three-memory-stores, memory-agent-bridge, session-recall, context-manager, context-lifecycle, scratchpad, workspace-snapshot |
| `scheduling/` | When to act (time triggers) | timer |
| `self/` | Self-management (state, health, modes) | health-maintenance, error-tracking, watchdog, auto-recovery, latent-activator |
| `heartbeat/` | Background proactive | heartbeat-scheduler, analytics |
| `enforcement/` | Turn pipeline infrastructure | (1 root + detection/handlers/substate) |

## Delivery channel rules

There are two audiences. Pick the channel that matches:

| Audience | Sees | Channels |
|---|---|---|
| **User** (the human in the TUI) | TUI notifications, persistent UI, in-memory log buffer (via `/logs`) | `ctx.ui.notify`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, `log.*` (routes to `ctx.ui.notify` when ctx is bound) |
| **Agent** (the LLM in its next turn) | Injected messages, exactly as if the system said them | `sendTrackedMessage` — the **only** path |

Rules:

1. **`ctx.ui.notify(msg, severity)`** — use for user-facing notifications tied to user-initiated actions (tool result confirmations). Severity: `info` / `warning` / `error`. Appears as a TUI notification. **This is the correct native API for user-facing messages.**
2. **`ctx.ui.setStatus(key, text)` / `ctx.ui.setWidget(key, lines)`** — use for persistent state the user should see across renders. Footer indicator, content above/below editor. For ongoing operations ("compaction in progress", "X nudges suppressed").
3. **`log.*` (createLogger)** — the abstraction handles routing. When a session ctx is bound (via `setLoggerContext` from `src/index.ts` on session_start), log lines route to `ctx.ui.notify`. When unbound (lib/ code, pre-session-start), they go to the in-memory buffer (retrievable via `/logs`). The TUI is never corrupted. **The 206 existing call sites need no changes** — the abstraction routes transparently. Do not put "consider X" / "you should Y" advice here — the agent cannot read scrollback.
4. **`console.*`** — **suppressed by default** in third-party extensions. Will corrupt TUI rendering. Use only via `/logs level <X>` for explicit debug sessions.
5. **`sendTrackedMessage(pi, params, options, meta, bypass?)`** — the **only** path for messages the agent will read on its next turn. Set `bypassFloodCap: true` ONLY for correctness-critical wake-ups (timer fires, post-compaction resume, overflow recovery exhausted).
6. **Never** call `pi.sendMessage(...)` directly outside `src/lib/utils/injection-tracker.ts`.

Common anti-pattern: putting actionable advice in `log.warn`. The agent cannot see scrollback. If the message contains "consider X" or names a tool the agent can call, it belongs in `sendTrackedMessage`.
