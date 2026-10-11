---
name: pi-reference
description: "Use when asking about pi capabilities, configuration, customization, or extending pi. Covers SDK, extensions, skills, themes, TUI, keybindings, models, providers, prompts, RPC mode, session management, settings, CLI, and internal architecture. Also use when creating custom tools or building self-improving extensions."
validated: 2026-10-08
verdict: KEEP
---

## trigger: "pi capabilities, configuration, customization, extending pi, SDK usage, extension development, themes, keybindings, models, providers, prompts, RPC mode, session management, settings, CLI"

# Pi Reference

Complete reference for pi's architecture, configuration, and internals.

---

## How to Find Docs

1. Resolve the pi package root. In braid sessions `system_info` reports it as `Core`; in bare pi the system prompt's `docs` section names the README, docs, and examples paths.
2. Docs are under `<root>/docs/`; the docs index (`index.md`) is the entry point.
3. Read the doc completely, follow cross-references.
4. Examples are under `<root>/examples/` (extensions, plugins, SDK).
5. Package overview: `<root>/README.md`.

Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details).

## Documentation Index (relative to `<root>/docs/` or `<root>/`)

| Topic              | Path                                         |
| ------------------ | -------------------------------------------- |
| Extensions         | `docs/extensions.md`, `examples/extensions/` |
| Themes             | `docs/themes.md`                             |
| Skills             | `docs/skills.md`                             |
| Prompt Templates   | `docs/prompt-templates.md`                   |
| TUI Components     | `docs/tui.md`                                |
| Keybindings        | `docs/keybindings.md`                        |
| SDK                | `docs/sdk.md`                                |
| Custom Providers   | `docs/custom-provider.md`                    |
| Adding Models      | `docs/models.md`                             |
| Package Overview   | `docs/packages.md`                           |
| RPC Mode           | `docs/rpc.md`                                |
| Session Management | `docs/sessions.md`                           |
| Settings           | `docs/settings.md`                           |
| Compaction         | `docs/compaction.md`                         |

The same tree carries the reference set (`cli.md`, `slash-commands.md`, `configuration.md`, `environment-variables.md`, `providers.md`, `security.md`, `mcp.md`, `codemode.md`, `session-format.md`, `json.md`, `message-types.md`, `virtual-models.md`, `rpc-commands.md`, `rpc-extension-ui.md`) plus the quickstart and platform guides; `ls <root>/docs/` is the full list.

## Directory Structure

```
~/.pi/                        # pi home
└── agent/                    # agent directory (override: PI_CODING_AGENT_DIR)
    ├── settings.json         # user settings: preferences, defaults, resource paths, package declarations
    ├── auth.json             # API keys and OAuth credentials
    ├── keybindings.json      # custom keybindings
    ├── mcp.json              # MCP servers available in every project
    ├── models.json           # compatible endpoints, models, and model overrides
    ├── AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md  # user instructions; system-prompt replace/append
    ├── extensions/           # user extensions
    ├── skills/               # user skills
    ├── prompts/              # user prompt templates (slash commands)
    ├── themes/               # user themes
    ├── sessions/             # session JSONL files, grouped by working directory
    ├── trust.json            # saved project trust decisions
    ├── npm/                  # npm-sourced package installs
    └── git/                  # git-sourced package checkouts
```

## Key Paths

| Path                        | Purpose                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/settings.json` | user settings: preferences, defaults, resource paths, package declarations                                     |
| `~/.pi/agent/auth.json`     | API keys and OAuth credentials                                                                                 |
| `~/.pi/agent/sessions/`     | session JSONL files, grouped by working directory (`--session-dir` and `PI_CODING_AGENT_SESSION_DIR` override) |
| `~/.pi/agent/skills/`       | user skills (SKILL.md files)                                                                                   |
| `~/.pi/agent/trust.json`    | saved project trust decisions                                                                                  |
| `<cwd>/.pi/settings.json`   | project settings; loads after project trust is granted (project settings override agent-directory settings)    |

## Environment Variables

| Variable                      | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `PI_CODING_AGENT_DIR`         | override the agent directory (default `~/.pi/agent`)                                   |
| `PI_CODING_AGENT_SESSION_DIR` | override session storage; overridden by `--session-dir`                                |
| `PI_PACKAGE_DIR`              | override the package directory (Nix/Guix store paths)                                  |
| `PI_OFFLINE`                  | disable automatic network activity, including model catalog refreshes                  |
| `PI_SKIP_VERSION_CHECK`       | disable the latest-version request                                                     |
| `PI_CACHE_RETENTION`          | `long` enables extended provider prompt caching where supported                        |
| `PI_SESSION_ID`               | current session ID, in `bash` and `powershell` tool commands                           |
| `PI_SESSION_FILE`             | absolute path to the session JSONL, in tool commands (unset for ephemeral sessions)    |
| `PI_PROVIDER`, `PI_MODEL`     | selected provider and model, in tool commands                                          |
| `PI_REASONING_LEVEL`          | effective reasoning level, in tool commands                                            |
| `AI_AGENT`, `PI_CODING_AGENT` | process markers the CLI and RPC entry points set for child processes (`pi` and `true`) |

The full table, including telemetry, terminal, and proxy variables, is `environment-variables.md` under the docs root above; provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration) are documented in `providers.md`.

---

## Process

1. Read the relevant doc completely before implementing.
2. Follow cross-references to related docs.
3. Resolve `docs/...` and `examples/...` against the pi root, not the working directory.
4. Use the `examples/` directory for working code.
