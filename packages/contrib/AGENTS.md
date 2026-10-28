# pi-braid-contrib

Standalone contrib extensions for pi. Each top-level directory is an extension module;
all 12 are listed individually in `package.json` → `pi.extensions` for native pi loading.

**Loading methods:**

- `"packages": ["file:~/pi-braid-contrib"]` - native pi discovery via `pi.extensions` (recommended)
- `"extensions": ["file:~/pi-braid-contrib/index.ts"]` - convenience bundle with `braid.contrib.*` toggles
- `"extensions": ["file:~/pi-braid-contrib/repl/index.ts", ...]` - individual extension loading

> **User-facing docs** - installation, configuration examples, and extension reference
> are in [`README.md`](README.md). This file is for contributors.

## Local contracts

- **Standalone deps:** this package lists its own runtime deps in `package.json`, but it has no `node_modules` of its own at install time. Resolved deps come from the parent `pi-braid` workspace via the `node_modules/` symlinks in this dir.
- **`@earendil-works/*` packages:** resolved by `jiti` (pi's extension loader) via the global install's node_modules.
- **Other deps:** resolved via the symlinks in `contrib/node_modules/`. Add a new dep by symlinking from `../pi-braid/node_modules/<pkg>`.
- **Silent imports are forbidden:** never wrap a require/import in `try {} catch {}` that swallows a missing-module error. A tool that registers but always throws is worse than a tool that doesn't register - agents will trust the docstring and waste rounds hitting the broken path.

## Modules

| Path                                                                  | Purpose                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/`                                                            | headless browser automation; **split into core (4 tools, always) + advanced (7 tools + 1 command, opt-in via `braid.contrib.browserAdvanced`)** |
| `codebase/`                                                           | consolidated repo explorer: tree + dependency graph + impact analysis                                                                           |
| `diff/`                                                               | file diffing                                                                                                                                    |
| `healthcheck/`                                                        | tool/extension diagnostics                                                                                                                      |
| `observatory/`                                                        | live agent monitor                                                                                                                              |
| `path-security/`                                                      | read-only tool allowlist + write/bash vet                                                                                                       |
| `rate-limiter/`, `repl/`, `sleep/`, `system-monitor/`, `tool-config/` | misc                                                                                                                                            |

## Work guidance

- When adding a new dep, add it to `package.json` AND symlink it from `../pi-braid/node_modules/<pkg>` into `contrib/node_modules/<pkg>`.
- Tool `content` arrays are what the model sees. Keep large payloads (base64 images, raw file contents) out of `content` and in `details` instead - `details` is session metadata, not conversation history.
- The `details` field is the right place for: file paths, base64 previews for TUI rendering, classification metadata, the model id a vision call used, error context.

## Verification

- `npx tsx --check <file>` for syntax (run from `pi-braid/`).
- `node -e "require('<pkg>')"` from a subdir to confirm resolution.

## Code layout notes

- **Settings helper:** `packages/core/src/lib/config/per-tool-settings.ts` reads/writes `~/.pi/agent/settings.json` under the `braid.contrib.*` namespace. New extensions that need per-extension config should use this helper rather than rolling their own file IO.
- **Path constants:** `state-paths.ts` is this package's own mirror of core's `braidDir()` and roots every contrib-owned state dir under the braid home (`BRAID_HOME` relocates the whole tree): observatory sessions, browser screenshots and scratch profile, the network-monitor reconnect lock. The healthcheck report dir and the filesystem probes beside it come from core's `healthcheckDir()` accessor (exported through `pi-braid/lib`), which resolves the same live root on every call. User-wide config is in `~/.pi/agent/settings.json` (use the core helper).

## Per-extension settings reference

Read from `~/.pi/agent/settings.json` under `braid.contrib.<name>`. Each module
reads its own key; the table below notes whether a value is load-time or re-read
at use time. The extension toggle behaves the same under native package
loading and through the bundle.

**Native pi way** (recommended): use pi's package filtering in settings.json to select
which extensions to load from `pi.extensions` (all 12 listed individually in
`package.json`). See [`README.md`](README.md#native-pi-load-via-packages-recommended).

**Convenience bundle**: load `index.ts` via `extensions` array and use
`braid.contrib.<name>` toggles. See [`README.md`](README.md#convenience-bundle-braidcontrib-toggles).

| Setting                                                                                    | Default             | Effect                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braid.contrib.browserAdvanced: true`                                                      | `false`             | Enables 7 advanced browser tools (cookies, content, `tabs_*`) and 1 command (`/browser-tabs`). Core (navigate, snapshot, eval, screenshot) is always loaded when browser is enabled. Image pipeline + element-picker removed as excessive bloat. Read at extension load; restart after changing.                                                         |
| `braid.contrib.pathSecurity: { block: true }`                                              | `false` (soft-warn) | Hard-blocks dangerous bash/write operations. Default: whisper a warning and allow. Read at extension load; restart after changing.                                                                                                                                                                                                                       |
| `braid.contrib.observatory: { record: true }`                                              | `false`             | Writes session lifecycle events to `<braidDir>/observatory/sessions/*.jsonl` (`~/.pi/agent/braid` by default). Read at extension load; restart after changing.                                                                                                                                                                                           |
| `braid.contrib.rateLimiter: { rpm, tpm, providers: {...} }` (`rate-limiter` is deprecated) | built-in defaults   | Per-provider RPM/TPM limits. Falls back to built-in defaults for anthropic/openai/google/groq, then global `rpm`/`tpm`, then hardcoded (30/500K). Also controls the 15s max-wait ceiling. Read at extension load; restart after changing.                                                                                                                |
| `braid.contrib.networkMonitor: { client, outageThreshold, ... }`                           | built-in defaults   | Tunnel watch/reconnect. The watcher probes the selected client (`client: v2raytun \| happ \| incy`) and toggles only after `outageThreshold` consecutive failed probes (default 3); the toggle mechanism comes from the client adapter (app deep links, or the NE profile via `scutil --nc stop\|start`). Settings are re-read while the extension runs. |
| `braid.contrib.<name>: false`                                                              | `true`              | Disable the whole extension: its tools, commands and hooks are not registered. Only a literal `false` disables; an absent key, `true` or a config object leaves it enabled. Read when the extension loads - restart the agent after changing it.                                                                                                         |
| `braid.contrib._global.enabled: ["t1", "t2"]`                                              | (none)              | Per-tool enable list used by the `/tools` TUI. Tools not in the list are disabled at runtime via `pi.setActiveTools()`.                                                                                                                                                                                                                                  |
