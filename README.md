<!-- status: current -->

# pi-braid 🥨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)

Metacognitive extension suite for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent). Adds enforcement, memory, reasoning, self-improvement, and structured cognitive signals on top of the base agent session.

> **⚠️ Early-stage software.** APIs may change. Not production-hardened.

## What It Does

pi-braid extends pi with a suite of cognitive extensions:

- **Enforcement** - belief policy engine, structured signal delivery (L1-L3), sycophancy detection, verification nudges, behavioral pattern evolution
- **Memory** - multi-store memory system: cognitive memory (semantic + episodic + heuristic via `memory-agent-bridge`), context lifecycle (S-MMU proposals, compaction, rotation), cross-session recall, scratchpad task tracking, and workspace snapshots — all with cross-search
- **Reasoning** - topic drift detection, bidirectional verification, claim tracking, contradiction detection
- **Self-improvement** - heuristic evolution, dreamer (offline consolidation), SOP extraction, degradation detection, reflection
- **Session management** - context lifecycle (proposals, compaction, rotation), scratchpad task tracking
- **Utilities** - healthcheck, timers, system monitoring, web research, workspace snapshots

## Extension Map

The following diagram shows how braid's extensions relate to each other and to the pi base agent:

```
┌──────────────────────────────────────────┐
│            pi-coding-agent               │
│         (base agent loop + tools)        │
├──────────────────────────────────────────┤
│   prompt-builder (system prompt)         │
├──────────────┬───────────────────────────┤
│  enforcement │  metacognition            │
│  (signals,   │  (think, verify,          │
│   drift,     │   hypothesize, finalize)  │
│   reflection)│                           │
├──────────────┴───────────────────────────┤
│  memory-agent-bridge                     │
│  (memory_store, memory, conflict_qa,     │
│   explore_paths, session)                │
├──────────────────────────────────────────┤
│  three-memory-stores  │  context-lifecycle│
│  (episodes/heuristics)│  (S-MMU proposals)│
├──────────────┬───────────────────────────┤
│heartbeat-    │  scratchpad               │
│scheduler     │  (task tracking)           │
│(budgets,     │  workspace-snapshot        │
│ auto-finalize)│  timer                    │
├──────────────┴───────────────────────────┤
│  session-recall  │  health-maintenance   │
│  error-tracking  │  latent-activator     │
│  watchdog        │  analytics            │
└──────────────────────────────────────────┘
```

## Installation

```bash
# Clone
git clone https://github.com/kifirkin/pi-braid.git
cd pi-braid
npm install

# Build
npm run build

# Run with pi
pi -e /path/to/pi-braid
```

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 20
- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) ≥ 0.77.0

## Configuration

pi-braid reads settings from `~/.pi/agent/settings.json` under the `braid` key:

```json
{
  "braid": {
    "suppressNudges": false
  }
}
```

All braid-specific data is stored under `~/.pi/agent/braid/`.

### Module System

There is **no module-grouping abstraction** — the manifest is a flat list.
The `module` field on certain entries is a label for toggling groups via
`BRAID_MODULES`:

```bash
# Default — all non-opt-in extensions enabled
unset BRAID_MODULES

# Toggle individual extensions: +name to enable, -name to disable
export BRAID_MODULES="all,-error-tracking"
export BRAID_MODULES="-enforcement"

# Group toggle (only works for entries with a `module` field)
export BRAID_MODULES="+heartbeat"     # enable heartbeat extensions
```

See [AGENTS.md](AGENTS.md) for the extension inventory and [docs/](docs/) for
detailed documentation.

## Bundled Skills

More than 25 skills are available (shipped separately in [pi-braid-skills](https://github.com/kifirkin/pi-braid-skills)). See the skill descriptions in the system prompt's `<available_skills>` block for the full list.

## Extension Overview

All extensions are registered via a flat manifest at `src/extensions/manifest.ts`. The `module` field on each entry is a convenience label for group toggling (e.g. `BRAID_MODULES=+heartbeat`) — it has no structural role in the directory tree.

| Category      | Extension              | Purpose                                                    |
| ------------- | ---------------------- | ---------------------------------------------------------- |
| **Core**      | polyfill               | pi API polyfills, vision model config                      |
| _(always-on)_ | metacognition          | `think`, `hypothesize`, `finalize`, `verify` tools         |
|               | scratchpad             | `scratchpad` tool                                          |
|               | input-polisher         | Input proofreading & translation                           |
|               | prompt-builder         | System prompt assembly                                     |
|               | agent-environment      | Time/status L1 context injection                           |
|               | workspace-snapshot     | `workspace_snapshot` tool — capture/list/diff/restore      |
| **Cognitive** | reasoning              | Reasoning quality detector, verify-before-done nudge       |
|               | topic-drift            | `topic_drift` tool — anchor tracking                       |
|               | sycophancy-detector    | Contrast-based sycophancy detection                        |
|               | turn-outcome           | Turn outcome loop detection                                |
| **Enforcement**| enforcement           | RepE-based behavioral enforcement, turn validation         |
| **Memory**    | three-memory-stores    | Episodic, heuristic, tool-reliability persistence          |
|               | memory-agent-bridge    | `memory_store`, `memory`, `conflict_qa`, `explore_paths`   |
|               | session-recall         | `session` tool — cross-session context recall              |
|               | context-manager        | `context_compress`, `context_inspect`, `context_navigate`  |
|               | context-lifecycle      | `context_proposals` — S-MMU context management             |
|               | scratchpad             | `scratchpad` task tracking (always-on, listed above)       |
|               | workspace-snapshot     | `workspace_snapshot` (always-on, listed above)             |
| **Heartbeat** | heartbeat-scheduler    | Token budgets, auto-finalize, dreamer, recaller, evolver   |
|               | analytics              | Session metrics, A/B variants, tool reliability            |
| **System**    | timer                  | Non-blocking timers for session tasks                      |
|               | auto-recovery          | Auto-recovery from hangs                                   |
|               | latent-activator       | `behavior` tool — behavior pattern activation              |
|               | watchdog _(opt-in)_    | Session monitoring and error alerting                      |
|               | health-maintenance _(opt-in)_ | Health-based checkpointing, degradation detection    |
|               | error-tracking _(opt-in)_     | Error logging: `error_list`, `error_get`            |

**Note on pi-core builtins:** The base agent provides several tools regardless of braid:
`healthcheck`, `observatory`, `diff`, `research`, `system_monitor`, `read_document`,
`render_pdf_page`, and others. These are listed in the system prompt's `Available tools`
section and are always available. The table above covers only braid-registered extensions.

## Development

```bash
npm run typecheck   # TypeScript check
npm run build       # Compile to dist/
npm run test        # Build + run 83 runtime tests
npm run lint        # ESLint
npm run format      # Prettier
```

For the full development guide, see [AGENTS.md](AGENTS.md).

Documentation has been extracted to a separate repository ([pi-braid-docs](https://github.com/earendil-works/pi-braid-docs)) to keep the codebase lean.

## License

[MIT](LICENSE)
