<!-- status: current -->

# Local Development

How to develop pi-braid locally, publish it into the pi agent home
(`~/.pi/agent/local-packages`), and wire the published package into pi.
For one-time setup, the full install-path catalog, and module toggling see
[SETUP.md](SETUP.md).

## Prerequisites

| Tool | Version       | Verify                     |
| ---- | ------------- | -------------------------- |
| Node | ≥ 22.19       | `node --version`           |
| npm  | bundled       | `npm --version`            |
| git  | any           | `git --version`            |
| pi   | peer-resolved | `which pi && pi --version` |

The Node floor is the `engines` field in every workspace manifest; if this
table and `engines` ever disagree, trust `engines`.

## Monorepo layout

Five npm workspaces under `packages/`:

| Workspace            | Package              | Loads via                    |
| -------------------- | -------------------- | ---------------------------- |
| `packages/core`      | `pi-braid`           | `pi.extensions`, `pi.skills` |
| `packages/skills`    | `pi-braid-skills`    | `pi.skills`                  |
| `packages/contrib`   | `pi-braid-contrib`   | `pi.extensions`              |
| `packages/providers` | `pi-braid-providers` | `pi.extensions`              |
| `packages/telegram`  | `pi-braid-telegram`  | `pi.extensions`              |

pi loads a workspace through the `pi.extensions` / `pi.skills` fields in its
`package.json` - there is no auto-discovery. `packages/core` declares
`pi.skills` for the core set it ships, and `packages/skills` declares
`pi.skills` for the on-demand pack (see the collision rule below).

## Everyday commands

From the repo root:

```bash
npm install            # installs all workspaces (peer-resolves the pi packages)
npm run typecheck      # all four code packages
npm run build          # compile core to dist/
npm test               # build + runtime test suites (core)
npm run lint           # ESLint over all four code packages
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run check:docs     # every in-scope .md has a status marker
npm run check:doc-drift # current-state docs must not reference APIs missing from code
npm run check:deps     # layer-boundary check
npm run check:private-data # whole-tree private-data scan
```

Per-workspace variants use the workspace flag, e.g.
`npm run build -w packages/core`, `npm test -w packages/providers`.

The combined gate is `npm run ci:check` (docs, drift, deps, format,
typecheck, tests).

## Two install modes

### 1. Live symlink (default for active development)

Source edits are reflected after a rebuild - no repack, no reinstall staleness.

```bash
# from the pi-braid repo root
npm run build
cd ~/.pi/agent/local-packages
npm install file:<absolute-path-to-your-checkout>/packages/core
# -> creates a symlink; pi follows it to source dist/index.js
```

Or the canonical `npm link` flow:

```bash
cd <absolute-path-to-your-checkout>/packages/core && npm link
cd ~/.pi/agent/local-packages && npm link pi-braid
```

> pi-braid loads `./dist/index.js` (compiled), NOT `.ts`. After editing
> source you MUST `npm run build` for changes to take effect, even with a
> symlink.

### 2. Versioned tgz snapshot (reproducible / CI)

Use when you want a pinned, semantically-versioned artifact:

```bash
npm run publish:local
```

## Local publish flow

`publish-local.mjs` (wired as `npm run publish:local` and friends at the repo
root) packs a workspace, installs the tarball into
`~/.pi/agent/local-packages`, and leaves the repo untouched.

```bash
npm run publish:local                # core (the default at the repo root)
npm run publish:local:skills         # skills pack
npm run publish:local:contrib        # contrib pack
npm run publish:local:providers      # providers
npm run publish:local:telegram       # telegram
# or per-workspace: npm run publish:local -w packages/telegram
```

What the script does, in order:

1. Derives the release version (see scheme below) and temporarily bumps the
   workspace's `package.json`.
2. Runs the package's pre-pack gates (`typecheck`, then `build`, when the
   package defines them - the markdown-only skills pack defines neither).
3. Runs `npm pack` and copies the tarball to `~/.pi/agent/local-packages`
   (override the destination with the `LOCAL_PKG` env var).
4. Preflights the install with a resolution-only dry run (mutates nothing;
   peer conflicts and missing file: targets surface here), then installs:
   the previously extracted copy of the package is renamed to a backup and
   the destination manifest bytes are snapshotted, so a failed install
   restores both - the old install stays loadable and the tarball stays in
   the destination for retry - while a successful one removes the backup.
   Either way the install can never stay stale.
5. Restores the pristine `package.json` bytes and deletes the tarball from
   the package tree - the working tree ends clean.

Version scheme: `<base>-<branch>.<iteration>`

- `base` = the workspace's current `package.json` version (e.g. `0.40.0`)
- `branch` = the git branch, sanitized to `[a-zA-Z0-9.-]`
- `iteration` = commit count on the branch since `main`/`master`

Example: `0.40.0-main.17`. When `package.json` already carries a full
versioned release string (e.g. `0.40.0-main.17`), it is used verbatim instead
of being double-suffixed.

## Upstream pi update pipeline

`update-pipeline.mjs` codifies the full update run for the pair - the braid
extension pack and the pi runtime it hosts on:

```bash
npm run release:update                   # plan (default): read-only, prints what would change
npm run release:update:verify            # static half of the smoke checklist against the installed pair
npm run release:update:apply -- --yes    # real sequence; runtime untouched
npm run release:update:runtime -- --yes  # real sequence plus `pi update` (last)
```

Default mode writes nothing. It resolves the upstream pi version, compares it
against the repo pins and the local-packages resolution, and prints the target
version, every pin it would change (file, field, from -> to), the braid version
bump, the publish commands, the runtime command, and the rollback commands.

The local-packages trap: braid resolves the pi family from
`~/.pi/agent/local-packages`, and its manifests declare those packages as
`*` peers. Installing a new braid tarball NEVER moves those copies - the
explicit pins in `local-packages/package.json` must be realigned to the
upstream version as their own step. That is why `--apply` aligns both sides,
then republishes braid, and why the runtime update is always last and only runs
with `--apply --runtime`.

`--apply` requires `--yes`: without it the script refuses before doing any work
and names the edits, installs, and publishes it would have performed. The run
reconciles both sides - it rewrites the repo pins and then runs `npm install` at
the repo root, so the repo's `node_modules` and lockfile follow the pins and a
re-run of `plan` reports no repo drift, then it aligns the local-packages pins
and installs them.

`--apply` stages the rollback directory
`<local-packages>/backup-<date>-pre<ver>/` before it writes anything: the
installed `pi-braid*` copies plus a `VERSIONS.txt` carrying the restore
commands (restore each backed-up directory over `node_modules/<name>`, then
`npm install` in local-packages, then `npm install -g` the previous runtime
version). The backup is staged, not exercised.

`--verify` runs the static half of the smoke checklist against the installed
pair - installed braid versions vs the repo manifests, repo pins vs the
installed pi-family copies, dist/entry files present, extension paths named in
settings resolve, and each installed package's `build-info.json` sha - and
exits non-zero when an item fails. The live-session items (a timer firing
end-to-end with drift reported, delivery exactly once, no duplicate-instance or
load warnings, third-party extension tools, a readable key-ring state file) are
printed as a checklist for a real session; the script never drives one, because
a nested pi session launched from a script has stalled the seat before.

## Wiring a published package into pi

Register the installed paths in `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["~/.pi/agent/local-packages/node_modules/pi-braid"],
}
```

Add the other workspaces the same way
(`node_modules/pi-braid-contrib`, `node_modules/pi-braid-providers`,
`node_modules/pi-braid-telegram`). `pi-braid-skills` is the on-demand skill
pack, registered in the settings file of the project that wants it rather than
globally. Restart pi after editing settings.

Verify inside pi:

- braid's tools appear in `<Available tools>` (memory, timer, scratchpad, …).
- the core skill set appears in `<available_skills>`.
  `find packages/core/skills -name SKILL.md | wc -l` counts it at any time -
  that count is what `<available_skills>` should list. Registering
  `pi-braid-skills` adds that pack's skills on top.

If pi asks you to trust a package path, approve it; trust decisions are
recorded per path in the agent home.

## Skills-collision rule

- **Two workspaces declare `pi.skills`.** `packages/core` (`./skills`) ships
  the core set with pi-braid; `packages/skills` (`./skills`) carries the
  on-demand pack. `contrib`, `providers`, and `telegram` must NOT have a
  `pi.skills` entry.
- If you add a skill, put it in the tier that owns it:
  `packages/core/skills/<name>/SKILL.md` for the core set,
  `packages/skills/skills/<name>/SKILL.md` for the on-demand pack. pi keys
  skills by name, so one name in both tiers collides.

### Debugging collisions

If pi reports `"<skill>" collision`, the first copy registered won and the later
one was skipped (`loadSkills` in pi-core keys skills by name and reports the
winner and loser paths):

1. Check `local-packages/node_modules/pi-braid/package.json` - it declares
   `pi.skills` (`./skills`) and the installed package carries that directory. A
   copy without `pi.skills` is a stale tarball from before the core set moved
   in; re-run the symlink install (mode 1 above).
2. Confirm the installed `pi-braid` points at its own `skills/` directory and
   `pi-braid-skills` at the on-demand pack - the two tiers ship separately.

## Removing a local install

```bash
cd ~/.pi/agent/local-packages
npm uninstall pi-braid        # or: rm -rf node_modules/pi-braid
```

Then remove the matching entries from `~/.pi/agent/settings.json`.
