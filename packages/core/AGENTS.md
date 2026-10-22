<!-- status: current -->

# pi-braid Developer Guide

> **DOX framework active.** This AGENTS.md is a binding work contract for the
> entire repository. Read it (and every parent/child AGENTS.md along any path
> you intend to touch) before editing. See the [dox skill](skills/dox/SKILL.md)
> for the full contract.

## Workspace Map

Five in-repo workspaces under `packages/` (monorepo migration):

| Workspace            | Package            | Purpose                                                                                                                                                                                                           |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | pi-braid           | Main extension host: 25+ extensions, orchestration, enforcement, memory, cognitive, heartbeat, scheduling. The orchestrator. Declares `pi.extensions` (`./src/index.ts`) and `pi.skills` (`./skills`).            |
| `packages/skills`    | pi-braid-skills    | Skill pack (one SKILL.md per skill, plus shared content in `skills/_shared/`). Content-only: no code, no deps. Carries the on-demand set for per-project loading; the core set ships with `packages/core/skills`. |
| `packages/providers` | pi-braid-providers | Provider extensions for pi (model providers, authentication, routing). Declares `pi.extensions`.                                                                                                                  |
| `packages/contrib`   | pi-braid-contrib   | Community/experimental extensions (browser, codebase, diff, observatory, path-security, repl, …). Code-only; declares `pi.extensions`, no `pi.skills`.                                                            |
| `packages/telegram`  | @pi-braid/telegram | Bidirectional Telegram channel (outbound tool + inbound pull/poller). Declares `pi.extensions`.                                                                                                                   |

`pi-braid-evaluation` (benchmarks and results) is a separate, non-public project: it is not part of this repository and nothing here should point at its location.

**Install paths:**

- `pi-braid` installed into `~/.pi/agent/local-packages` via `npm run publish:local` or a live symlink (`npm link`); see `docs/LOCAL_DEV.md`
- `pi-braid-skills` consumed by pi via path or git URL
- `pi-braid-providers` consumed by pi as provider package
- `pi-braid-contrib` consumed as subagent dependency

**Key relationships:**

- pi-braid core is the orchestrator (hosts all extensions, loader, lib)
- pi-braid-skills is a content dependency (the on-demand skill set); the core skill set loads from `packages/core/skills`
- pi-braid-providers is a provider extension
- pi-braid-contrib is a code-only sibling workspace (no `pi.skills`)

## Extension Loading

Every extension is a self-contained subdirectory under `src/extensions/`, with
`index.ts` exporting a default factory. The flat registry lives in
[`src/extensions/manifest.ts`](./src/extensions/manifest.ts) - there is **no
module-grouping abstraction**. The `module` field on each manifest entry is a
label used by the subagent API to enable/disable a group of extensions
(e.g., `BRAID_MODULES=+heartbeat`); it has no structural role in the
directory tree.

The runtime loader is `src/loader/loader.ts`. Config sources (highest
priority first): subagent API (persisted into braid's module-overrides store)
→ `braid.modules` read from pi's agent-directory settings file, then braid's
own store → `BRAID_MODULES` env var → manifest defaults. A project-scoped
`<cwd>/.pi/settings.json` is not a source: it is pi's file, behind pi's
project-trust gate, and that answer is not available while extensions load.

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
npm run test       # Build + run the runtime test suites (runner prints its total)
npm run clean      # Remove dist/ and .tsbuildinfo
npm run check:docs && npm run check:doc-drift  # Doc discipline check
npm run check:deadcode  # knip dead-code report (report-only, JSON to stdout)
memory action=recall_search query="braid"       # Surface past insights
scratchpad action=continue                      # Resume goal + plan
```

## Key Reference Docs

| Doc                                                    | What it contains                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `docs/SETUP.md`                                        | First-time setup, install paths, troubleshooting                                                                               |
| `docs/ROADMAP.md`                                      | Active items (6 open themes)                                                                                                   |
| `docs/HISTORY.md`                                      | Consolidated project history, archived roadmap, research                                                                       |
| `src/extensions/core/prompt-builder/identity.ts`       | Identity framings (identity, identity-core, repair, self-audit) + discovery stance; behavior policy lives in its owner modules |
| `src/extensions/core/prompt-builder/tool-pipelines.ts` | Guarded multi-tool usage pipelines (PROMPT-ARCHITECTURE-REDESIGN D2; design history in `docs/HISTORY.md`)                      |
| `src/extensions/enforcement/signals.ts`                | `enforcementSignals` - shared L1 signal state for prompt-builder; `pruneSignals()` evicts past the 3-turn retention window     |
| Archived audits & proposals                            | Historical proposals superseded by `docs/HISTORY.md` / `docs/ROADMAP.md`                                                       |

## State Management

Use `getExtensionState(ctx, key, factory)` for per-session state. Module-level
`let` for mutable state leaks across sessions - use the state factory instead.

Event handlers receive `(event, ctx: ExtensionContext)`. Tool execute functions receive `(toolCallId, params, signal, onUpdate, ctx)`.

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are auto-enabled on first session, except where the active-set owner says otherwise: `context-management` applies a curated default profile, so a registered tool is only active if the profile (or the operator's saved `/tools` list) names it
- Prompt-builder overrides the system prompt entirely (no native loading)
- Decompose large handlers into `handlers/*.ts` sub-modules

## Doc Discipline

Every `.md` file in `docs/`, every `src/**/AGENTS.md`, and every top-level
`*.md` carries a `<!-- status: ... -->` HTML comment near the top. The
marker is one of:

- **`current`** - doc accurately describes the codebase as-is
- **`forward-looking`** - doc describes planned/target state, not yet shipped
- **`aspirational`** - doc describes long-term vision without a concrete plan
- **`historical`** - doc describes past state, archived or completed

Two scripts enforce the discipline (run via `npm run check:docs` and
`npm run check:doc-drift`; both are part of `npm run ci:check`):

- **`scripts/check-doc-status.mjs`** fails if any in-scope doc is missing
  the marker or has an unknown value. Catch missing markers at commit time.
- **`scripts/check-doc-drift.mjs`** greps for tracked API names (e.g.
  `completeSimple`, `streamSimple`) in docs vs source. Fails if a doc
  marked `current` (or unmarked) references an API not present in code.
  This is the gate that catches target-state documentation getting
  committed as if it were current-state documentation.

Why this exists: when an audit doc describes the future state of the
codebase and lands alongside code that matches the current state, the
mismatch is invisible to a code-only review. The drift script makes
that mismatch a CI failure. When you change an API surface, update
both code and any docs that reference it - or mark the doc
`forward-looking` if it's the plan.

Add new API names to `TRACKED_NAMES` in `check-doc-drift.mjs` as new
drift surfaces emerge.

## Tool Inventory

The canonical, source-derived inventory of every tool provided/exposed by this
package is **`packages/core/TOOLS.md`** (33 documented tools: 24 braid-registered
via `pi.registerTool()` + 9 pi-native core builtins `read`/`bash`/`edit`/`write`/
`grep`/`find`/`ls`/`powershell`/`tool_search` from pi's built-in tool-search
extension, plus an appendix separating the standalone `pi-braid-contrib`
sibling package and third-party npm packages - pi-web-access, @ogulcancelik/pi-herdr).
Keep TOOLS.md and `src/extensions/core/prompt-builder/tool-guidelines.ts` in lockstep
(same tool set, same reflection strings); the `tool-guidelines` describe block in
`test/runtime/core/test-tool-pipelines.mjs` enforces the sync. The May 2026
tool-inventory audit is archived; its actionable items have been folded into
ROADMAP.md. Key ongoing concerns:

- **In scope** (braid's value-add): cognitive, metacognition, memory,
  context management, error tracking, health, behavior, timer. Keep these.
- **CRUD-shaped consolidation**: some tools are better as action-based
  APIs within fewer tool surfaces. The `memory_recall` + `memory_episodes` + <!-- doc-ref-exempt: consolidated tool named as history -->
  `memory_heuristics` → `memory` consolidation is already done. <!-- doc-ref-exempt: consolidated tool named as history -->
  `verify_claim`/`verify_decomposition` could merge into `verify`. <!-- doc-ref-exempt: proposed merge target, not a shipped tool -->
- **scratchpad vs task**: both track progress but serve different
  purposes. scratchpad = structured state (goal/plan/decisions/learnings
  with priority + persistence + recycling). task = simple TODO list
  with priority + dependencies. Document the distinction in each tool's
  description; do not merge.

## Child DOX Index

| Path                                     | Owns                                                                                                                                                             | AGENTS.md                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/`                                   | Top-level architecture: extensions/lib/loader/types split, delivery channel rules                                                                                | [src/AGENTS.md](src/AGENTS.md)                                               |
| `src/extensions/`                        | All 25+ extensions grouped by agent-loop phase (core/cognitive/memory/scheduling/self/heartbeat/enforcement)                                                     | (per-extension AGENTS.md below)                                              |
| `src/extensions/core/`                   | Prompt-builder, agent-environment, skills-tool, polyfill                                                                                                         | [src/extensions/core/AGENTS.md](src/extensions/core/AGENTS.md)               |
| `src/extensions/cognitive/`              | Metacognition, reasoning, sycophancy/topic-drift/turn-outcome detectors                                                                                          | [src/extensions/cognitive/AGENTS.md](src/extensions/cognitive/AGENTS.md)     |
| `src/extensions/enforcement/`            | Turn-pipeline infrastructure (handlers, detection, substate)                                                                                                     | [src/extensions/enforcement/AGENTS.md](src/extensions/enforcement/AGENTS.md) |
| `src/extensions/heartbeat/`              | Background daemons (scheduler, analytics)                                                                                                                        | [src/extensions/heartbeat/AGENTS.md](src/extensions/heartbeat/AGENTS.md)     |
| `src/extensions/memory/`                 | All persistent state (context-lifecycle, three-stores, agent-bridge, etc.)                                                                                       | [src/extensions/memory/AGENTS.md](src/extensions/memory/AGENTS.md)           |
| `src/extensions/scheduling/`             | Time triggers (timer)                                                                                                                                            | [src/extensions/scheduling/AGENTS.md](src/extensions/scheduling/AGENTS.md)   |
| `src/extensions/self/`                   | Self-management (health, error-tracking, watchdog, etc.)                                                                                                         | [src/extensions/self/AGENTS.md](src/extensions/self/AGENTS.md)               |
| `src/lib/`                               | Library subsystems - non-extension modules; a subdir carries an AGENTS.md where the module warrants one                                                          | [src/lib/AGENTS.md](src/lib/AGENTS.md)                                       |
| `src/loader/`                            | Extension loader + subagent API                                                                                                                                  | [src/loader/AGENTS.md](src/loader/AGENTS.md)                                 |
| `docs/`                                  | Reference docs: `ROADMAP.md` (open backlog and shipped milestones), `SETUP.md` (setup reference), `HISTORY.md` (narrative history and dated milestone summaries) | (no AGENTS.md - durable reference)                                           |
| `test/`                                  | Test harness; no AGENTS.md needed (tests are leaf)                                                                                                               | (no AGENTS.md)                                                               |
| `scripts/`                               | Build/lint/test/check helpers; leaf                                                                                                                              | (no AGENTS.md)                                                               |

## User Preferences (durable)

- **Prefer implementing, improving, or fixing over removal.** Only remove truly dead code (unreferenced, deprecated with no path forward). This is a hard project rule.
- **Braid is a value-add layer over pi core.** Out-of-scope tools (debug/research affordances) get flagged in the plan but not auto-removed. See the archived tool-inventory audit (2026-06-17) and the current state in `docs/ROADMAP.md`.
- **Test-based lint over ESLint custom rules.** ESLint custom-rule work is deferred to a separate project; use scan-style test files (e.g., `test-promise-allsettled-pattern.mjs`) as the linting substrate.
- **Module-level `let` is banned for stateful data.** Use `getExtensionState(ctx, key, factory)` for per-session state, `global-state.ts` for process-global. The 28 documented exceptions live in `src/lib/state/AGENTS.md`.
