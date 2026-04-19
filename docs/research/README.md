# Thread: Daemon Orchestrator

**Research Question**: How do we build a persistent, multi-agent operating system that orchestrates pi subagents?

## Core Thesis

pi-braid transforms from "extension-packed agent" to "daemon orchestrator" — a singleton master that spawns tmux-based workers, maintains persistent state, and provides multiple user interfaces.

## Research Papers

### Architecture
| Paper | arXiv | Key Finding |
|-------|-------|-------------|
| **Aethon** | 2604.12129 | Reference-based replication, copy-on-write semantics for fast instantiation |
| **AIBuildAI** | 2604.14455 | Manager + Designer + Coder + Tuner hierarchy |
| **Governance by Design** | 2604.11337 | Parsonian AGIL framework for agent societies |

### Coordination
| Paper | arXiv | Key Finding |
|-------|-------|-------------|
| **HECTOR** | 2604.10892 | Three-layer hierarchical coordination (human ↔ fleet ↔ teams) |
| **CoopEval** | 2604.15267 | Cooperation-sustaining mechanisms |

### Supporting
| Paper | arXiv | Key Finding |
|-------|-------|-------------|
| **Autogenesis** | 2604.15034 | Self-evolution with rollback |
| **Evo-MedAgent** | 2604.14475 | Three memory stores |
| **Credo** | 2604.14401 | Declarative belief + policy system |

## Architecture

```
┌─────────────────────────────────────────┐
│  LAYER I: User Interfaces (HECTOR)       │
│  tmux TUI | web UI | telegram Bot        │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  LAYER II: Braid-OS Daemon (Master)    │
│  Session Manager | Task Queue | Registry │
│  Leader Election | Belief Engine         │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  LAYER III: Worker Pool (tmux)          │
│  Generalist | Specialist | Specialist    │
└─────────────────────────────────────────┘
```

## Key Innovations

### 1. tmux Workers
- Process isolation via tmux sessions
- Observable: `tmux capture-pane` for live output
- Persistent: sessions survive terminal close
- Controllable: `tmux send-keys` to inject

### 2. Raft-Inspired Leader Election
- Single-machine: lock file with heartbeat
- Multi-machine: full Raft consensus
- Automatic failover on crash

### 3. Aethon-Inspired Instantiation
- Reference-based workers (not duplication)
- Copy-on-write memory
- Pre-warmed worker pool

## Implementation

See `docs/daemon-orchestrator/BRAID-OS-DAEMON-LAYER-PROPOSAL.md`

## Connection to Other Threads

- **cognitive-control**: Heartbeat scheduler becomes daemon heartbeat
- **measurement**: Metrics collected at daemon layer
- **agent-architecture**: Workers use three memory stores

## Status

- [x] Research complete
- [ ] Proposal written
- [ ] Core daemon prototype
- [ ] tmux integration
- [ ] User interfaces
