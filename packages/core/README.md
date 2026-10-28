<!-- status: current -->

# pi-braid

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-coding-agent ^1.2.0](https://img.shields.io/badge/pi--coding--agent-%5E1.2.0-blueviolet)](https://github.com/earendil-works/pi)

<!-- braid:intro:start -->

🥨 Braid - Metacognitive extension suite for pi coding agent: Adds memory, plan tracking, structured
cognitive signals and completion checks on top of pi core loop, so long sessions keep their context and
stop claiming unfinished work.

<!-- braid:intro:end -->

> **Early-stage software.** APIs may change. Not production-hardened.

## Install

```bash
pi install npm:pi-braid
```

`pi install` registers the package with pi, writes the declaration to
`~/.pi/agent/settings.json`, and unpacks it under pi's npm directory. The next `pi` start loads the
suite and the 22 skills that ship with it.

The package also installs one command, `pi-braid-fleet`: a supervisor process that drives local node
sessions against a single SQLite journal. [docs/FLEET.md](docs/FLEET.md) is its guide.

Working on braid itself, or tracking `main`? [CONTRIBUTING.md](CONTRIBUTING.md) has the checkout and
build flow; [docs/SETUP.md](docs/SETUP.md) covers every install path.

## What it adds

| Capability        | What changes in the session                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory            | Three stores hold different kinds of memory: episodes (what happened), semantic entries (what it learned), and heuristics (rules it applies). The scratchpad is working memory that survives compaction, and a resume file hands the open plan to a fresh session. |
| Work discipline   | `think`, `hypothesize`, `verify` and `finalize` make reasoning and completion explicit; a task closes with evidence, not with a claim. Behavior patterns switch the working mode.                                                                                  |
| Context lifecycle | Usage bands fire pruning, archiving and compaction; a reserve keeps headroom for the next turn; oversized tool results are offloaded to disk and stubbed. The numbers are owned by [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md).                               |
| Subagents         | `orchestrate` keeps a per-project worker registry with admission, lifecycle, one branch per worker, file locks, conflict detection, and merge verification.                                                                                                        |
| Prompt assembly   | The system prompt is composed from named sections and published through pi's section seam, so a changed section re-sends alone. `prompt_inspect` prints the assembled prompt at any point.                                                                         |

The suite is 29 extensions; `health-maintenance` and `error-tracking` are off by default, and the
list is [src/extensions/manifest.ts](src/extensions/manifest.ts). `set_tool_profile` switches the
active tool set to a curated profile.

## Highlights

| Tool                                                         | What it adds                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `think`, `hypothesize`, `verify`, `verify_claim`, `finalize` | Structured reflection, root-cause hypotheses, work verification, claim checks, task closure |
| `scratchpad`                                                 | Goal, plan, decisions and learnings that survive compaction                                 |
| `memory`, `memory_store`, `session`                          | Three-store recall; cross-session context search                                            |
| `orchestrate`                                                | Parallel worker registry: admission, locks, close gates, merge verification                 |
| `context_compress`, `context_inspect`, `context_navigate`    | Archive, compact and inspect the session's own context                                      |
| `timer`, `workspace_snapshot`, `topic_drift`                 | Non-blocking timers, file time travel, drift detection against an anchored topic            |

[TOOLS.md](TOOLS.md) is the catalog: every tool this package registers, pi's own builtins, and the
cold tools that stay undeclared until `tool_search` loads them.

## Configuration

Settings live in `~/.pi/agent/settings.json` under `braid.*`. [docs/SETUP.md](docs/SETUP.md) is the
reference: every key, its default, and worked examples. Module toggling has its own precedence
(runtime API, then settings, then the `BRAID_MODULES` environment variable, then defaults), and
`docs/SETUP.md` states it with the patterns people actually use.

## Skills

22 skills ship in this package under `skills/`, declared by `pi.skills` in `package.json`. The
separate `pi-braid-skills` package carries eight more for project-scoped loading. Skills are read on
demand, not pasted into the prompt: `list_skills` ranks the catalog against the current task and
prices each read, `skill_stats` counts what was suggested and what was actually opened.

## Limits

- It is not an agent of its own: pi is the runtime, and braid is a layer loaded into it.
- It does not replace pi's native tools. braid's tools sit alongside `read`, `bash` and `edit`.
- It does not run outside a pi session. Loading, state and enforcement are per session.
- Braid's own data lives under `~/.pi/agent/braid/`. The provider package keeps its key-ring and
  route-state files directly under `~/.pi/agent/`.
- It contacts no third-party analytics or crash-reporting service.

## Documentation

| Doc                                                                         | For                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [docs/BEGINNERS.md](docs/BEGINNERS.md)                                      | First walkthrough: install, first session, first extension          |
| [docs/SETUP.md](docs/SETUP.md)                                              | Full setup reference: install paths, configuration, troubleshooting |
| [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md)                            | Window, usage bands, compaction reserve, caps, offload, archiving   |
| [docs/FLEET.md](docs/FLEET.md)                                              | The `pi-braid-fleet` supervisor: commands, tiers, journal           |
| [docs/ROADMAP.md](docs/ROADMAP.md)                                          | Shipped milestones and open themes                                  |
| [docs/HISTORY.md](docs/HISTORY.md)                                          | Project history and archived research                               |
| [TOOLS.md](TOOLS.md)                                                        | Tool catalog                                                        |
| [AGENTS.md](AGENTS.md)                                                      | Repository structure and conventions                                |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                          | Development flow, tests, release                                    |
| [CHANGELOG.md](https://github.com/kifirkin/pi-braid/blob/main/CHANGELOG.md) | Release notes, newest first                                         |

## License

[MIT](LICENSE)
