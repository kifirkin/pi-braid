# pi-braid

Self-contained [pi](https://github.com/badlogic/pi-mono) extension bundling develop-branch functionality: cognitive systems, planning, enforcement, context management, and advanced tools.

## What's Included

### Extensions (33 organized in 6 categories)

| Category | Count | Extensions |
|----------|-------|------------|
| **core** | 7 | `prompt-builder`, `prompt-guardian`, `context-manager`, `context-lifecycle`, `polyfill`, `enforcement`, `watchdog` |
| **cognitive** | 6 | `metacognition`, `planner`, `latent-activator`, `cognitive-systems`, `reasoning`, `heartbeat-scheduler` |
| **memory** | 3 | `three-memory-stores`, `session-recall`, `scratchpad` |
| **tools** | 9 | `repl`, `healthcheck`, `browser`, `codebase-tree`, `web-fetch`, `vision`, `docs`, `wait-review`, `error-capture` |
| **analytics** | 5 | `analytics`, `feedback`, `evolve`, `rate-limiter`, `agent-environment` |
| **ux** | 3 | `ux`, `assistant`, `user-message-preprocessor` |

See [docs/archive/H8_extension_docs.md](docs/archive/H8_extension_docs.md) for full extension catalog with tools, events, and descriptions.

### Tools (37 registered)

```
memory_store, memory_recall, memory_list, memory_get,
context_tag, context_log, context_checkout, context_prune, context_audit,
think, hypothesize,
scratchpad,
goal, plan, finalize,
signal_complete, signal_stuck,
error_list, error_get, error_clear, error_stats,
healthcheck, evolve, feedback_status,
read_document, analyze_image,
pijul_log, pijul_reset, pijul_surgical_rewind,
codebase_tree,
list_deleted_prompts, recover_prompt, save_current_prompt,
preprocessor_config, preprocessor_stats,
check_resources, set_budget, record_usage,
tool_usage_patterns, explore_paths,
session_search, session_query
```

### Skills (13)

`code-search`, `documentation`, `healthcheck`, `meta-improvement`, `paper-writer`, `pi-reference`, `process-control`, `research`, `software-engineer`, `tone-quality`, `vcs-tools`, `visual-validator`

### Commands (23)

`/utility-model`, `/vision-model`, `/retry`, `/analytics`, `/analytics:all`, `/enforcement-on`, `/enforcement-off`, `/enforcement-stats`, `/feedback-*`, `/preprocessor`, `/watchdog-status`, `/rate-cancel`, `/analyze-image`, `/loop-*`, `/scratchpad-clear`, `/file-info`

## Architecture

```
pi-braid/
┌─────────────────────────────────────────────────────────────────┐
│                        pi-braid Agent                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │        prompt-builder            │
              │  (system prompt reconstruction) │
              └─────────────────┬───────────────┘
                                │
    ┌───────────────────────────┼───────────────────────────┐
    │                           │                           │
    ▼                           ▼                           ▼
  Cognitive                  Memory                     Tools
  ┌──────────┐            ┌──────────┐              ┌──────────┐
  │metacog.  │            │3-memory  │              │repl      │
  │planner   │            │scratchpad│              │browser   │
  │latent    │            │session   │              │codebase  │
  │heartbeat │            │recall    │              │web-fetch │
  └──────────┘            └──────────┘              └──────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │       context-manager             │
              │   (pruning / rotation / compact)  │
              └─────────────────┬─────────────────┘
                                │
    ┌───────────────────────────┼───────────────────────────┐
    │                           │                           │
    ▼                           ▼                           ▼
  Enforcement              Analytics                  Lifecycle
  ┌──────────┐            ┌──────────┐             ┌──────────┐
  │whispers  │            │analytics  │             │context   │
  │watchdog  │            │feedback   │             │lifecycle │
  │rate-limit│            │evolve     │             │polyfill  │
  └──────────┘            └──────────┘             └──────────┘
```

### Extension Catalog

#### Core Extensions
- **`prompt-builder`** — System prompt reconstruction from structured state (not text parsing)
- **`prompt-guardian`** — Detects and neutralizes prompt injection attacks
- **`context-manager`** — Context pruning, compaction, rotation (prevents overflow)
- **`context-lifecycle`** — Session start/end lifecycle with cleanup and isolation
- **`polyfill`** — API compatibility across pi versions (session tree, vision model detection)
- **`enforcement`** — Soft behavioral nudges via whispers (no hard blocking)
- **`watchdog`** — Monitors problematic patterns (infinite loops, repeated failures)

#### Cognitive Extensions
- **`metacognition`** — Think/hypothesize/finalize structured reasoning tools
- **`planner`** — Goal and plan management (execution-level planning)
- **`latent-activator`** — Identity-based behavior activation at runtime (40+ behaviors)
- **`cognitive-systems`** — Core architecture: topic drift, reasoning metrics, belief policy, MARS
- **`reasoning`** — Chain-of-thought with configurable depth
- **`heartbeat-scheduler`** — Proactive cognitive scheduling with meta-learning optimizer

#### Memory Extensions
- **`three-memory-stores`** — Episodic, heuristics, tool reliability per paper 2604.14475
- **`session-recall`** — Cross-session search and query
- **`scratchpad`** — Structured session memory with task/goal/plan tracking

#### Tool Extensions
- **`repl`** — Interactive JavaScript execution
- **`healthcheck`** — Diagnostic suite for tools and extensions
- **`browser`** — Playwright-based browser automation
- **`codebase-tree`** — Directory structure exploration
- **`web-fetch`** — Web page fetching with secret scanning
- **`vision`** — Image analysis (sprites, UI, layout)
- **`docs`** — Document reading (doc, docx, rtf, html, txt, pdf)
- **`wait-review`** — Polls docs/ for researcher review files
- **`error-capture`** — Auto-catch and log extension errors

#### Analytics Extensions
- **`analytics`** — Tool usage analytics (exports to `~/.pi/logs/braid-metrics.jsonl`)
- **`feedback`** — User feedback collection and recommendations
- **`evolve`** — Self-evolution: health checks, checkpoints, degradation detection
- **`rate-limiter`** — Prevents tool abuse via throttling
- **`agent-environment`** — Exposes agent environment info as structured data

#### UX Extensions
- **`ux`** — User experience tools and progressive disclosure
- **`assistant`** — General purpose assistant tooling
- **`user-message-preprocessor`** — Message preprocessing (stripping, normalization)

### Quick Commands

```bash
# Check heartbeat status
/heartbeat:status

# View analytics
/analytics
/analytics:all

# Run diagnostics
/healthcheck

# Check evolve health
/evolve:health

# Search past sessions
/session_search debugging

# Analyze an image
/analyze_image /path/to/screenshot.png
```

## Installation

### Quick Start

```bash
pi -e /path/to/pi-braid
```

### Settings (recommended)

In `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-braid"]
}
```

### Development vs Release

**Development** — point to source directory for live development:

```json
{
  "extensions": ["/path/to/pi-braid"]
}
```

**Release** — build and point to the bundle:

```bash
npx esbuild src/index.ts --bundle --format=esm --outdir=dist --platform=node
```

```json
{
  "extensions": ["/path/to/pi-braid/dist/index.js"]
}
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full details.

## Dependencies

- `typebox` (^1.0.0)
- `@mariozechner/pi-coding-agent` (peer)
- `@mariozechner/pi-agent-core` (peer)
- `@mariozechner/pi-ai` (peer)

## Build & Test

```bash
# Type check
npx tsc --noEmit --skipLibCheck

# Build bundle
npx esbuild src/index.ts --bundle --format=esm --outdir=dist --platform=node

# Run runtime tests
node test/runtime/test-*.mjs
```

## Project Structure

```
pi-braid/
├── src/
│   ├── index.ts              # Main entry point (loads 33 extensions)
│   ├── extensions/          # 33 extension modules
│   │   ├── prompt-builder/  # System prompt reconstruction
│   │   ├── context-manager/ # Context overflow handling
│   │   ├── heartbeat-scheduler/  # Proactive cognitive scheduling
│   │   ├── metacognition/   # Think/hypothesize/finalize
│   │   ├── three-memory-stores/  # Episodic + heuristics + reliability
│   │   ├── analytics/       # Tool usage analytics
│   │   ├── evolve/         # Self-evolution
│   │   └── ...             # 25 more extensions
│   ├── lib/                 # Shared libraries
│   │   ├── belief-store.ts      # Belief store (D0.2)
│   │   ├── belief-policy-engine.ts  # Policy engine (D0.3)
│   │   ├── evidence-pool.ts     # Evidence tracking
│   │   ├── conflict-qa.ts       # Conflict resolution
│   │   ├── reasoning-metrics.ts # Reasoning metrics
│   │   └── topic-drift-detector.ts
│   └── tools/               # Built-in tools
├── skills/                  # 13 skill directories
├── docs/                    # Documentation
│   ├── archive/             # H8 extension docs
│   └── BRAID-CONSOLIDATED-TASKS.md  # Work tracker
├── evaluation/              # Benchmark suite
│   ├── README.md
│   ├── pi_rpc_benchmark.py
│   ├── bm1_multi_turn_debug.py
│   ├── bm2_code_quality.py
│   ├── br4_latent_multi_turn.py
│   └── run_benchmarks.py
└── package.json
```

## License

MIT
