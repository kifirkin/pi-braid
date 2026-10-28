# pi-braid

<!-- braid:intro:start -->

🥨 Braid - Metacognitive extension suite for pi coding agent: Adds memory, plan tracking, structured
cognitive signals and completion checks on top of pi core loop, so long sessions keep their context and
stop claiming unfinished work.

<!-- braid:intro:end -->

pi is a coding agent with a small built-in toolset. Extensions are how pi gains capability: they
register tools, listen for session events, and shape the system prompt. pi-braid is a monorepo of
five npm workspaces, each declaring what it adds through the `pi.extensions` / `pi.skills` fields in
its `package.json`. pi does not auto-discover workspaces, so you register the packages you want.

> **Early-stage software.** Entry points and settings keys track pi's extension API, so expect
> changes before 1.0. Not production-hardened.

## Packages

| Package   | What you get                                                                                                    | npm name             |
| --------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| core      | The agent's memory and work discipline: three-store memory, working memory across compaction, completion checks | `pi-braid`           |
| skills    | Eight skill files the agent reads on demand: papers, brand systems, visuals, critique                           | `pi-braid-skills`    |
| contrib   | Twelve tool extensions: browser, repo analysis, diffs, tunnel and system monitors, tool toggles                 | `pi-braid-contrib`   |
| providers | Multi-key rotation, provider failover, route health                                                             | `pi-braid-providers` |
| telegram  | A Telegram channel: answers out, messages and decisions in                                                      | `pi-braid-telegram`  |

Core alone is the suite: memory, work discipline and context management. Add `skills` for more
procedures, `contrib` for more tools, `providers` for key rotation and failover, and `telegram` to
reach a session from a phone.

## Requirements

| Tool | Version   | Verify                     |
| ---- | --------- | -------------------------- |
| Node | >= 24.0   | `node --version`           |
| pi   | installed | `which pi && pi --version` |
| git  | any       | `git --version`            |

Node's floor and the pi peer ranges are declared in each package's `package.json`. git is needed
only for the checkout path below.

## Install

```bash
pi install npm:pi-braid            # the core suite
pi install npm:pi-braid-skills     # the skill pack, usually per project
pi install npm:pi-braid-contrib    # the tool extensions
pi install npm:pi-braid-providers  # key rotation and failover
pi install npm:pi-braid-telegram   # the Telegram channel
```

Each install registers the package in your user settings and unpacks it under pi's npm directory.
The next `pi` start loads it. To enable a package for one project only, use `--local`, which writes
the declaration to that project's `.pi/settings.json`.

## From a checkout

```bash
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build
```

Then add the packages you want to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "file:~/pi-braid/packages/core",
    "file:~/pi-braid/packages/skills"
  ]
}
```

Add those entries to the array your settings already have; the file holds more than this one key.
Register `packages/core` and `packages/skills`, not the repo root: the root `package.json` has no
`pi` field, so `file:~/pi-braid` loads nothing. [SETUP](packages/core/docs/SETUP.md) covers the
other install shapes (local-packages, project-scoped, once-per-session).

## Documentation

| Doc                                                         | Covers                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| [`SETUP.md`](packages/core/docs/SETUP.md)                   | Install paths, configuration reference, troubleshooting      |
| [`BEGINNERS.md`](packages/core/docs/BEGINNERS.md)           | Guided walkthrough: install, first session, first extension  |
| [`CONTEXT-POLICY.md`](packages/core/docs/CONTEXT-POLICY.md) | Window, usage bands, compaction reserve, offload             |
| [`FLEET.md`](packages/core/docs/FLEET.md)                   | The `pi-braid-fleet` supervisor command                      |
| [`TOOLS.md`](packages/core/TOOLS.md)                        | Every tool the core package registers, plus pi's own         |
| [`CHANGELOG.md`](CHANGELOG.md)                              | Release notes, newest first, per workspace                   |
| [`HISTORY.md`](packages/core/docs/HISTORY.md)               | Narrative history and milestone summaries                    |
| [`CONTRIBUTING.md`](packages/core/CONTRIBUTING.md)          | Commands, style, testing, releases                           |
| [`SECURITY.md`](SECURITY.md)                                | Security policy                                              |
| [`examples/`](examples)                                     | Copy-ready settings, environment variables, session profiles |

Each workspace carries its own README: [`core`](packages/core/README.md),
[`skills`](packages/skills/README.md), [`contrib`](packages/contrib/README.md),
[`providers`](packages/providers/README.md), [`telegram`](packages/telegram/README.md).

## Development

```bash
npm install
npm run typecheck      # all four code packages
npm run build          # compile core to dist/
npm test               # runtime test suite
npm run lint           # ESLint
npm run format:check   # Prettier
npm run check:docs     # doc status markers
npm run check:deps     # dependency and layer hygiene
```

`.github/workflows/ci.yml` runs the same checks on every pull request. The doc gates live in
`packages/core/scripts`: they fail on a broken in-repo link, an em dash in prose, a status marker
that went missing, a domain literal in a shared layer, and a count that no longer matches its
source. Contributor conventions are in [CONTRIBUTING.md](packages/core/CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md).

## Status and support

Single-maintainer project in active development; no support channel. Bugs and requests go to the
[issue tracker](https://github.com/kifirkin/pi-braid/issues).

## License

[MIT](LICENSE)
