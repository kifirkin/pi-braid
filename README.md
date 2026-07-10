<!-- status: current -->

# pi-braid 🥨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![pi-coding-agent ≥ 0.80](https://img.shields.io/badge/pi--coding--agent-%E2%89%A50.80-blueviolet)](https://github.com/mariozechner/pi-coding-agent)

Metacognitive extension suite for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent). Adds enforcement, memory, reasoning, self-improvement, and structured cognitive signals on top of the base agent session.

> **⚠️ Early-stage software.** APIs may change. Not production-hardened.

---

## What it does

pi-braid extends pi with a metacognitive layer:

- **Enforcement** — belief-policy engine, structured signal delivery (L1–L3), sycophancy detection, verification nudges, behavioral pattern evolution
- **Memory** — three-store recall (semantic + episodic + heuristic), cross-session context, scratchpad task tracking, workspace snapshots, conflict resolution
- **Reasoning** — topic-drift detection, bidirectional verification, claim tracking, contradiction detection
- **Self-improvement** — heuristic evolution, dreamer (offline consolidation), SOP extraction, degradation detection, reflection
- **Utilities** — healthcheck, timers, system monitoring, web research, context lifecycle (S-MMU proposals, compaction, rotation)

It runs as a pi *extension package* — install once, use everywhere on your pi session.

---

## Fast start (TL;DR)

```bash
# 1. Clone
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build

# 2. Register with pi (one-time, user-global)
echo '{ "packages": ["file:~/pi-braid"] }' > ~/.pi/agent/settings.json

# 3. Use pi as normal — braid loads automatically
pi
```

That's it. To enable pi-braid only for one project, see [docs/SETUP.md](docs/SETUP.md) § Project-scoped install.

For the full setup reference (per-project installs, skills, module toggles, troubleshooting), see **[`docs/SETUP.md`](docs/SETUP.md)**.

---

## How it fits pi

pi loads extensions from a `packages` entry in `<cwd>/.pi/settings.json` (project) or `~/.pi/agent/settings.json` (user-global). braid is a regular extension package — point pi at it via `file:` or `git+https:` spec.

```
┌────────────────────────────────────────────┐
│              pi-coding-agent               │
│         (base agent loop + tools)          │
├────────────────────────────────────────────┤
│   prompt-builder (system prompt)           │
├──────────────┬─────────────────────────────┤
│  enforcement │  metacognition              │
│  (signals,   │  (think, verify,            │
│   drift,     │   hypothesize, finalize)    │
│   reflection)│                             │
├──────────────┴─────────────────────────────┤
│  memory-agent-bridge                       │
│  (memory_store, memory, conflict_qa,       │
│   explore_paths, session)                  │
├────────────────────────────────────────────┤
│  three-memory-stores │ context-lifecycle   │
│  (episodes/heuristics)│ (S-MMU proposals)  │
├──────────────┬─────────────────────────────┤
│ heartbeat-   │  scratchpad                 │
│ scheduler    │  workspace-snapshot         │
│ (budgets,    │  timer                      │
│  auto-finalize)│                           │
├──────────────┴─────────────────────────────┤
│  session-recall  │  health-maintenance     │
│  error-tracking  │  latent-activator       │
│  watchdog        │  analytics              │
└────────────────────────────────────────────┘
```

---

## What you get

Every extension is opt-in but defaults on. See [`src/extensions/manifest.ts`](src/extensions/manifest.ts) for the flat list. Highlights:

| Tool / Extension            | What it adds                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `think`, `verify`, `hypothesize`, `finalize` | Metacognitive tools (always-on). Use `think` for non-trivial reflection; `verify` to check work; `finalize` to close a task with evidence. |
| `scratchpad`                | Goal/plan/decision/learning tracker that survives context compaction                          |
| `memory`, `memory_store`, `conflict_qa` | Three-store recall (episodes / semantic / heuristics) cross-searched; conflict resolution between sources |
| `session`                   | Cross-session context recall (search / query past sessions)                                   |
| `context_compress`, `context_inspect`, `context_navigate` | S-MMU-style context management                                  |
| `topic_drift`               | Anchor tracking + drift detection                                                             |
| `behavior`                  | Activate / deactivate behavior patterns                                                      |
| `timer`                     | Non-blocking session-scoped timers                                                            |
| `workspace_snapshot`        | Capture / diff / restore workspace state for time-travel debugging                            |
| `system_monitor`            | CPU / memory / disk metrics                                                                   |
| `healthcheck`               | Diagnostic across all tools (recursive smoke tests)                                           |
| `web_fetch`, `batch_web_fetch`, `analyze_image` | Tool affordances for the agent and subagents                                       |

Plus ~12 pi-core built-ins (read, write, edit, bash, grep, find, ls, sleep, …) always available.

---

## Configuration

### Module toggling

braid's loader follows a **four-tier precedence** (high → low):

1. Runtime API (`/modules-toggle`, `/modules-enable`, `/modules-disable`)
2. `~/.pi/agent/settings.json` → `braid.modules`
3. `BRAID_MODULES` env var
4. Defaults — all non-opt-in extensions enabled

#### `BRAID_MODULES` env var

```bash
unset BRAID_MODULES                # default: all non-opt-in extensions

export BRAID_MODULES="all,-error-tracking"    # everything except one
export BRAID_MODULES="-enforcement"           # disable enforcement group
export BRAID_MODULES="+heartbeat"             # enable the heartbeat group (opt-in)
```

A ref can be either an **extension id** (`enforcement`, `error-tracking`) or a **module group name** (`heartbeat`, `core`, `memory`). Prefixes: `+` to enable, `-` to disable.

#### Persistent settings

In `~/.pi/agent/settings.json`:

```json
{
  "braid": {
    "modules": {
      "enforcement": true,
      "error-tracking": false,
      "heartbeat": true
    }
  }
}
```

Settings win over env var; runtime API wins over settings.

### Storage

All braid-specific data goes under `~/.pi/agent/braid/`. Use the constants in [`src/lib/config/braid-paths.ts`](src/lib/config/braid-paths.ts) — never hardcode paths.

---

## Bundled skills

braid ships 7 skills (rendered in the system prompt's `<available_skills>` block):

- **software-engineer** — debug → fix → verify, implement → decompose → execute, review → …
- **tone-quality** — write meaningful text that humans and agents actually read
- **pi-reference** — complete reference for pi's SDK, extension API, settings, RPC
- **healthcheck** — run agent self-diagnostic
- **meta-improvement** — create new skills, run self-improving experiments
- **agent-testing** — programmatic agent behavior testing
- **subagent** — spawn / monitor / coordinate pi subagents

### Optional companion packs

- [pi-braid-skills](https://github.com/kifirkin/pi-braid-skills) — 8 general-purpose development skills (code-search, code-refactoring, documentation, dox, openspec, process-control, research, vcs-tools)
- [pi-braid-contrib](https://github.com/earendil-works/pi-braid-contrib) — 9 niche/creative skills (adversarial-engagement, design-system, paper-writer, twitter, visual-creator, visual-validator, meme, looping-clanker, socratic-irony)

To install either pack:

```bash
git clone https://github.com/kifirkin/pi-braid-skills ~/pi-braid-skills
echo '{ "packages": ["file:~/pi-braid", "file:~/pi-braid-skills"] }' > ~/.pi/agent/settings.json
```

See [docs/SETUP.md](docs/SETUP.md) § Skills for more.

---

## Documentation

| Doc                                          | For                                                |
| -------------------------------------------- | -------------------------------------------------- |
| [`docs/SETUP.md`](docs/SETUP.md)             | **First-time setup, install paths, troubleshooting** |
| [`AGENTS.md`](AGENTS.md)                     | Repository structure, DOX contract, conventions     |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)         | Development setup, code style, PR workflow, release |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)         | Active roadmap + shipped items                      |
| [`docs/HISTORY.md`](docs/HISTORY.md)           | Consolidated project history, archived roadmap, research |
| [`CHANGELOG.md`](CHANGELOG.md)                   | Fresh-session transfer document (refresh per session) |
| [`CHANGELOG.md`](CHANGELOG.md)               | Release notes                                      |

---

## Development

```bash
git clone https://github.com/kifirkin/pi-braid.git
cd pi-braid
npm install
npm run typecheck   # TypeScript check
npm run build       # Compile to dist/
npm run test        # Build + run 84 runtime tests
npm run lint        # ESLint
```

For the full development guide — extension anatomy, manifest model, testing bar, release process — see **[`CONTRIBUTING.md`](CONTRIBUTING.md)** and **[`AGENTS.md`](AGENTS.md)**.

---

## License

[MIT](LICENSE)
