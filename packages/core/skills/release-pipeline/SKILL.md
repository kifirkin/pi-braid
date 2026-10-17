---
name: release-pipeline
description: "Release pipeline for braid packages: local builds, packing, installs, and verification; remote npm publication through GitHub Actions OIDC."
trigger: "releasing packages, npm publish, local package install, building packages, packing npm packages, package verification"
validated: 2026-10-18
verdict: IMPROVE
---

# Release Pipeline

Local package release and install flow, with remote npm publication through GitHub Actions OIDC.

## Principles

1. **Isolation** - workers operate on git worktrees, never the live repo
2. **Hygiene** - worktrees and .tgz files are cleaned up after release
3. **Traceability** - every release has a version, commit, and timestamp
4. **Separation** - local package installs use this pipeline; npm publication runs in a separate GitHub Actions OIDC workflow

## Worktree Management

Create an isolated worktree for release work:

```
git worktree add ../<package>-release-<version> <branch-or-commit>
```

After the release, remove the worktree:

```
git worktree remove ../<package>-release-<version>
```

Worktrees are cheap (no copy, just a working tree + index). They prevent
accidental edits to the live repo. Multiple workers can have concurrent
worktrees on different branches.

## Local Release Pipeline

### Step 0: build from a pristine tree

A release worktree that was also used for failing-first verification is not pristine: `git checkout
<commit>~1 -- <path>` restores what the parent had, but it does NOT delete files the commit removed,
so a deleted module comes back and gets compiled into the tarball (observed: a handler the commit
had deleted shipped in the package). Before building, run `git status` in the worktree - it must be
clean apart from a symlinked `node_modules` - and remove any resurrected path (`git rm --cached` +
`rm`). If in doubt, add a fresh worktree for the release instead of reusing the verification one.

### Step 1: Build

From `<package-dir>`, run `npm run build` when the package defines a build
script. Run `npm run typecheck` or `npx tsc --noEmit` when the package has a
TypeScript check.

### Step 2: Pack

```
npm pack
```

Produces `<package>-<version>.tgz`.

### Step 3: Install to Local Registry

```
cp <package>-<version>.tgz ~/.pi/agent/local-packages/
cd ~/.pi/agent/local-packages
npm install ./<package>-<version>.tgz
```

The package is now available at `~/.pi/agent/local-packages/node_modules/<package>/`.

### Step 4: Update Pi Config

Update `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/<user>/.pi/agent/local-packages/node_modules/<package>",
    ...
  ]
}
```

Update `~/.pi/agent/trust.json`:

```json
{
  "/Users/<user>/.pi/agent/local-packages/node_modules/<package>": true
}
```

### Step 5: Verify

Spawn a worker at the target CWD and confirm the package loads:

```
herdr workspace_create label=verify-<package> cwd=<target-cwd>
herdr run pane=<pane> command="pi"
# Wait for idle, then verify the package version
```

## Updating the runtime

The pi runtime is updated by its own pipeline, and the pipeline is dry-run
first:

```bash
node packages/core/scripts/update-pipeline.mjs                          # plan (default): read-only
node packages/core/scripts/update-pipeline.mjs --help                   # usage; does no work
node packages/core/scripts/update-pipeline.mjs --verify                 # static smoke half (standalone)
node packages/core/scripts/update-pipeline.mjs --apply --yes            # edit + reconcile + publish; runtime untouched
node packages/core/scripts/update-pipeline.mjs --apply --runtime --yes  # ... then `pi update`
```

Rules the script enforces:

- **Default mode cannot write.** `plan` resolves the upstream version and
  prints every pin it would change (file, field, from -> to), the braid version
  bump, the publish commands, the runtime command, and the rollback commands.
  It touches nothing, and it never launches a pi session to inspect the world.
- **`--apply` needs `--yes`.** Without the flag the script refuses before doing
  any work and names what the run would have done: rewrite the repo pins, run
  `npm install` in the repo and in local-packages, bump the braid version,
  publish all five packages, and stage the rollback. The publishes and installs
  are unreachable without it.
- **Runtime last, and only on request.** `--runtime` is refused unless `--apply`
  is also given, so the runtime can never move on its own. braid resolves the pi
  family from `~/.pi/agent/local-packages`, so the pins there must be realigned
  and braid republished before the runtime moves.
- **Both sides reconcile.** `--apply` rewrites the repo pins and then runs
  `npm install` at the repo root, so the repo's `node_modules` and lockfile
  resolution follow the pins; a re-run of `plan` reports no repo drift. It does
  the same for `local-packages` before republishing.
- **Rollback before edits.** `--apply` stages
  `<local-packages>/backup-<date>-pre<ver>/` (the installed `pi-braid*` copies
  plus a `VERSIONS.txt`) before writing anything. To roll back: restore each
  backed-up directory over `node_modules/<name>`, then `npm install` in
  local-packages, then reinstall the previous runtime with
  `npm --prefix <global-prefix> install -g @earendil-works/pi-coding-agent@<version>`.
- **Publish, do not repack.** `--apply` composes `publish-local.mjs` per braid
  package; it never packs inline.
- **Verify does not start a pi session.** `--verify` reads installed package
  files and settings, evaluates every item, and exits non-zero if any item
  fails. It resolves the current upstream version with `npm view`; live-session
  checks remain a human checklist. It is standalone and refuses
  `--apply`/`--runtime`.

## Remote Publication

Remote publication uses `.github/workflows/publish.yml`, separate from the
local install path. A bare core release tag (`v<core version>`) runs the
workflow. To publish one sibling package, dispatch it from `main` with
`only=<package>`; sibling tags do not run this release workflow, and iteration
tags are refused by its job condition. A release-tag run publishes each stable
workspace version not already present on npm through trusted publishing (OIDC);
the workflow uses no npm token.

Preparation:

- Commit the intended stable package versions. Refresh `package-lock.json` as
  a release convention, as described in `CONTRIBUTING.md`.
- Configure trusted publishing for the package on npmjs.com.

Local CLI publishing is not a fallback: `npm publish` needs 2FA, and this
account's passkey second factor leaves the CLI OTP prompt nothing to answer.

## Disk Hygiene

After release:

1. Remove the worktree: `git worktree remove ../<package>-release-<version>`
2. Remove old .tgz files: `rm -f ~/.pi/agent/local-packages/<package>-*.tgz`
3. The npm install only keeps the latest; old versions in node_modules are
   cleaned up by the next `npm install`

## Version Convention

- `publish-local.mjs` normally derives `<base>-<branch>.<iteration>` from the
  workspace version; if that version already carries a prerelease, it uses it
  verbatim. The script restores the original manifest after packing.
- Commit stable package versions before remote npm publication. Local snapshots
  use the derived iteration version instead.
- Use `npm version` for semver bumps in the target workspace.
- A bare core release tag (`v<core version>`) runs the publish workflow. Publish
  a sibling package by dispatching from `main` with `only=<package>`.
  `tag-prerelease.mjs` creates package-scoped iteration tags; they do not
  publish.

## Timer and Artifact Locations

Timer files are project-scoped at
`<braid-home>/projects/<canonical-sanitized-cwd>/pending-timers.jsonl`; the
default braid home is `~/.pi/agent/braid`, and `BRAID_HOME` can override it.

`publish-local.mjs` creates a tarball in the workspace directory, copies it
to `~/.pi/agent/local-packages` (or `LOCAL_PKG`), then removes the workspace
copy. The installed package and retained tarball use the destination, not the
project CWD.
