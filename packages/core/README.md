<!-- status: current -->

# pi-braid 🥨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![pi-coding-agent ^1.2.0](https://img.shields.io/badge/pi--coding--agent-%5E1.2.0-blueviolet)](https://github.com/earendil-works/pi)

Honest self-aware agent with a metacognitive suite and extras on top of [pi-coding-agent](https://github.com/earendil-works/pi). The suite adds enforcement, memory, reasoning, self-improvement, and structured cognitive signals on top of the pi agent session.

> **⚠️ Early-stage software.** APIs may change. Not production-hardened.

---

## Install

```bash
pi install npm:pi-braid
```

One command, no clone, no build: `pi install` registers the package with pi,
writes the declaration to `~/.pi/agent/settings.json`, and installs it under
pi's npm directory. It carries the suite and the core skill set that ships with
it. The on-demand skill pack and the other companions are add-ons, each its own
install: `pi install npm:pi-braid-skills`,
`pi install npm:pi-braid-contrib`, `pi install npm:pi-braid-providers`,
`pi install npm:pi-braid-telegram`.

The core package also installs one command, `pi-braid-fleet`, the operator
surface of braid's **supervisor fleet**: one supervisor process driving local
node sessions against a single SQLite journal. It is not the worker registry
`orchestrate` keeps for parallel agents, which is a worker pool (see below).
`pi-braid-fleet --help` prints the four commands and exits 0;
[`docs/FLEET.md`](docs/FLEET.md) is the guide to the fleet and its journal.

To enable braid for one project only, or to use all five workspaces, see
[docs/SETUP.md](docs/SETUP.md) § Install paths. For the full setup reference
(per-project installs, skills, module toggles, troubleshooting) see
**[`docs/SETUP.md`](docs/SETUP.md)**; new to pi and braid, start with
**[`docs/BEGINNERS.md`](docs/BEGINNERS.md)**.

### From a checkout (working on braid)

Build the workspace and point pi at the local path:

```bash
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build
```

Register `packages/core` (plus `packages/skills` for the pack) under `packages`
in pi's settings; the root `package.json` has no `pi` field, so `file:~/pi-braid`
loads nothing. Each workspace is loaded through the `pi.extensions` /
`pi.skills` fields in its `package.json` (no workspaces auto-discovery). The
install-path reference is [`docs/SETUP.md`](docs/SETUP.md);
[`examples/`](https://github.com/kifirkin/pi-braid/tree/main/examples) carries
copy-ready settings.

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

## How it fits pi

pi loads extensions from a `packages` entry in `<cwd>/.pi/settings.json` (project) or `~/.pi/agent/settings.json` (user-global). braid is a regular extension package - point pi at it via a `file:` or `git+https:` spec.

This package is the **core** workspace. The monorepo also contains four
sibling packages (see the root [`README.md`](https://github.com/kifirkin/pi-braid/blob/main/README.md) for the full map):

| Package       | Role                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `core` (this) | Metacognitive extension suite - memory, enforcement, cognitive, self |
| `skills`      | Content-only skill pack (`SKILL.md` catalog, no runtime code)        |
| `contrib`     | Standalone code-only extension modules (browser, codebase, diff, …)  |
| `providers`   | Venice (agent-zero proxy) provider + multi-key ring                  |
| `telegram`    | Bidirectional Telegram channel (send, inbound, voice, pause)         |

---

## What it does

28 extensions ship; `health-maintenance` and `error-tracking` are off by
default, and the flat list is
[`src/extensions/manifest.ts`](src/extensions/manifest.ts). They cover:

- **Enforcement** - the turn pipeline: turn validation, signal delivery, sycophancy and verification nudges, behavior patterns
- **Reasoning** - topic-drift detection, claim tracking, bidirectional verification, contradiction detection
- **Self-improvement** - heuristic evolution, reflection, offline consolidation
- **Utilities** - health, timers, workspace snapshots, context lifecycle

Five capabilities explain the rest of the file:

### The prompt builder

The system prompt is assembled, not written once: named sections are composed
as `PromptSection` fragments
([`section.ts`](src/extensions/core/prompt-builder/section.ts)) and published
through pi's section seam, so a section that changes re-sends alone instead of
the whole head prompt
([`section-publish.ts`](src/extensions/core/prompt-builder/section-publish.ts)).
Sections a host or an earlier handler supplies on the prompt options are
rendered as their own blocks
([`custom-sections.ts`](src/extensions/core/prompt-builder/custom-sections.ts)),
and because braid renders the whole prompt it suppresses pi's native preamble,
tool list, rules and docs. `prompt_inspect` prints the assembled result at any
point in a session, which is the point: most of braid's behavior is inspectable
prompt text rather than hardcoded replies.

### Memory as a system

Three stores hold different kinds of memory: episodes (what happened, per
session, promoted to semantic when the agent keeps referencing them), semantic
entries (what it learned, written on shutdown and loaded next session), and the
heuristics (procedural rules) it applies while working. The scratchpad is working memory that
survives compaction, and a resume file hands the open plan to a fresh seat at
session start
([`resume-state.ts`](src/extensions/enforcement/resume-state.ts)). `memory`
reads across the stores; `session` reads across past sessions. Deep source:
[`src/extensions/memory/AGENTS.md`](src/extensions/memory/AGENTS.md).

### A worker pool

`orchestrate` coordinates parallel agent workers: a per-project worker registry
with admission and lifecycle, one branch per worker, file locks, conflict
detection, close gates, and merge verification. Branch handling is git-optional:
with no repository it falls back to lock-only coordination. The working
procedure is the [`subagent-orchestration`](skills/subagent-orchestration/SKILL.md)
skill; the registry is
[`src/extensions/orchestrator/index.ts`](src/extensions/orchestrator/index.ts).

This is a pool of workers, not a fleet: the package's `pi-braid-fleet` command,
described in Install above, is the supervisor fleet, and the two share no code,
journal or lifecycle.

### Context lifecycle

braid manages its own window: usage bands fire pruning, archiving and
compaction; a compaction reserve keeps headroom for the next turn;
auto-compaction arms on usage; oversized tool results are offloaded to disk and
stubbed. A failed compaction walks retries, then a bounded summarizer, then a
deterministic cut that needs no provider, so the session keeps compressing even
when the model stops answering. The
numbers are owned by [`docs/CONTEXT-POLICY.md`](docs/CONTEXT-POLICY.md); the
tools are `context_compress`, `context_inspect` and `context_navigate`.

### Highlights

| Tool / Extension                             | What it adds                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `think`, `verify`, `hypothesize`, `finalize` | Metacognitive tools (always-on). Use `think` for non-trivial reflection; `verify` to check work; `finalize` to close a task with evidence. |
| `scratchpad`                                 | Goal/plan/decision/learning tracker that survives context compaction                                                                       |
| `memory`, `memory_store`, `conflict_qa`      | Three-store recall (episodes / semantic / heuristics) cross-searched; conflict resolution between sources                                  |
| `session`                                    | Cross-session context recall (search / query past sessions)                                                                                |
| `topic_drift`                                | Anchor tracking + drift detection                                                                                                          |
| `behavior`                                   | Activate / deactivate behavior patterns                                                                                                    |
| `timer`                                      | Non-blocking session-scoped timers                                                                                                         |
| `workspace_snapshot`                         | Capture / diff / restore workspace state for time-travel debugging                                                                         |

[`TOOLS.md`](TOOLS.md) is the catalog: every tool this package registers, pi's
own builtins, and the cold tools that stay undeclared until `tool_search` loads
them. `set_tool_profile` switches the active set to a curated profile.

---

## Configuration

### Module toggling

braid's loader follows a **four-tier precedence** (high → low):

1. Runtime API (`/modules-toggle`, `/modules-enable`, `/modules-disable`)
2. `~/.pi/agent/settings.json` → `braid.modules`
3. `BRAID_MODULES` env var
4. Defaults - all non-opt-in extensions enabled

A ref is either an **extension id** (`enforcement`, `error-tracking`) or a
**module group name** (`heartbeat`, `core`, `memory`), prefixed `+` to enable or
`-` to disable: `BRAID_MODULES="all,-error-tracking"`. Settings win over the env
var; the runtime API wins over both. Worked patterns are in
[`AGENTS.md`](AGENTS.md) § Common `BRAID_MODULES` patterns.

### Settings

`braid.modules` is one leaf of the settings surface. The source is
`schema/braid.schema.json`, [`docs/SETUP.md`](docs/SETUP.md) § Configuration
reference lists every path with its default, and
[`examples/full-config.settings.json`](https://github.com/kifirkin/pi-braid/blob/main/examples/full-config.settings.json)
is copy-ready.

### Storage

All braid-specific data goes under `~/.pi/agent/braid/`. Use the constants in [`src/lib/config/braid-paths.ts`](src/lib/config/braid-paths.ts) - never hardcode paths.

---

## Skills

Skills come in two tiers: the core set ships inside this package (`skills/`,
declared by `pi.skills` in `package.json`), and the on-demand pack is the
content-only **`../skills`** workspace. Every skill is a `SKILL.md` with a
`name` / `description` frontmatter header.

Discovery is on demand, not in the prompt: `list_skills` returns the catalog
ranked against the current task, each row priced by what the read will cost
(lines, bytes, token estimate, headings). When a skill's triggers match the
task, an excerpt is steered into the session, and `skill_stats` counts which
skills were suggested and which were actually read.

The catalog table (one row per skill, with its verdict and one-line
description, covering both tiers) lives in
**[`packages/skills/README.md`](https://github.com/kifirkin/pi-braid/blob/main/packages/skills/README.md)**, and
`find packages/core/skills -name SKILL.md | wc -l` counts the core set at any
time (`find packages/skills/skills -name SKILL.md | wc -l` counts the pack).

---

## Documentation

| Doc                                                                           | For                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`docs/BEGINNERS.md`](docs/BEGINNERS.md)                                      | **First walkthrough**: install → how agents use braid → first extension |
| [`docs/SETUP.md`](docs/SETUP.md)                                              | **Full setup reference**, install paths, troubleshooting                |
| [`TOOLS.md`](TOOLS.md)                                                        | Tool catalog: registered tools, pi builtins, cold tools                 |
| [`docs/CONTEXT-POLICY.md`](docs/CONTEXT-POLICY.md)                            | Window, usage bands, compaction reserve, caps, offload, archiving       |
| [`docs/FLEET.md`](docs/FLEET.md)                                              | The `pi-braid-fleet` supervisor fleet: commands, tiers, journal         |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                          | Active roadmap + shipped milestones + open themes                       |
| [`README.md`](README.md)                                                      | This overview                                                           |
| [`AGENTS.md`](AGENTS.md)                                                      | Repository structure, DOX contract, conventions                         |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                          | Development setup, code style, PR workflow, release                     |
| [`docs/HISTORY.md`](docs/HISTORY.md)                                          | Consolidated project history, archived roadmap, research                |
| [`CHANGELOG.md`](https://github.com/kifirkin/pi-braid/blob/main/CHANGELOG.md) | Release notes (curated)                                                 |

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
