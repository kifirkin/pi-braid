---
name: pi-reference
description: "Use when asking about pi capabilities, configuration, customization, or extending pi. Covers SDK, extensions, skills, themes, TUI, keybindings, models, providers, prompts, RPC mode, session management, settings, CLI, and internal architecture. Also use when creating custom tools or building self-improving extensions."
---

# Pi Reference

Complete reference for pi's architecture, configuration, and internals.

---

## How to Find Docs

1. Check the root path at top of prompt (after ## System State)
2. Docs are under: `<root>/docs/*.md`
3. Read the doc completely, follow cross-references
4. Examples are under: `<root>/examples/` (extensions, custom tools, SDK)
5. Main documentation is at: `<root>/README.md`

Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details).

## Documentation Index (relative to `<root>/docs/` or `<root>/`)

| Topic              | Path                                        |
| ------------------ | ------------------------------------------- |
| Extensions         | `docs/extensions.md`, `examples/extensions/`|
| Themes             | `docs/themes.md`                            |
| Skills             | `docs/skills.md`                            |
| Prompt Templates   | `docs/prompt-templates.md`                  |
| TUI Components     | `docs/tui.md`                               |
| Keybindings        | `docs/keybindings.md`                       |
| SDK                | `docs/sdk.md`                               |
| Custom Providers   | `docs/custom-provider.md`                   |
| Adding Models      | `docs/models.md`                            |
| Package Overview   | `docs/packages.md`                          |
| RPC Mode           | `docs/rpc.md`                               |
| Session Management | `docs/sessions.md`                          |
| Settings           | `docs/settings.md`                          |
| Compaction         | `docs/compaction.md`                        |

## Directory Structure

```
~/.pi/                        # Agent home directory
├── agent/
│   ├── settings.json         # Global settings (model, provider, api keys)
│   ├── auth.json             # API keys and OAuth tokens
│   ├── extensions/           # Installed extensions (symlinked or copied)
│   ├── skills/               # User-installed skills
│   ├── sessions/             # Session JSONL files (by project dir)
│   ├── braid/                # Braid-specific data (memory, etc.)
│   ├── git/                  # Git integration data
│   ├── trust.json            # Project trust decisions
│   └── npm/                  # NPM-related data
├── screenshots/              # Terminal screenshots
└── test-logs-br3/            # Test logs (if applicable)
```

## Key Paths

| Path                        | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `~/.pi/agent/settings.json` | Global settings (model, provider, api keys)|
| `~/.pi/agent/auth.json`     | API keys and OAuth credentials            |
| `~/.pi/agent/sessions/`     | Session JSONL files, organized by project  |
| `~/.pi/agent/skills/`       | User-installed skills (SKILL.md files)     |
| `<cwd>/.pi/settings.json`   | Project-local settings (overrides global) |

## Environment Variables

| Variable              | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `PI_CODING_AGENT_DIR` | Override agent directory (default: `~/.pi/agent`) |

---

## Process

1. Read the relevant doc completely before implementing
2. Follow cross-references to related docs
3. Use `examples/` directory for working code
