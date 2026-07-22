---
name: release-pipeline
description: "Generic local npm release pipeline for braid packages. Covers: building, packing, installing to local registry, and verifying packages. Extensible for remote publication to npm."
trigger: "releasing packages, npm publish, local package install, building packages, packing npm packages, package verification"
---

# Release Pipeline

Generic local npm release pipeline for braid packages. Extensible for remote publication.

## Principles

1. **Isolation** — workers operate on git worktrees, never the live repo
2. **Hygiene** — worktrees and .tgz files are cleaned up after release
3. **Traceability** — every release has a version, commit, and timestamp
4. **Extensibility** — local release is the default; remote publication is a flag

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

### Step 1: Build

```
cd <package-dir>
npm run build
```

Verify: `npm run typecheck` (or `npx tsc --noEmit`).

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

## Remote Publication

To publish to npm (instead of local), override Step 3:

```
npm publish
```

Pre-requisites:
- `npm login` completed
- Version bumped (`npm version patch|minor|major`)
- CHANGELOG.md updated
- Git tag created (`git tag v<version>`)

## Disk Hygiene

After release:

1. Remove the worktree: `git worktree remove ../<package>-release-<version>`
2. Remove old .tgz files: `rm -f ~/.pi/agent/local-packages/<package>-*.tgz`
3. The npm install only keeps the latest; old versions in node_modules are
   cleaned up by the next `npm install`

## Version Convention

- Local releases use the same version as the source package.json
- Bump version before remote publication only
- Use `npm version` for semver bumps: `npm version patch`
- Tag the commit: `git tag v<version> && git push origin v<version>`

## CWD Scoping

Timers and release artifacts are scoped by CWD:
- Timer files: `~/.pi/agent/braid/projects/<sanitized-cwd>/pending-timers.jsonl`
- Release artifacts are in the package directory, not the pi config directory

This ensures independent timer pools per project and prevents cross-project
interference.
