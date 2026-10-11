<!-- status: current -->

# Examples

Copy-ready configuration for pi-braid. Every key and variable in these files is verified against the source; nothing speculative. The full reference with defaults is [`packages/core/docs/SETUP.md`](../packages/core/docs/SETUP.md) § Configuration reference.

| File                                                           | Purpose                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`full-config.settings.json`](full-config.settings.json)       | The complete `braid.*` settings surface for `~/.pi/agent/settings.json` - module toggles, nudges, memory write gate, context window and offloads, timer wake retry, Telegram caps, contrib extensions. Copy the keys you need; most users need a fraction of it. |
| [`.env.example`](.env.example)                                 | Environment variables: Venice provider keys with the key ring, Telegram channel credentials, the loader's `BRAID_MODULES` override.                                                                                                                              |
| [`session-profiles.config.json`](session-profiles.config.json) | Cwd-routed session profiles for `~/.pi/agent/braid/config.json`: per-directory profile names and one-shot first-turn hints.                                                                                                                                      |
| [`minimal-extension/`](minimal-extension)                      | Smallest possible pi extension - one `hello` tool, mirroring the shape of a braid contrib module.                                                                                                                                                                |

## Where each file goes

- `full-config.settings.json` → `~/.pi/agent/settings.json` (user-global) or `<project>/.pi/settings.json` (project-scoped, wins on collision). It is a **full-surface** example, not a recommended config.
- `.env.example` → export the lines you need in your shell profile or a `.env` you source. Never commit real keys.
- `session-profiles.config.json` → `~/.pi/agent/braid/config.json`. First matching entry wins; a match is the profile `cwd` itself or any directory under it; `~` expands against your home.

## Notes

- `braid.contrib.<name>: false` disables an extension only when contrib is loaded through its bundle entry (`packages/contrib/index.ts`). When you register `packages/contrib` as a package, pi loads all 12 extensions directly; the per-extension behavior blocks (`networkMonitor`, `pathSecurity`, `observatory`, `rate-limiter`, `browserAdvanced`) apply in both paths.
- The rate limiter's limits block reads the hyphenated key `braid.contrib["rate-limiter"]`; the bundle toggle name for the extension itself is `rateLimiter`.
- Provider keys and bot tokens live in the environment, never in settings.json.
