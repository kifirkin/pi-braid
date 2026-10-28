# pi-braid-contrib

12 focused extensions for [pi](https://pi.dev): a real browser, repo analysis, guarded tool calls,
and the operational detail a long session needs, each loadable on its own.

## Install

```bash
pi install npm:pi-braid-contrib
```

## What you get

12 extensions, each loadable individually. One line per extension:

| Extension         | What it adds                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser`         | Native CDP browser automation: navigate, DOM snapshot, JS eval, screenshot, plus 7 advanced tools (cookies, readable content, tabs) opt-in via `braid.contrib.browserAdvanced` |
| `codebase`        | Repo explorer: directory tree with stats, import and export graph (dead ends, orphans, hubs, cycles), per-file impact analysis                                                 |
| `diff`            | Structured file and git-revision diffing: hunks with line numbers, change types, stats                                                                                         |
| `healthcheck`     | Self-diagnostic: tools, extensions, shell, system resources, with recommendations                                                                                              |
| `network-monitor` | Probes a local tunnel client and reconnects it without root; an autonomous watcher toggles only after repeated failed probes                                                   |
| `observatory`     | Session inspector: pi session status, registered tools, recorded lifecycle events                                                                                              |
| `path-security`   | Tiered classification of tool calls; warns by default, optional hard block of dangerous bash and write calls                                                                   |
| `rate-limiter`    | Per-provider RPM and TPM limits with defaults and a fallback chain                                                                                                             |
| `repl`            | Persistent JavaScript with chunk, search, map and reduce over large data                                                                                                       |
| `sleep`           | Pause N seconds, then resume on its own                                                                                                                                        |
| `system-monitor`  | CPU, memory, disk and top processes                                                                                                                                            |
| `tool-config`     | Per-tool enable and disable lists behind `/tools`                                                                                                                              |

## Configuration

The package declares all 12 entry files in `pi.extensions`, so pi discovers them once the package is
registered. Settings are read at extension load: restart the agent after changing one.

| Setting                                                          | Default                          | Effect                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `braid.contrib.browserAdvanced: true`                            | `false`                          | Enables the 7 advanced browser tools; the 4 core ones always load                                                       |
| `braid.contrib.pathSecurity: { block: true }`                    | `false` (soft-warn)              | Hard-blocks dangerous bash and write calls instead of warning                                                           |
| `braid.contrib.observatory: { record: true }`                    | `false`                          | Writes lifecycle events to `observatory/sessions/*.jsonl` under braid's state directory                                 |
| `braid.contrib.rateLimiter: { rpm, tpm, providers }`             | built-in defaults                | Per-provider ceilings and max wait; the hyphenated `rate-limiter` key is a deprecated alias                             |
| `braid.contrib.networkMonitor: { client, outageThreshold, ... }` | client `v2raytun`, threshold `3` | Tunnel watch and reconnect; the watcher toggles only after `outageThreshold` consecutive failed probes                  |
| `braid.contrib.networkMonitor.autoReconnect`                     | `true`                           | `false` refuses `tunnel_reconnect` unless `force: true`, and stops watcher reconnects                                   |
| `braid.contrib.networkMonitor.client`                            | `v2raytun`                       | Which tunnel client to probe and toggle (`v2raytun`, `happ`, `incy`); re-read on each probe, tool call and watcher tick |
| `braid.contrib.<name>: false`                                    | every extension enabled          | Disables one extension; a literal `false`, read at load                                                                 |

## Limits

- No sandbox. Each extension runs with your session's access; `path-security` narrows the blast
  radius of tool calls and warns by default.
- `system-monitor` reads CPU, memory and disk from the OS and shells out to `ps` for per-process
  detail.
- `network-monitor` targets three macOS tunnel clients, picked by the `client` setting: `v2raytun`,
  `happ`, `incy`.
- No skills. The skill catalog ships with `pi-braid`; the on-demand set is the `pi-braid-skills`
  package.

## License

[MIT](LICENSE)
