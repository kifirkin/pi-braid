# pi-braid 🥨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)

Metacognitive extension suite for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent). Adds enforcement, memory, reasoning, self-improvement, and structured cognitive signals on top of the base agent session.

> **⚠️ Early-stage software.** APIs may change. Not production-hardened.

## What It Does

pi-braid extends pi with a layered cognitive architecture:

- **Enforcement** — belief policy engine, structured signal delivery (L1–L3 severity), sycophancy detection, verification nudges
- **Memory** — dual-store memory system: semantic (cognitive-memory) + episodic (three-memory-stores) with cross-search
- **Reasoning** — reasoning quality metrics, topic drift detection, bidirectional verification
- **Self-improvement** — heuristic evolution, dreamer (offline consolidation), SOP extraction, degradation detection
- **Session management** — context lifecycle (S-MMU), auto-finalize at 90%, scratchpad task tracking
- **Utilities** — healthcheck, timers, system monitoring, web research, code search

The agent doesn't just execute tools — it reflects, remembers, and adapts.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    pi-coding-agent                   │
│                  (base agent loop)                   │
├─────────────────────────────────────────────────────┤
│  prompt-builder  │  polyfill  │  user-msg-preproc   │
├──────────┬───────┴────────────┴──────────────────────┤
│enforcement│  cognitive-systems  │  metacognition     │
│(signals)  │  (memory, explore)  │  (think, verify)   │
├──────────┴─────────────────────┴────────────────────┤
│  heartbeat-scheduler  │  context-lifecycle (S-MMU)   │
├───────────────────────┴─────────────────────────────┤
│  three-memory-stores  │  cognitive-memory  │  dreamer│
├───────────────────────┴───────────────────┴─────────┤
│  analytics  │  retry  │  error-capture  │  watchdog  │
└─────────────────────────────────────────────────────┘
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
- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) ≥ 0.70.0

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

Extensions are grouped into modules that can be toggled:

```bash
# Enable all (default)
export BRAID_MODULES="all"

# Enable specific modules
export BRAID_MODULES="core,cognitive,memory,retry"
```

See [pi-braid-docs](https://github.com/earendil-works/pi-braid-docs) for the full documentation (extracted to separate repo).

## Bundled Skills

15 skills ship with pi-braid, covering code search, documentation, visual creation, research, and more. See [skills/](skills/) for the full list.

## Extension Overview

| Category      | Extension           | Purpose                                                         |
| ------------- | ------------------- | --------------------------------------------------------------- |
| **Cognitive** | enforcement         | Belief policy engine, structured signals, sycophancy detection  |
|               | cognitive-systems   | Memory recall, `explore_paths`, `hypothesize`, `memory_*` tools |
|               | metacognition       | `think`, `verify`, `hypothesize`, `scratchpad`                  |
|               | reasoning           | Reasoning quality metrics                                       |
| **Memory**    | three-memory-stores | Episodic, heuristic, and tool-reliability persistence           |
|               | context-lifecycle   | S-MMU context management with proposal system                   |
|               | session-recall      | Cross-session context recall                                    |
|               | context-manager     | Compaction, rotation, archive, pruning                          |
| **Heartbeat** | heartbeat-scheduler | Token budgets, auto-finalize, dreamer, recaller, evolver        |
|               | analytics           | Session metrics, A/B variants, tool reliability                 |
| **Core**      | prompt-builder      | System prompt construction with cognitive context               |
|               | polyfill            | Settings and keybindings compatibility                          |
|               | scratchpad          | Structured session memory and task management                   |
| **Retry**     | retry               | Error capture, retry state management                           |
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
npm run test        # Build + run 61 runtime tests
npm run lint        # ESLint
npm run format      # Prettier
```

For the full development guide, see [AGENTS.md](AGENTS.md).

Documentation has been extracted to a separate repository ([pi-braid-docs](https://github.com/earendil-works/pi-braid-docs)) to keep the codebase lean.

## License

[MIT](LICENSE)
