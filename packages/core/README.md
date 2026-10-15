<!-- status: current -->

# pi-braid 🥨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![pi-coding-agent ≥ 1.2.0](https://img.shields.io/badge/pi--coding--agent-%E2%89%A51.2.0-blueviolet)](https://github.com/earendil-works/pi)

Honest self-aware agent with a metacognitive suite and extras on top of [pi-coding-agent](https://github.com/earendil-works/pi). The suite adds enforcement, memory, reasoning, self-improvement, and structured cognitive signals on top of the pi agent session.

> **⚠️ Early-stage software.** APIs may change. Not production-hardened.

---

## What it does

pi-braid extends pi with a metacognitive layer:

- **Enforcement** - belief-policy engine, structured signal delivery (L1–L3), sycophancy detection, verification nudges, behavioral pattern evolution
- **Memory** - three-store recall (semantic + episodic + heuristic), cross-session context, scratchpad task tracking, workspace snapshots, conflict resolution
- **Reasoning** - topic-drift detection, bidirectional verification, claim tracking, contradiction detection
- **Self-improvement** - heuristic evolution, dreamer (offline consolidation), SOP extraction, degradation detection, reflection
- **Utilities** - healthcheck, timers, system monitoring, web research, context lifecycle (S-MMU proposals, compaction, rotation)

It runs as a pi _extension package_ - install once, use everywhere on your pi session.

## Install

```bash
pi install npm:pi-braid
```

Or point pi at a checked-out workspace in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/pi-braid/packages/core"]
}
```

`packages/core` carries the suite and the core skill set that ships with it;
`packages/skills` carries the on-demand skill pack, registered per project. Add
`packages/providers`, `packages/contrib`, or `packages/telegram` as needed. The install-path
reference is [`docs/SETUP.md`](docs/SETUP.md).

## What this does not do

- It is not a standalone agent. pi-coding-agent is the runtime; braid is a layer loaded into it.
- It does not replace pi's native tools. braid-registered tools sit alongside `read`/`bash`/`edit`.
- It does not run outside a pi session. Loading, state, and enforcement are per session.
- It contacts no third-party analytics or crash-reporting service. State lives on disk under `~/.pi/agent/`.

## Activation preconditions

- pi-coding-agent installed (the `@earendil-works/pi-*` peers are declared as `*` and resolve
  against the pi in your tree at install time - see [`docs/SETUP.md`](docs/SETUP.md)).
- Node.js 22+ (pi's own floor).
- The package registered under `packages` (or installed with `pi install`) so pi loads `pi.extensions`.

---

## Fast start (TL;DR)

```bash
# 1. Clone
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build

# 2. Register the workspaces you want with pi (one-time, user-global)
# Core is the metacognitive suite and its core skill set; add contrib/providers/telegram as needed.
cat > ~/.pi/agent/settings.json <<'JSON'
{
  "packages": [
    "file:~/pi-braid/packages/core",
    "file:~/pi-braid/packages/contrib"
  ]
}
JSON

# 3. Use pi as normal — braid loads automatically
pi
```

That's it. pi loads each workspace through the `pi.extensions` / `pi.skills`
fields in its `package.json` (no workspaces auto-discovery - register the paths
you want). To enable pi-braid only for one project, or to use all five
workspaces, see [docs/SETUP.md](docs/SETUP.md) § Install paths. For the full setup
reference (per-project installs, skills, module toggles, troubleshooting), see
**[`docs/SETUP.md`](docs/SETUP.md)**. New to pi and braid? Start with
**[`docs/BEGINNERS.md`](docs/BEGINNERS.md)**.

---

## How it fits pi

pi loads extensions from a `packages` entry in `<cwd>/.pi/settings.json` (project) or `~/.pi/agent/settings.json` (user-global). braid is a regular extension package - point pi at it via `file:` or `git+https:` spec.

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

This package is the **core** workspace. The monorepo also contains four
sibling packages (see [`../../README.md`](https://github.com/kifirkin/pi-braid/blob/main/README.md) for the full map):

| Package       | Role                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `core` (this) | Metacognitive extension suite - memory, enforcement, cognitive, self |
| `skills`      | Content-only skill pack (`SKILL.md` catalog, no runtime code)        |
| `contrib`     | Standalone code-only extension modules (browser, codebase, diff, …)  |
| `providers`   | Venice (agent-zero proxy) provider + multi-key ring                  |
| `telegram`    | Bidirectional Telegram channel (send, inbound, voice, pause)         |

---

## What you get

28 extensions ship; `health-maintenance` and `error-tracking` are off by default. See [`src/extensions/manifest.ts`](src/extensions/manifest.ts) for the flat list. Highlights:

| Tool / Extension                                          | What it adds                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `think`, `verify`, `hypothesize`, `finalize`              | Metacognitive tools (always-on). Use `think` for non-trivial reflection; `verify` to check work; `finalize` to close a task with evidence. |
| `scratchpad`                                              | Goal/plan/decision/learning tracker that survives context compaction                                                                       |
| `memory`, `memory_store`, `conflict_qa`                   | Three-store recall (episodes / semantic / heuristics) cross-searched; conflict resolution between sources                                  |
| `session`                                                 | Cross-session context recall (search / query past sessions)                                                                                |
| `context_compress`, `context_inspect`, `context_navigate` | S-MMU-style context management                                                                                                             |
| `topic_drift`                                             | Anchor tracking + drift detection                                                                                                          |
| `behavior`                                                | Activate / deactivate behavior patterns                                                                                                    |
| `timer`                                                   | Non-blocking session-scoped timers                                                                                                         |
| `workspace_snapshot`                                      | Capture / diff / restore workspace state for time-travel debugging                                                                         |
| `system_monitor`                                          | CPU / memory / disk metrics                                                                                                                |
| `healthcheck`                                             | Diagnostic across all tools (recursive smoke tests)                                                                                        |
| `fetch_content`                                           | Web page fetching (pi-web-access): readable markdown, raw text, or a prompt-answered extraction; direct images, GitHub repos, PDFs, videos |

Plus 9 pi-native tools ([`TOOLS.md`](TOOLS.md) is the canonical inventory), always available.

---

## Configuration

### Module toggling

braid's loader follows a **four-tier precedence** (high → low):

1. Runtime API (`/modules-toggle`, `/modules-enable`, `/modules-disable`)
2. `~/.pi/agent/settings.json` → `braid.modules`
3. `BRAID_MODULES` env var
4. Defaults - all non-opt-in extensions enabled

#### `BRAID_MODULES` env var

```bash
unset BRAID_MODULES                # default: all non-opt-in extensions

export BRAID_MODULES="all,-error-tracking"    # everything except one
export BRAID_MODULES="-enforcement"           # disable enforcement group
export BRAID_MODULES="+heartbeat"             # enable the heartbeat group
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

All braid-specific data goes under `~/.pi/agent/braid/`. Use the constants in [`src/lib/config/braid-paths.ts`](src/lib/config/braid-paths.ts) - never hardcode paths.

---

## Skills

Skills come in two tiers: the core set ships inside this package (`skills/`,
declared by `pi.skills` in `package.json`), and the on-demand pack is the
content-only **`../skills`** workspace. Every skill is a `SKILL.md` with a
`name` / `description` frontmatter header. Pi lists a registered package's
skills in the system prompt's `<available_skills>` block; the agent opens a
`SKILL.md` on demand.

The catalog table (one row per skill, with its verdict and one-line
description, covering both tiers) lives in
**[`../skills/README.md`](https://github.com/kifirkin/pi-braid/blob/main/packages/skills/README.md)**, and
`find packages/core/skills -name SKILL.md | wc -l` counts the core set at any
time (`find packages/skills/skills -name SKILL.md | wc -l` counts the pack).

---

## Documentation

| Doc                                                                                 | For                                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`docs/BEGINNERS.md`](docs/BEGINNERS.md)                                            | **First walkthrough**: install → how agents use braid → first extension |
| [`docs/SETUP.md`](docs/SETUP.md)                                                    | **Full setup reference**, install paths, troubleshooting                |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                                | Active roadmap + shipped milestones + open themes                       |
| [`README.md`](README.md)                                                            | This overview                                                           |
| [`AGENTS.md`](AGENTS.md)                                                            | Repository structure, DOX contract, conventions                         |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                | Development setup, code style, PR workflow, release                     |
| [`docs/HISTORY.md`](docs/HISTORY.md)                                                | Consolidated project history, archived roadmap, research                |
| [`../../CHANGELOG.md`](https://github.com/kifirkin/pi-braid/blob/main/CHANGELOG.md) | Release notes (curated)                                                 |

---

## Development

```bash
git clone https://github.com/kifirkin/pi-braid.git
cd pi-braid
npm install
npm run typecheck   # TypeScript check
npm run build       # Compile to dist/
npm run test        # Build + run the runtime test suite
npm run lint        # ESLint
```

For the full development guide - extension anatomy, manifest model, testing bar, release process - see **[`CONTRIBUTING.md`](CONTRIBUTING.md)** and **[`AGENTS.md`](AGENTS.md)**.

---

## License

[MIT](LICENSE)
