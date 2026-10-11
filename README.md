<!-- status: current -->

# pi-braid 🥨

Extension pack for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent): enforcement, three-store memory, reasoning, self-improvement, and structured cognitive signals on top of the pi agent session.

pi is a coding agent with a small built-in toolset. **Extensions** are how pi gains capability: they register tools, listen for session events, and shape the system prompt. pi-braid is a monorepo of five npm workspaces that plug into pi through the `pi.extensions` / `pi.skills` fields in each package's `package.json` - pi does not auto-discover workspaces, so you register the paths you want.

> **⚠️ Early-stage software.** Entry points and settings keys track pi's extension API; expect changes before 1.0. Not production-hardened.

---

## Packages

| Workspace     | Path                 | One-line purpose                                                                                                           |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **core**      | `packages/core`      | The metacognitive suite - enforcement, three-store memory, reasoning, self-improvement, context lifecycle. The main event. |
| **skills**    | `packages/skills`    | Content-only skill pack - one `SKILL.md` per skill, no runtime code.                                                       |
| **contrib**   | `packages/contrib`   | Standalone tool extensions - browser, codebase, diff, repl, healthcheck, system monitor, and more.                         |
| **providers** | `packages/providers` | Venice (agent-zero proxy) provider plus the multi-key API key ring.                                                        |
| **telegram**  | `packages/telegram`  | Bidirectional Telegram channel - send, inbound, photo/voice, pause control.                                                |

Core alone gives you the metacognitive layer. Add `skills` for the agent skill library, `contrib` for extra tool extensions, `providers` for alternative LLM providers, and `telegram` for a Telegram channel.

## Prerequisites

| Tool            | Version    | Verify                     |
| --------------- | ---------- | -------------------------- |
| Node.js         | ≥ 22.19    | `node --version`           |
| pi-coding-agent | installed  | `which pi && pi --version` |
| npm             | bundled    | `npm --version`            |
| git             | any recent | `git --version`            |

braid declares the pi packages as peer dependencies with unconstrained ranges; `npm install` resolves them (see [SETUP § Prerequisites](packages/core/docs/SETUP.md#prerequisites) for how the pi version resolves).

## First run (about five minutes)

```bash
# 1. Clone and build
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build

# 2. Register core + skills with pi (user-global, once)
cat > ~/.pi/agent/settings.json <<'JSON'
{
  "packages": [
    "file:~/pi-braid/packages/core",
    "file:~/pi-braid/packages/skills"
  ]
}
JSON

# 3. Use pi as normal — braid loads automatically
pi
```

It worked when the system prompt lists the bundled skills under `<available_skills>`. Register `packages/core` + `packages/skills`, not the repo root: the root `package.json` has no `pi` field, so `file:~/pi-braid` loads nothing.

Copy-ready configuration lives in [`examples/`](examples): the full `braid.*` settings surface, provider/Telegram environment variables, and cwd-routed session profiles. More install paths (local-packages, project-scoped, once-per-session flag) in [SETUP § Install paths](packages/core/docs/SETUP.md#install-paths). New to pi and braid? Start with [`packages/core/docs/BEGINNERS.md`](packages/core/docs/BEGINNERS.md).

---

## Documentation

| Doc                                                | Covers                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`SETUP.md`](packages/core/docs/SETUP.md)          | All install paths, configuration reference, module toggling, troubleshooting |
| [`LOCAL_DEV.md`](packages/core/docs/LOCAL_DEV.md)  | Maintainer flow: publish/link into `~/.pi/agent/local-packages`              |
| [`BEGINNERS.md`](packages/core/docs/BEGINNERS.md)  | Guided walkthrough: install → how agents use braid → first extension         |
| [`CHANGELOG.md`](CHANGELOG.md)                     | Release notes, newest first, per workspace                                   |
| [`HISTORY.md`](packages/core/docs/HISTORY.md)      | Narrative history and milestone summaries                                    |
| [`CONTRIBUTING.md`](packages/core/CONTRIBUTING.md) | Contributor contract: commands, style, testing, releases                     |
| [`SECURITY.md`](SECURITY.md)                       | Security policy                                                              |

Each workspace also carries its own README with quick-start and config notes: [`core`](packages/core/README.md), [`skills`](packages/skills/README.md), [`contrib`](packages/contrib/README.md), [`providers`](packages/providers/README.md), [`telegram`](packages/telegram/README.md).

## Development

```bash
npm install
npm run typecheck   # all code packages (core, providers, contrib, telegram)
npm run build       # compile core to dist/
npm test            # runtime test suite
npm run lint        # ESLint (all code packages)
npm run check:docs  # doc status markers
npm run check:deps  # dependency hygiene
npm run check:placement  # placement leaks (provenance, domain literals, home paths)
```

See [`packages/core/CONTRIBUTING.md`](packages/core/CONTRIBUTING.md) and [`packages/core/AGENTS.md`](packages/core/AGENTS.md) for the contributor contract.

## Repo hygiene

- The [`.github/workflows/ci.yml`](.github/workflows/ci.yml) gate runs format check, typecheck, build, tests, and the doc/dep checks on every PR.
- A **private-data scan** (`npm run check:private-data`) runs in CI and locally - the publishability gate. It scans the whole working tree (tracked plus untracked non-ignored files) by default; `--staged` limits it to staged files. An absolute home path, API key, session file, or private-artifact reference fails the build.
- Culled/archived content stays in **git history** - never re-add `node_modules`, `dist/`, `.braid/`, or session files.

## Support & status

Single-maintainer project in active development; no support channel. Bugs and feature requests go to the [issue tracker](https://github.com/kifirkin/pi-braid/issues). Expect API and settings-key changes before 1.0.

## License

[MIT](LICENSE)
