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

The agent doesn't just execute tools — it reflects, remembers, and adapts across turns.

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

Some extensions can be toggled via the `BRAID_MODULES` environment variable:

```bash
# Enable all (default)
export BRAID_MODULES="all"

# Enable specific modules
export BRAID_MODULES="core,cognitive,memory,heartbeat"
```

See [AGENTS.md](AGENTS.md) for the extension inventory and [docs/](docs/) for detailed documentation.

## Bundled Skills

15 skills are available (shipped separately in [pi-braid-skills](https://github.com/kifirkin/pi-braid-skills)). See the skill descriptions in the system prompt's `<available_skills>` block for the full list.

## Extension Overview

| Category      | Extension           | Purpose                                                         |
| ------------- | ------------------- | --------------------------------------------------------------- |
| **Cognitive** | enforcement         | Belief policy engine, structured signals, sycophancy detection, BPE, MARS, dreamer, reflection |
|               | metacognition       | `think`, `verify`, `hypothesize`, `finalize`, `verify_claim`, `topic_drift`                    |
| **Memory**    | three-memory-stores | Episodic, heuristic, and tool-reliability persistence                                           |
|               | memory-agent-bridge | `memory_store`, `memory`, `conflict_qa`, `explore_paths` tools                                  |
|               | context-lifecycle   | S-MMU context management with proposal system (`context_proposals`)                             |
|               | context-manager     | Compaction, rotation, archive, pruning                                                         |
|               | session-recall      | Cross-session context recall (`session` tool)                                                   |
|               | scratchpad          | Structured session memory and task management (`scratchpad` tool)                               |
|               | workspace-snapshot  | Workspace state capture and restore (`workspace_snapshot` tool)                                 |
| **Heartbeat** | heartbeat-scheduler | Token budgets, auto-finalize, dreamer, recaller, evolver, behavioral drift                      |
|               | analytics           | Session metrics, A/B variants, tool reliability                                                 |
| **Core**      | prompt-builder      | System prompt construction with cognitive context, behavior modes, skills, memory sections       |
|               | input-polisher      | User message classification and editing                                                         |
| **System**    | health-maintenance  | Health checks, session health tool, error tracking, degradation detection                       |
|               | timer               | Non-blocking timers for session tasks                                                           |
|               | watchdog            | Session streaming state cleanup                                                                 |
|               | error-capture       | Error classification and persistence                            |
| **Tools**     | healthcheck         | System diagnostics                                              |
|               | timer               | Async timers with reminder delivery                             |
|               | latent-activator    | Behavior pattern activation                                     |
|               | observatory         | Real-time monitoring dashboard                                  |
|               | diff                | File and git diff with structured output                        |
|               | research            | Web search and fact verification                                |
|               | system-monitor      | CPU, memory, disk metrics                                       |
| **Infra**     | assistant           | Agent interaction helpers                                       |
|               | feedback            | Nudge quality feedback loop                                     |
|               | evolve              | Self-evolution with git integration                             |
|               | watchdog            | Agent health monitoring                                         |
|               | rate-limiter        | API rate limiting                                               |
|               | topic-drift         | Topic anchor tracking                                           |
|               | verification        | Claim verification, decomposition checks                        |

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
