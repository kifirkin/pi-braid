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
  `check_topic_drift`/`reset_topic_anchors`, `session_search`/`session_query`.
  Each can be one tool with actions. The `memory_recall` + `memory_episodes` +
  `memory_heuristics` consolidation (→ `memory` tool) is already done.
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
| `docs/` | Reference docs (plan, audits, deep-dives) - NOT a DOX subtree, but referenced | (no AGENTS.md - durable reference) |
| `test/` | Test harness; no AGENTS.md needed (tests are leaf) | (no AGENTS.md) |
| `scripts/` | Build/lint helpers; leaf | (no AGENTS.md) |
| `evaluation/` | Benchmarks (JS only post-2026-06-10); leaf | (no AGENTS.md) |

## User Preferences (durable)

- **Prefer implementing, improving, or fixing over removal.** Only remove truly dead code (unreferenced, deprecated with no path forward). This is a hard project rule.
- **Braid is a value-add layer over pi core.** Out-of-scope tools (debug/research affordances) get flagged in the plan but not auto-removed. See `docs/TOOL-INVENTORY-AUDIT.md`.
- **Test-based lint over ESLint custom rules.** Q15 was deferred. Use scan-style test files (e.g., `test-promise-allsettled-pattern.mjs`) as the linting substrate. ESLint setup is a separate project.
- **Module-level `let` is banned for stateful data.** Use `getExtensionState(ctx, key, factory)` for per-session state, `global-state.ts` for process-global. The 4 documented exceptions live in `src/lib/state/AGENTS.md`.
