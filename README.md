# pi-braid

A self-improving coding agent harness for [pi](https://github.com/mariozechner/pi-coding-agent). Built on extension architecture with cognitive memory, enforcement signals, and structured nudges.

## Quick Start

```bash
# Install
npm install

# Type-check
npm run typecheck

# Build (tree output to dist/)
npm run build

# Run
pi -e /path/to/pi-braid/src/index.ts
```

## What It Does

pi-braid layers cognition, enforcement, and memory on top of the pi-core agent session. It doesn't replace the agent — it shapes how it behaves across sessions.

## Core Extensions

| Extension | Purpose |
|-----------|---------|
| `enforcement` | Structured signal delivery, belief policy engine, MARS reflector |
| `heartbeat-scheduler` | Token monitoring, auto-finalize at 90%, meta-learning recaller |
| `cognitive-systems` | Episode/heuristic/memory recall, explore_paths, hypothesize |
| `planner` | Budget-aware task planning with phase estimates |
| `metacognition` | Self-reflection, cognition evaluation |
| `scratchpad` | Structured session memory, task management |
| `context-lifecycle` | S-MMU context management with proposal system |

## Tool Extensions

| Extension | Tools |
|-----------|-------|
| `analytics` | `get-session-metrics`, `get-tool-reliability` |
| `browser` | `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_eval`, `browser_cookies`, `browser_content` |
| `codebase-tree` | `codebase_tree` |
| `docs` | `read_document`, `render_pdf_page` |
| `error-capture` | `error_list`, `error_get`, `error_clear`, `error_stats` |
| `evolve` | `evolve` (status/health/check/commit/rollback) |
| `healthcheck` | `healthcheck` |
| `planner` | `plan_with_budget`, `check_budget`, `set_budget` |
| `topic-drift` | `check_topic_drift`, `reset_topic_anchors` |
| `verification` | `verify_claim`, `verify_decomposition` |
| `vision` | `analyze_image` |
| `web-fetch` | `web_fetch` |
| `cognitive-systems` | `explore_paths`, `hypothesize`, `memory_*`, `get_active_behaviors` |

## Infrastructure Extensions

| Extension | Events Handled |
|-----------|---------------|
| `prompt-builder` | Builds system prompt before agent starts |
| `prompt-guardian` | Prompt safety checks |
| `polyfill` | TypeScript compatibility shims |
| `latent-activator` | Behavior pattern activation |
| `three-memory-stores` | Episodic + heuristic + tool reliability memory |
| `feedback` | Nudge frequency testing |
| `reasoning` | Reasoning metrics tracking |
| `agent-environment` | Environment time tracking |

## Extension Docs

See `docs/extensions/` for individual extension documentation.

## Project Structure

```
src/
  index.ts              # Extension registration
  extensions/           # 30 active extensions
    enforcement/        # Belief policy + structured signals
    heartbeat-scheduler/
    cognitive-systems/
    ...
  lib/                 # Shared: evidence-pool, conflict-qa, belief-policy-engine,
                        #   mars-reflector, error-classifier, reasoning-metrics,
                        #   degradation-detector, topic-drift-detector
skills/                # 12 bundled skills (SKILL.md per skill)
test/runtime/           # 22 test files
docs/
  extensions/          # Extension documentation
  skills/              # Skills catalog
  lib/                 # Library catalog
  archive/             # Historical documents
```

## Key Concepts

### Enforcement Signals (L1-L3)

- **L1** (internal): Evidence tracking, context hygiene — no message to agent
- **L2** (structured): Redundancy, verification hints — delivered via Session Signals
- **L3** (critical): Overflow failures, infrastructure errors — individual messages

### Auto-Finalize at 90%

When context reaches 90%, `heartbeat-scheduler` sends a `sendUserMessage` with `deliverAs:"steer"` forcing the agent to call `finalize(completed=false, autoProceed=true)`.

### S-MMU Context Lifecycle

`context-lifecycle` extension manages active context via: retrieval → cognition → control → action → memory, with proposal injection at 90% context.

### Compaction Window

On overflow, `pi.compact({ keep: reducedKeep })` is called with progressively smaller window. The `reducedKeep` value is computed from retry count × 0.6 factor.

## Development

```bash
# Type-check
npm run typecheck

# Build (tree output to dist/)
npm run build

# Tests
npm test

# Individual test
node test/runtime/test-<name>.mjs
```

## Skills

pi-braid ships 12 bundled skills. See `skills/*/SKILL.md` and `docs/skills/README.md`.

## Docs

- `docs/WHAT-IS-MISSING.md` — Gap registry with priorities
- `docs/OVERNIGHT-RESULTS.md` — v0.13.0 enforcement refactor results
- `docs/RESEARCH-MASTER.md` — Architecture audit, papers analyzed, research synthesis
- `docs/BRAID-NEXT-PROPOSAL.md` — v0.14.0 → v1.0 roadmap
- `docs/DEVELOPMENT.md` — Technical guide, testing, conventions
- `docs/CONSOLIDATED-DOCS-INVENTORY.md` — Full doc catalog

## Version

- **v0.13.0** — Enforcement refactor, belief policy engine, 17 enforcement tests
- **v0.14.0** — pending: structured signals wiring, compaction fix, extension docs
