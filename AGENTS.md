<!-- status: current -->

# pi-braid Developer Guide

> **DOX framework active.** This AGENTS.md is a binding work contract for the
> entire repository. Read it (and every parent/child AGENTS.md along any path
> you intend to touch) before editing. See the [dox skill](../agents/pi-braid-skills/skills/dox/SKILL.md)
> for the full contract. Last DOX pass: 2026-06-17.

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

## Doc Discipline (added 2026-06-23)

Every `.md` file in `docs/`, every `src/**/AGENTS.md`, and every top-level
`*.md` carries a `<!-- status: ... -->` HTML comment near the top. The
marker is one of:

- **`current`** — doc accurately describes the codebase as-is
- **`forward-looking`** — doc describes planned/target state, not yet shipped
- **`aspirational`** — doc describes long-term vision without a concrete plan
- **`historical`** — doc describes past state, archived or completed

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
both code and any docs that reference it — or mark the doc
`forward-looking` if it's the plan.

Add new API names to `TRACKED_NAMES` in `check-doc-drift.mjs` as new
drift surfaces emerge.

## Tool Inventory

22 tools are registered by braid extensions plus ~12 from pi-core
built-ins (read, write, edit, bash, grep, find, ls, sleep, web_fetch,
batch_web_fetch, analyze_image, etc.). The May 2026 audit
(`docs/archive/TOOL-INVENTORY-AUDIT.md`) is archived; its actionable
items have been folded into ROADMAP.md. Key ongoing concerns:

- **In scope** (braid's value-add): cognitive, metacognition, memory,
  context management, error tracking, health, behavior, timer. Keep these.
- **CRUD-shaped consolidation**: some tools are better as action-based
  APIs within fewer tool surfaces. The `memory_recall` + `memory_episodes` +
  `memory_heuristics` → `memory` consolidation is already done.
  `verify_claim`/`verify_decomposition` could merge into `verify`.
- **scratchpad vs task**: both track progress but serve different
  purposes. scratchpad = structured state (goal/plan/decisions/learnings
  with priority + persistence + recycling). task = simple TODO list
  with priority + dependencies. Document the distinction in each tool's
  description; do not merge.

## Child DOX Index

| Path | Owns | AGENTS.md |
|---|---|---|
| `src/` | Top-level architecture: extensions/lib/loader/types split, delivery channel rules | [src/AGENTS.md](src/AGENTS.md) |
| `src/extensions/` | All 25+ extensions grouped by agent-loop phase (core/cognitive/memory/scheduling/self/heartbeat/enforcement) | (per-extension AGENTS.md below) |
| `src/extensions/core/` | Prompt-builder, input-polisher, agent-environment, polyfill | [src/extensions/core/AGENTS.md](src/extensions/core/AGENTS.md) |
| `src/extensions/cognitive/` | Metacognition, reasoning, sycophancy/topic-drift/turn-outcome detectors | [src/extensions/cognitive/AGENTS.md](src/extensions/cognitive/AGENTS.md) |
| `src/extensions/enforcement/` | Turn-pipeline infrastructure (handlers, detection, substate) | [src/extensions/enforcement/AGENTS.md](src/extensions/enforcement/AGENTS.md) |
| `src/extensions/heartbeat/` | Background daemons (scheduler, analytics) | [src/extensions/heartbeat/AGENTS.md](src/extensions/heartbeat/AGENTS.md) |
| `src/extensions/memory/` | All persistent state (context-lifecycle, three-stores, agent-bridge, etc.) | [src/extensions/memory/AGENTS.md](src/extensions/memory/AGENTS.md) |
| `src/extensions/scheduling/` | Time triggers (timer) | [src/extensions/scheduling/AGENTS.md](src/extensions/scheduling/AGENTS.md) |
| `src/extensions/self/` | Self-management (health, error-tracking, watchdog, etc.) | [src/extensions/self/AGENTS.md](src/extensions/self/AGENTS.md) |
| `src/lib/` | Library subsystems (13 subdirs, all have AGENTS.md) | [src/lib/AGENTS.md](src/lib/AGENTS.md) |
| `src/loader/` | Extension loader + subagent API | [src/loader/AGENTS.md](src/loader/AGENTS.md) |
| `docs/` | Reference docs: `ROADMAP.md` (actionable), `CODE-QUALITY-REMEDIATION-PLAN.md` (shipped record), `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (whisper catalog), `FRAGILE-HEURISTICS-INVENTORY.md`, `STATE-POLICY.md`, `ARXIV-CITATIONS-AUDIT.md`. 4 superseded audits in `archive/`. See `docs/README.md`. | (no AGENTS.md - durable reference) |
| `HANDOFF.md` | Fresh-session transfer document. State-of-codebase summary, last 5 commits, verification commands, priority queue. Written for an agent with no prior context. | (no AGENTS.md - ephemeral transfer aid, refresh per session) |
| `test/` | Test harness; no AGENTS.md needed (tests are leaf) | (no AGENTS.md) |
| `scripts/` | Build/lint helpers; leaf | (no AGENTS.md) |
| `evaluation/` | Benchmarks (JS only post-2026-06-10); leaf | (no AGENTS.md) |

## User Preferences (durable)

- **Prefer implementing, improving, or fixing over removal.** Only remove truly dead code (unreferenced, deprecated with no path forward). This is a hard project rule.
- **Braid is a value-add layer over pi core.** Out-of-scope tools (debug/research affordances) get flagged in the plan but not auto-removed. See `docs/archive/TOOL-INVENTORY-AUDIT.md` (archived 2026-06-17) and the current state in `docs/ROADMAP.md`.
- **Test-based lint over ESLint custom rules.** Q15 was deferred. Use scan-style test files (e.g., `test-promise-allsettled-pattern.mjs`) as the linting substrate. ESLint setup is a separate project.
- **Module-level `let` is banned for stateful data.** Use `getExtensionState(ctx, key, factory)` for per-session state, `global-state.ts` for process-global. The 28 documented exceptions live in `src/lib/state/AGENTS.md`.
