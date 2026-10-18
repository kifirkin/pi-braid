# pi-braid-contrib

Standalone contrib extensions for [pi](https://pi.dev) - 12 focused extensions that add browser automation, repo analysis, and operational guardrails to the coding agent.

## Install

```bash
pi install npm:pi-braid-contrib
```

(There is no git install for this package: it is one workspace inside the
`pi-braid` monorepo, and a git install of the repo root registers nothing.)

## What you get

12 extensions, each loadable individually. One line per extension:

| Extension         | What it adds                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser`         | Native CDP browser automation: navigate, DOM snapshot, JS eval, screenshot; 7 advanced tools (cookies, content, tabs) opt-in via `braid.contrib.browserAdvanced` |
| `codebase`        | Repo explorer: directory tree with stats, import/export dependency graph (dead-ends, orphans, hubs, cycles), per-file impact analysis                            |
| `diff`            | Structured file and git-revision diffing: hunks with line numbers, change types, stats                                                                           |
| `healthcheck`     | Agent self-diagnostic: tools, extensions, shell, system resources, with recommendations                                                                          |
| `network-monitor` | Tunnel status probe and rootless reconnect for v2RayTun and Happ (deep links or the client's network-extension profile), autonomous watcher                      |
| `observatory`     | Lightweight session inspector: pi session status, registered tools, recorded lifecycle events                                                                    |
| `path-security`   | Tiered security classification for tool calls; soft-warn by default, opt-in hard-block of dangerous bash/write operations                                        |
| `rate-limiter`    | Per-provider RPM/TPM limits with built-in defaults and a fallback chain                                                                                          |
| `repl`            | Persistent JavaScript execution with RLM mode (chunk/search/filter/map/reduce over large context data)                                                           |
| `sleep`           | Pause agent execution for N seconds; the agent resumes automatically - no polling loops                                                                          |
| `system-monitor`  | CPU, memory, disk, and top-process metrics without shelling out to ps/top/df                                                                                     |
| `tool-config`     | Per-tool enable/disable lists read/written for the `/tools` TUI and runtime `setActiveTools`                                                                     |

## What this does not do

- It does not sandbox its extensions. Each one runs with full system access in your session;
  `path-security` only constrains the blast radius of tool calls, and is soft-warn by default.
- It does not bundle its own runtime dependencies. Its declared dependencies (currently `acorn`) are
  installed by whoever installs the package; the monorepo's hoisted `node_modules` is a developer
  convenience, not the mechanism (see [`AGENTS.md`](AGENTS.md)).
- It does not include skills. The default skill catalog ships with `pi-braid`
  (`packages/core/skills`); the on-demand set is the separate `pi-braid-skills` pack.

## Activation preconditions

- Node.js 22+ (pi's floor) and a pi installation the extensions run under.
- Native load: pi must discover the `pi.extensions` entries, or you load `index.ts` as the bundle.

## Native pi load via packages (recommended)

The package declares all 12 entry files in `pi.extensions`, so pi discovers them automatically once installed. Enable or disable individual extensions through pi's per-package resource filtering in `settings.json`.

## Convenience bundle (braid.contrib toggles)

Alternatively, load the bundle entry directly:

```json
{
  "extensions": ["pi-braid-contrib/index.ts"]
}
```

Then toggle extensions and behavior from `~/.pi/agent/settings.json` under `braid.contrib.*`:

| Setting                                                                             | Default             | Effect                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braid.contrib.browserAdvanced: true`                                               | `false`             | Enables the 7 advanced browser tools and the `/browser-tabs` command; core browser tools always load. Read at extension load; restart after changing.                                                                                                                 |
| `braid.contrib.pathSecurity: { block: true }`                                       | `false` (soft-warn) | Hard-blocks dangerous bash/write operations instead of warning. Read at extension load; restart after changing.                                                                                                                                                       |
| `braid.contrib.observatory: { record: true }`                                       | `false`             | Writes session lifecycle events to `<braidDir>/observatory/sessions/*.jsonl`. Read at extension load; restart after changing.                                                                                                                                         |
| `braid.contrib.rateLimiter: { rpm, tpm, providers }` (`rate-limiter` is deprecated) | built-in defaults   | Per-provider RPM/TPM ceilings and max-wait. Read at extension load; restart after changing.                                                                                                                                                                           |
| `braid.contrib.networkMonitor: { client, outageThreshold, ... }`                    | built-in defaults   | Tunnel watch/reconnect. The watcher toggles only after `outageThreshold` consecutive failed probes (default 3); the toggle mechanism comes from the client adapter (deep links, or the NE profile via `scutil --nc stop\|start`); settings are re-read while running. |
| `braid.contrib.<name>: false`                                                       | `true`              | Disables an entire extension (a literal `false` only; every other value, and an absent key, enables)                                                                                                                                                                  |

`braid.contrib.<name>: false` is honored on both loading paths: the bundle skips a disabled module,
and a module loaded through `pi.extensions` registers nothing. The value is read when the extension
loads, so restart the agent after changing it.

## Trust and safety

Pi extensions run with full system access. This package is no exception: extensions execute arbitrary code in your session. Review the source before installing - each extension lives in its own top-level directory, and `path-security` exists precisely to constrain the blast radius of the rest.

## License

[MIT](LICENSE)
