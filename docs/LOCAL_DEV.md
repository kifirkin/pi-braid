# Local Development & Publish Pipeline

How to develop `pi-braid` locally and install it into `~/.pi/agent/local-packages`
without the stale-tarball collision that previously shadowed `pi-braid-skills`.

## Two install modes

### 1. Live symlink (default for active dev)
Source edits are reflected immediately after a rebuild — no repack, no reinstall
staleness. This is what `local-packages/node_modules/pi-braid` currently is.

```bash
# from pi-braid/
npm run build
cd ~/.pi/agent/local-packages
npm install file:/Users/kifir/projects/agents/pi-braid
# -> creates a symlink; pi follows it to source dist/index.js
```

Or the canonical `npm link` flow:

```bash
cd /Users/kifir/projects/agents/pi-braid && npm link
cd ~/.pi/agent/local-packages && npm link pi-braid
```

> NOTE: `pi-braid` loads `./dist/index.js` (compiled), NOT `.ts`. After editing
> source you MUST `npm run build` for changes to take effect, even with a symlink.

### 2. Versioned tgz snapshot (reproducible / CI)
Use when you want a pinned, semantically-versioned artifact.

```bash
npm run release:local      # -> scripts/publish-local.mjs
```

Version scheme: `<base>-<branch>.<iteration>`
- `base` = current `package.json` version (e.g. `0.3.0`)
- `branch` = git branch, sanitized to `[a-zA-Z0-9.-]`
- `iteration` = commit count on the branch since `main`/`master`

Example: `0.3.0-feature-ctx-budget.4`.

`publish-local.mjs` temporarily bumps `package.json`, runs `prepublishOnly`
(`typecheck && build`), packs, installs into `local-packages`, then reverts the
version bump via `git checkout package.json` so the repo stays clean.

## Skills consolidation rule (avoid collisions)
- **Only `pi-braid-skills` declares `pi.skills`.** `pi-braid` and
  `pi-braid-contrib` must NOT have a `pi.skills` entry.
- If you add a skill, add it to `pi-braid-skills/skills/<name>/SKILL.md` and
  remove it from any other package. A duplicate name causes pi to load the
  first-declared copy and skip the rest (silent shadowing).

## PR guidelines (before merge)
1. **Branch naming:** `feature/<slug>`, `fix/<slug>`, `chore/<slug>`.
2. **Pre-merge checks (all green):**
   - `npm run typecheck`
   - `npm run build`
   - `npm test`
   - `npm run lint`
   - `npm run format:check`
   - `npm run ci:check` (docs + dep-drift + typecheck + tests)
3. **Version bump:** merge to `main` with a proper semver bump
   (`npm version patch|minor|major`), NOT a prerelease.
4. **Skills:** confirm no `pi.skills` leaked into `pi-braid`/`pi-braid-contrib`.
5. **Local install:** after merge, re-run `npm run release:local` (or rely on the
   symlink) so `local-packages` is not stale.
6. **No stray tgz:** `local-packages/*.tgz` should never be referenced by
   `local-packages/package.json`; the symlink (`file:...`) is the source of truth.

## Debugging collisions
If pi reports `"<skill>" collision` and skips a `pi-braid-skills` skill:
1. Check `local-packages/node_modules/pi-braid/package.json` — it must have NO
   `pi.skills`. If it does, the install is a stale tgz; re-run the symlink install.
2. Confirm `local-packages/node_modules/pi-braid` is a symlink, not a directory.
