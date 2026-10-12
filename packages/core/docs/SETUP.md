<!-- status: current -->
<!-- Canonical setup reference. Replaces the scattered install snippets in README and CONTRIBUTING. -->

# Setup & Configuration

Complete reference for installing braid, configuring pi to load it, enabling companion skill packs, and troubleshooting common setup issues.

> **TL;DR for new users.** Clone → build → register in `~/.pi/agent/settings.json` → done. See the [Fast start](#fast-start) section.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Fast start](#fast-start)
3. [Install paths](#install-paths)
4. [Skills](#skills)
5. [Configuration reference](#configuration-reference)
6. [Module toggling](#module-toggling)
7. [Storage & paths](#storage--paths)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool            | Version       | Verify                     |
| --------------- | ------------- | -------------------------- |
| Node.js         | ≥ 22.19       | `node --version`           |
| pi-coding-agent | peer-resolved | `which pi && pi --version` |
| npm             | bundled       | `npm --version`            |
| git             | any recent    | `git --version`            |

The Node floor is the `engines` field in `package.json` (mirrored by every
workspace manifest); if this table and `engines` ever disagree, trust
`engines`.

**How the pi version resolves.** braid declares the `@earendil-works/pi-*`
packages as peer dependencies with unconstrained (`*`) ranges. npm resolves
peers at install time: against a compatible pi installation already in your
tree when one exists, otherwise by auto-installing the current release. The
result is pinned in `package-lock.json`, so braid runs against whatever pi
version your install resolved to rather than pinning its own;
`npm ls @earendil-works/pi-coding-agent` shows what you got.

---

## Fast start

The three-step minimum:

```bash
# 1. Clone and build
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build

# 2. Register with pi (user-global — applies to every pi session)
cat > ~/.pi/agent/settings.json <<'JSON'
{
  "packages": [
    "file:~/pi-braid/packages/core"
  ]
}
JSON

# 3. Use pi as normal
pi
```

That's it. Now every `pi` invocation will load braid alongside pi-core.

> **Register `packages/core`, not the repo root.** The root `package.json` has
> no `pi` field, so `file:~/pi-braid` loads nothing. `packages/core` declares
> both `pi.extensions` (the braid extensions) and `pi.skills` (the core skill
> set, which ships inside the package). `packages/skills` carries the on-demand
> set, registered per project - see [§ Skills](#skills).

### Verify

Inside pi, the `<available_skills>` block in the system prompt lists the core skill set that ships with `packages/core`. If you see them, install succeeded. If not, jump to [§ Troubleshooting](#troubleshooting).

---

## Install paths

### 1. User-global clone (recommended)

Install once, applies to every pi session across all projects.

```bash
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid
npm install
npm run build
```

Settings:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["file:~/pi-braid/packages/core"],
}
```

### 2. Local-packages install (canonical, matches `docs/LOCAL_DEV.md`)

The maintainer path: publish braid into `~/.pi/agent/local-packages`, then
register the installed path. `npm run publish:local` packs `packages/core` into
`local-packages` as a versioned tgz (`<version>-<branch>.<iteration>`); the
live-symlink flow links source directly.

```bash
cd ~/pi-braid
npm run publish:local          # versioned tgz into ~/.pi/agent/local-packages
# …or a live symlink instead of a tarball:
cd ~/.pi/agent/local-packages && npm install file:<absolute-path-to>/pi-braid/packages/core
```

Settings:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["~/.pi/agent/local-packages/node_modules/pi-braid"],
}
```

The core skill set needs no entry of its own: it ships with `packages/core`. The
on-demand pack (`pi-braid-skills`) is registered in the settings file of the
project that wants it - see [§ Skills](#skills).

See [`LOCAL_DEV.md`](LOCAL_DEV.md) for the full publish/link flow, the version
scheme, and the skills-collision rule.

### 3. Project-scoped clone (per-project isolation)

For projects that should always have braid regardless of the user's global config:

```bash
git clone https://github.com/kifirkin/pi-braid.git <project>/.pi/extensions/pi-braid
cd <project>/.pi/extensions/pi-braid
npm install
npm run build
```

Settings:

```jsonc
// <project>/.pi/settings.json
{
  "packages": ["./extensions/pi-braid/packages/core", "./extensions/pi-braid/packages/skills"],
}
```

Project-scoped wins on collision with user-global (per pi's resolution order), and a project-scoped `braid.modules` block is not read by braid at all: pi owns that file and applies it only for a trusted project, so pin braid's module state in `~/.pi/agent/settings.json` or toggle it (which persists under `~/.pi/agent/braid/`).

### 4. Once-per-session flag (no install)

If you don't want to commit braid to either config - useful for trying it on one task:

```bash
pi -e /path/to/pi-braid/packages/core
```

`pi -e <path>` adds an extension directory for that session only. No clone required; the path must point to a built package (i.e. you've already run `npm install && npm run build`).

### 5. Direct path from a clone anywhere

Same idea as option 1 but the path can be anywhere on disk:

```bash
git clone https://github.com/kifirkin/pi-braid.git /some/other/path
cd /some/other/path && npm install && npm run build
```

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["file:/some/other/path/packages/core"],
}
```

### Choosing an install path

| Path                      | Pros                                                       | Cons                                          |
| ------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| 1. User-global clone      | One install, all projects                                  | Affects every project (occasionally unwanted) |
| 2. Local-packages install | Versioned tgz or live symlink; matches the maintainer flow | Requires the publish/link step                |
| 3. Project-scoped clone   | Per-project isolation; version-pinned                      | Need to rebuild per project after `git pull`  |
| 4. `-e` flag              | Zero config                                                | Must rebuild each session; easy to forget     |
| 5. Direct path            | Same as #1 with arbitrary location                         | Same                                          |

The recommended default is **option 1** for users who want braid everywhere, **option 2** for maintainers following `LOCAL_DEV.md`, **option 3** for users who pin extensions per project.

---

## Skills

braid's skills come in two tiers.

- **Core set** - ships inside `packages/core` (`skills/`, declared by
  `pi.skills` in the package manifest). Registering `packages/core` loads it; it
  needs no settings entry of its own.
- **On-demand set** - the separate `pi-braid-skills` pack
  (`packages/skills/skills/`: eight `SKILL.md` plus shared content under
  `skills/_shared/`), registered in the settings file of the project that wants
  it.

Every skill is one `SKILL.md`. The catalog table (one row per skill, with its
verdict and one-line description, covering both tiers) is
[`packages/skills/README.md`](../../skills/README.md), and
`find packages/core/skills -name SKILL.md | wc -l` counts the core set at any
time.

Skills in a registered package are listed in the system prompt's
`<available_skills>` block. The agent reads any SKILL.md on demand via the
`read` tool; no manual copy needed.

### Companion workspaces

`pi-braid-skills` and `pi-braid-contrib` are not separate repositories - since
the monorepo migration they are in-repo workspaces
(`packages/skills`, `packages/contrib`). Register the workspaces you want:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["file:~/pi-braid/packages/core", "file:~/pi-braid/packages/contrib"],
}
```

`packages/contrib` is the code-only extension workspace (browser, codebase,
diff, …) - no skills. Add it only if you want those
tools; its extensions are heavier on system-prompt tokens. `packages/skills`
adds the on-demand skill set, so register it in the project that wants those
skills rather than globally ([§ Skills](#skills)).

---

## Configuration reference

braid reads configuration from the standard pi locations, with a dedicated `braid` namespace:

```
~/.pi/agent/settings.json                                    # user-global (default location)
<cwd>/.pi/settings.json                                      # project-scoped, pi's own file (pi's trust gate)
~/.pi/agent/braid/config.json                                # braid-owned config file (session profiles)
~/.pi/agent/braid/projects/<project>/module-overrides.json   # braid-owned module toggles
```

The user-global file always exists; the project one is optional and belongs to pi (braid neither creates it nor writes it, and does not read its `braid.modules` block: pi applies that file only for a trusted project, and braid cannot ask pi that while extensions load). `braid.modules` is read from two sources, later source wins per key: the user-global file and braid's own `module-overrides.json` store, which is where `/modules-toggle` and friends persist. Every other `braid.*` reader reads the user-global file only. Copy-ready examples live in the repo's [`examples/`](../../../examples) directory.

### Schema

`packages` is pi-native - what to load as extensions. Everything braid reads sits under the top-level `braid` key. Keys that exist in code today:

| Key                                     | Type              | Default                             | Purpose                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braid.modules.<ref>`                   | boolean           | per manifest                        | Force-enable (`true`) or disable (`false`) an extension id or module group (`memory`, `heartbeat`); a persisted `false` removes a default-enabled extension from the boot set (see [§ Module toggling](#module-toggling)).                                                                                                                            |
| `braid.suppressNudges`                  | boolean           | `false`                             | Silence all cognitive nudges (enforcement whispers, heartbeat suggestions, feedback reminders).                                                                                                                                                                                                                                                       |
| `braid.timezone`                        | IANA name         | `Europe/Moscow`                     | Time zone for all braid-facing time rendering.                                                                                                                                                                                                                                                                                                        |
| `braid.enforcement.nudgeConfigs.<type>` | object            | built-in per-type defaults          | Per-nudge-type overrides with fields `baseCooldownMs` (number), `escalateAfter` (number), `deduplicate` (boolean). Types: `validation`, `recordFailure`, `malformed`, `memory`, `scratchpad`, `context`, `sessionSignals`. Invalid entries are logged and dropped.                                                                                    |
| `braid.memory.writeGate`                | object            | gate ON, 20-min cooldown, `enforce` | Review-before-write gate on episode writes; `mode: "warn"` logs decisions and writes anyway; `sites` opts individual writers out.                                                                                                                                                                                                                     |
| `braid.timers.maxWakeAttempts`          | integer 1..10     | `3`                                 | Redelivery cap for a failed timer wake before it is dropped with a visible notice.                                                                                                                                                                                                                                                                    |
| `braid.timers.wakeAlert`                | object            | ON, `outcomeTimeouts: 2`            | Dead-wake page: repeated outcome timeouts / exhausted redeliveries feed the watchdog's wake-delivery condition, which pages the owner out of band (telegram) once per episode plus one recovery line. `mode: "off"` disables the feed (delivery itself is unchanged); `outcomeTimeouts` is an integer 2..10 (1 would page on every normal long turn). |
| `braid.context.contextLimitTokens`      | positive number   | provider context window             | The window every surface computes with (usage math, density, fallbacks, pi-core threshold compaction and overflow detection, TUI footer). A CEILING: min(contextLimitTokens, true window) when known, else the cap; re-plumbed on session start and /reload and never widens a smaller true window. The provider catalog keeps the true size.         |
| `braid.context.toolResultSizeCap`       | object            | ON, 262144 chars                    | Capture-time cap: oversized tool results are flushed to disk and replaced by a stub.                                                                                                                                                                                                                                                                  |
| `braid.context.staleToolResultOffload`  | object            | OFF                                 | Opt-in age/size offload of stale large tool results (defaults: `minChars` 4000, `stalenessTurns` 40, `keepRecentTurns` 20, `maxOffloadCharsPerRun` 65536).                                                                                                                                                                                            |
| `braid.context.contextEmergencyOffload` | object            | ON                                  | Emergency offload of the largest tool results when a context-window (413) error fires, then one retry (defaults: `minChars` 262144, `maxCharsPerRun` 1048576, `keepRecentTurns` 1).                                                                                                                                                                   |
| `braid.telegram.sendMaxChars`           | positive number   | `4096`                              | Plain-text cap for `telegram_send`, re-read per call.                                                                                                                                                                                                                                                                                                 |
| `braid.telegram.notifyMaxChars`         | positive number   | `1200`                              | Craft target and guard for turn-end notifications.                                                                                                                                                                                                                                                                                                    |
| `braid.telegram.pauseStateFile`         | path string       | built-in default                    | Override for the `/telegram` pause-state file path.                                                                                                                                                                                                                                                                                                   |
| `braid.contrib.<name>`                  | boolean or object | enabled / per-extension             | Per-contrib-extension config - see [§ Contrib extensions](#contrib-extensions).                                                                                                                                                                                                                                                                       |

### Worked example

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["file:~/pi-braid/packages/core"],
  "braid": {
    // force-enable the two opt-in extensions
    "modules": {
      "error-tracking": true,
      "health-maintenance": true,
    },
    "timezone": "Europe/Berlin",
    "context": {
      "contextLimitTokens": 262000,
      "staleToolResultOffload": { "enabled": true },
    },
  },
}
```

The full surface as a single file: [`examples/full-config.settings.json`](../../../examples/full-config.settings.json). Environment variables (provider keys, Telegram credentials): [`examples/.env.example`](../../../examples/.env.example).

### Contrib extensions

The 12 contrib extension names: `browser`, `codebase`, `diff`, `healthcheck`, `networkMonitor`, `observatory`, `pathSecurity`, `rateLimiter`, `repl`, `sleep`, `systemMonitor`, `toolConfig`.

- Loaded through the convenience bundle (`packages/contrib/index.ts` as an extension entry): `braid.contrib.<name>: false` skips that extension entirely; absent or `true` loads it. With `packages/contrib` registered as a package, pi loads all 12 directly and these booleans are not read.
- Behavior keys (honored in both load paths):
  - `braid.contrib.browserAdvanced: true` - the 7 advanced browser tools (opt-in).
  - `braid.contrib.pathSecurity.block: true` - hard-block dangerous operations instead of soft-warn.
  - `braid.contrib.observatory.record: true` - record session lifecycle events.
  - `braid.contrib.networkMonitor` - `{ profileName, reachabilityUrl, curlTimeoutSecs, disconnectDelayMs, connectTimeoutMs, pollIntervalMs, cooldownMs, autoReconnect, autoWatch, probeIntervalMs, maxAttemptsPerOutage, reconnectCooldownMs }`.
  - `braid.contrib["rate-limiter"]` - `{ rpm, tpm, providers: { <provider>: { rpm, tpm } } }` ceilings; note the hyphenated key (the bundle toggle name for the extension itself is `rateLimiter`).
  - `braid.contrib._global.enabled: [...]` - global tool list managed by the tool-config extension.

### Session profiles

`~/.pi/agent/braid/config.json` (braid-owned, read fresh per session start):

```jsonc
{
  "sessionProfiles": [
    { "name": "work", "cwd": "~/work", "hint": "…" },
    { "name": "personal", "cwd": "~/projects/personal" },
  ],
}
```

First match wins - a match is the profile `cwd` itself or any directory under it, with `~` expanded against home. `hint` is a one-shot steer the skills tool delivers on the session's first non-empty prompt. Worked example: [`examples/session-profiles.config.json`](../../../examples/session-profiles.config.json).

---

## Module toggling

braid's loader follows a four-tier precedence (high → low):

1. **Runtime API** - `/modules-toggle`, `/modules-enable`, `/modules-disable` (in-session)
2. **Settings** - `braid.modules`, later source wins per id: `~/.pi/agent/settings.json`, then braid's own `~/.pi/agent/braid/projects/<project>/module-overrides.json`, where the toggle commands persist. A project-scoped `<cwd>/.pi/settings.json` stays pi's file: pi applies it only for a project it trusts, and braid cannot ask pi that while extensions load, so braid does not read it.
3. **Env var** - `BRAID_MODULES=...`
4. **Defaults** - all extensions whose manifest does not have `disabledByDefault: true`

### `BRAID_MODULES` syntax

```bash
# Comma-separated list of refs. Each ref is:
#   id              -> enable that extension
#   +id / -id       -> enable / disable (explicit)
#   module-group    -> enable / disable the whole group
```

```bash
unset BRAID_MODULES                    # all default-enabled extensions

export BRAID_MODULES="-enforcement"    # defaults minus enforcement
export BRAID_MODULES="memory"          # only the memory group
export BRAID_MODULES="memory,heartbeat,+error-tracking"  # two groups plus an opt-in
```

The refs define the loaded set, they do not merge with the defaults: when the list contains at least one valid enabled ref (bare or `+`), that collection IS the enabled set; with only `-`refs, the defaults load minus the disabled refs. The full extension id list is the `MANIFEST` in [`src/extensions/manifest.ts`](../src/extensions/manifest.ts).

### Module groups

Two extension sets share a `module` field on their manifest entry; toggling the module name affects all of them. Every other extension is toggled by its own id.

| Module group | Members                                                                                      | Default |
| ------------ | -------------------------------------------------------------------------------------------- | ------- |
| `memory`     | three-memory-stores, memory-agent-bridge, session-recall, context-manager, context-lifecycle | enabled |
| `heartbeat`  | heartbeat-scheduler, analytics                                                               | enabled |

The manifest's `module` label has no structural role beyond this shorthand. Opt-in extensions (`disabledByDefault: true` in the manifest): `error-tracking`, `health-maintenance`.

### Per-extension overrides

Any extension can be force-enabled by id, regardless of whether it's in a module group:

```jsonc
// ~/.pi/agent/settings.json
{
  "braid": {
    "modules": {
      "error-tracking": true,
    },
  },
}
```

Missing entries inherit the default (enabled unless `disabledByDefault: true`).

---

## Storage & paths

All braid-specific data lives under `~/.pi/agent/braid/`:

```
~/.pi/agent/braid/
├── config.json  # braid-owned config (session profiles)
├── memory/      # three-store memory files
├── snapshots/   # workspace snapshots
├── sessions/    # session-level state
└── projects/    # per-project state (module-overrides.json, timers, locks)
```

Constants in [`src/lib/config/braid-paths.ts`](../src/lib/config/braid-paths.ts) own the path logic. Don't hardcode paths.

braid respects the standard pi env var `PI_CODING_AGENT_DIR` for relocating the entire agent home.

---

## Troubleshooting

### braid doesn't show up in `<available_skills>`

Run `pi` with `--verbose` and check the startup log. Common causes:

- **Wrong path.** `file:` specs must be absolute or `~`-prefixed, and the directory must contain `dist/index.js` (i.e. `npm run build` ran successfully).
- **Stale build.** If you ran `git pull` on the braid repo, you must `npm run build` again.
- **Wrong package directory.** The `package.json` must have `"pi": { "extensions": [...] }`. Run `cat ~/pi-braid/packages/core/package.json | grep -A4 '"pi"'` to confirm.

### Settings have no effect

- User-global `~/.pi/agent/settings.json` is loaded for every pi session. `braid.modules` is read from there, then from braid's own module-overrides store under `~/.pi/agent/braid/projects/<project>/`; a project-scoped `<cwd>/.pi/settings.json` is pi's own file and is not read (pi applies it only when it trusts the project, and braid cannot ask pi that while extensions load); the other `braid.*` readers use the user-global file only.
- Both files are pure JSON - comments and trailing commas are not allowed (use a JSON validator if unsure).
- Most braid settings re-read the file on every call, so an edit applies without a restart. Extension loading (`packages`, `braid.modules`) is resolved once at load - restart pi for those.

### Tools duplicate / conflict

braid deliberately re-registers a few tools that pi-core also provides (e.g. `think`, `verify`). This is intentional - braid's versions wrap pi-core's with metacognitive signals. If you see duplication in `<Available tools>`, report it as a bug; some duplication is expected.

### Build fails on a fresh clone

```bash
rm -rf node_modules dist
npm install
npm run build
```

If the failure persists, open an issue with the full error from `npm run build`.

### TypeScript errors after upgrade

braid declares `@earendil-works/pi-*` as peer dependencies with unconstrained
(`*`) ranges, resolved at install time (see [Prerequisites](#prerequisites)).
Make sure the pi packages are in this repo's dependency tree:

```bash
ls node_modules/@earendil-works/ 2>/dev/null
# If empty, the pi packages aren't in this repo's dependency tree.
# Run `npm install` (npm auto-installs unconstrained peer dependencies),
# or run pi from outside this repo.
```

### Disabling and restarts

The in-session `/modules-disable` persists the choice to braid's own `braid.modules` store (`~/.pi/agent/braid/projects/<project>/module-overrides.json`); the change takes effect at the next session start (already-loaded extensions keep running). A persisted `false` entry removes a default-enabled extension at boot, so the choice survives restarts. The equivalent env-var route is `export BRAID_MODULES="-<id>"` (module values are real JSON booleans - `false`, not `0` or `"off"`).

---

## See also

- [`README.md`](../README.md) - overview + fast start
- [`AGENTS.md`](../AGENTS.md) - repository conventions
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) - for braid contributors
