<!-- status: current -->
<!-- Created 2026-07-02 as the canonical setup reference. Replaces the scattered install snippets in README and CONTRIBUTING. -->

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

| Tool      | Version       | Verify            |
| --------- | ------------- | ----------------- |
| Node.js   | ≥ 20          | `node --version`  |
| pi-coding-agent | ≥ 0.80   | `which pi && pi --version` |
| npm       | bundled       | `npm --version`   |
| git       | any recent    | `git --version`   |

braid's peer-deps require the **0.80+ line** of the pi ecosystem
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`).

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
  "packages": ["file:~/pi-braid"]
}
JSON

# 3. Use pi as normal
pi
```

That's it. Now every `pi` invocation will load braid alongside pi-core.

### Verify

Inside pi, the `<available_skills>` block in the system prompt lists braid's 7 bundled skills. If you see them, install succeeded. If not, jump to [§ Troubleshooting](#troubleshooting).

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
  "packages": ["file:~/pi-braid"]
}
```

### 2. Project-scoped clone (per-project isolation)

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
  "packages": ["./extensions/pi-braid"]
}
```

Project-scoped wins on collision with user-global (per pi's resolution order).

### 3. Once-per-session flag (no install)

If you don't want to commit braid to either config — useful for trying it on one task:

```bash
pi -e /path/to/pi-braid
```

`pi -e <path>` adds an extension directory for that session only. No clone required; the path must point to a built braid (i.e. you've already run `npm install && npm run build`).

### 4. Direct path from a clone anywhere

Same idea as option 1 but the path can be anywhere on disk:

```bash
git clone https://github.com/kifirkin/pi-braid.git /some/other/path
cd /some/other/path && npm install && npm run build
```

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["file:/some/other/path"]
}
```

### 5. Git URL install via the global package manager

If your pi setup supports the `npm:` / `git+https:` spec on the `packages` field, you can install braid directly from GitHub:

```bash
# Install once globally with npm
npm install -g git+https://github.com/kifirkin/pi-braid.git
```

Settings:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["pi-braid"]
}
```

> **Caveat:** Whether pi accepts `npm:` specs on the `packages` field depends on your pi version's resolver. If this doesn't work, fall back to option 1 (clone + `file:` spec).

### Choosing an install path

| Path                                    | Pros                                       | Cons                                          |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| 1. User-global clone                    | One install, all projects                  | Affects every project (occasionally unwanted) |
| 2. Project-scoped clone                 | Per-project isolation; version-pinned      | Need to rebuild per project after `git pull`   |
| 3. `-e` flag                            | Zero config                                | Must rebuild each session; easy to forget     |
| 4. Direct path                          | Same as #1 with arbitrary location         | Same                                           |
| 5. Git URL via package manager          | Single command                             | Depends on resolver; no clean upgrade story   |

The recommended default is **option 1** for users who want braid everywhere, **option 2** for users who pin extensions per project.

---

## Skills

braid ships **7 skills** in the `skills/` directory:

| Skill                 | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `software-engineer`   | Debug / implement / review universal procedure                    |
| `tone-quality`        | Don't write empty / decorative text                              |
| `pi-reference`        | Complete reference for pi SDK, settings, RPC, sessions            |
| `healthcheck`         | Run agent self-diagnostic                                        |
| `meta-improvement`    | Create new skills, run self-improving experiments                |
| `agent-testing`       | Programmatic agent behavior testing                               |
| `subagent`            | Spawn / monitor / coordinate pi subagents                        |

Skills load automatically when braid is registered — they're listed in the system prompt's `<available_skills>` block. The agent reads any SKILL.md on demand via the `read` tool; no manual copy needed.

### Companion skill packs

These add skills beyond what braid ships by default. They are separate repositories because they have wider scope (community-contributed, broader domains).

| Pack                                       | Skills                                                                                                  | Install                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-braid-skills](https://github.com/kifirkin/pi-braid-skills) | code-search, code-refactoring, documentation, dox, openspec, process-control, research, vcs-tools | `git clone https://github.com/kifirkin/pi-braid-skills ~/pi-braid-skills` then add `"file:~/pi-braid-skills"` to `packages` |
| [pi-braid-contrib](https://github.com/earendil-works/pi-braid-contrib) | adversarial-engagement, design-system, paper-writer, twitter, visual-creator, visual-validator, meme, looping-clanker, socratic-irony | `git clone https://github.com/earendil-works/pi-braid-contrib ~/pi-braid-contrib` then add `"file:~/pi-braid-contrib"` to `packages` |

Combined install:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "file:~/pi-braid",
    "file:~/pi-braid-skills",
    "file:~/pi-braid-contrib"
  ]
}
```

> The contrib pack is creative-tooling-heavy — useful for adjacent tasks but not for everyday software work. Add only what you want.

---

## Configuration reference

braid reads configuration from the standard pi locations, with a dedicated `braid` namespace:

```
~/.pi/agent/settings.json    # user-global (default location)
<cwd>/.pi/settings.json      # project-scoped (overrides user-global)
```

The user-global file always exists; the project one is optional.

### Schema

```jsonc
{
  // pi's top-level packages entry — what to load as extensions
  "packages": [
    "file:~/pi-braid"
  ],

  // braid-specific config (currently: module toggles)
  "braid": {
    "modules": {
      "enforcement": true,
      "error-tracking": false,
      "heartbeat": true
    }
  }
}
```

### Full example (braid + skills + selective modules)

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "file:~/pi-braid",
    "file:~/pi-braid-skills"
  ],
  "braid": {
    "modules": {
      "enforcement": true,
      "memory": true,
      "cognitive": true,
      "self": true,
      "heartbeat": false,    // opt-in only; explicitly disable
      "error-tracking": false,
      "watchdog": false,
      "health-maintenance": false
    }
  }
}
```

See [§ Module toggling](#module-toggling) below for the full module / extension id list.

---

## Module toggling

braid's loader follows a four-tier precedence (high → low):

1. **Runtime API** — `/modules-toggle`, `/modules-enable`, `/modules-disable` (in-session)
2. **Settings file** — `braid.modules` in `~/.pi/agent/settings.json` (or project-scoped)
3. **Env var** — `BRAID_MODULES=...`
4. **Defaults** — all extensions whose manifest does not have `optIn: true`

### `BRAID_MODULES` syntax

```bash
# Comma-separated list of refs. Each ref is:
#   id              -> enable that extension
#   +id / -id       -> enable / disable (explicit)
#   module-group    -> enable / disable the whole group
```

```bash
unset BRAID_MODULES                   # all defaults

# Selective enable / disable
export BRAID_MODULES="all,-error-tracking"
export BRAID_MODULES="-enforcement"
export BRAID_MODULES="+heartbeat"     # opt-in group; explicit enable
export BRAID_MODULES="core,+health-maintenance,-watchdog"
```

### Module groups

A few extensions share a `module` field on their manifest entry; toggling the module name affects all of them.

| Module group | Members                                        | Default |
| ------------ | ---------------------------------------------- | ------- |
| `core`       | polyfill, metacognition, scratchpad, input-polisher, prompt-builder, agent-environment, workspace-snapshot | enabled |
| `cognitive`  | reasoning, topic-drift, sycophancy-detector, turn-outcome | enabled |
| `enforcement`| enforcement                                    | enabled |
| `memory`     | three-memory-stores, memory-agent-bridge, session-recall, context-manager, context-lifecycle, scratchpad, workspace-snapshot | enabled |
| `heartbeat`  | heartbeat-scheduler, analytics                 | enabled |
| `self`       | timer, auto-recovery, latent-activator, watchdog, health-maintenance, error-tracking | mostly enabled, opt-in for `watchdog` / `health-maintenance` / `error-tracking` |

Toggling a module group name is shorthand for toggling each member. Not all extensions have a `module` field — those can only be toggled by their individual id.

### Per-extension overrides

Any extension can be enabled / disabled by id, regardless of whether it's in a module group:

```jsonc
// ~/.pi/agent/settings.json
{
  "braid": {
    "modules": {
      "enforcement": true,
      "watchdog": false
    }
  }
}
```

Missing entries inherit the default (enabled unless `optIn: true`).

---

## Storage & paths

All braid-specific data lives under `~/.pi/agent/braid/`:

```
~/.pi/agent/braid/
├── memory/      # three-store memory files
├── snapshots/   # workspace snapshots
└── sessions/    # session-level state
```

Constants in [`src/lib/config/braid-paths.ts`](../src/lib/config/braid-paths.ts) own the path logic. Don't hardcode paths.

braid respects the standard pi env var `PI_CODING_AGENT_DIR` for relocating the entire agent home.

---

## Troubleshooting

### braid doesn't show up in `<available_skills>`

Run `pi` with `--verbose` and check the startup log. Common causes:

- **Wrong path.** `file:` specs must be absolute or `~`-prefixed, and the directory must contain `dist/index.js` (i.e. `npm run build` ran successfully).
- **Stale build.** If you ran `git pull` on the braid repo, you must `npm run build` again.
- **Wrong package directory.** The `package.json` must have `"pi": { "extensions": [...] }`. Run `cat ~/pi-braid/package.json | grep -A4 '"pi"'` to confirm.

### Settings have no effect

- User-global `~/.pi/agent/settings.json` is loaded for every pi session. Project-scoped `<cwd>/.pi/settings.json` wins on collision.
- Both files are pure JSON — comments and trailing commas are not allowed (use a JSON validator if unsure).
- After editing, restart pi (settings are read once per session).

### Tools duplicate / conflict

braid deliberately re-registers a few tools that pi-core also provides (e.g. `think`, `verify`). This is intentional — braid's versions wrap pi-core's with metacognitive signals. If you see duplication in `<Available tools>`, report it as a bug; some duplication is expected.

### Build fails on a fresh clone

```bash
rm -rf node_modules dist
npm install
npm run build
```

If the failure persists, open an issue with the full error from `npm run build`.

### TypeScript errors after upgrade

braid pins `@earendil-works/pi-*` peer-deps at `>=0.80.0`. Make sure your pi installation satisfies this:

```bash
ls node_modules/@earendil-works/ 2>/dev/null
# If empty, your pi installation isn't installed as an npm dependency in this repo.
# Either install braid's dev-deps or run pi from outside this repo.
```

### Module won't disable

The flag is `false`, not `0` or `"off"`. JSON booleans only.

---

## See also

- [`README.md`](../README.md) — overview + fast start
- [`AGENTS.md`](../AGENTS.md) — repository conventions
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — for braid contributors
