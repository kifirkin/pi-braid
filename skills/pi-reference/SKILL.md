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

## Documentation Index (relative to `<root>/docs/`)

| Topic | Path |
|-------|------|
| Extensions | `extensions.md`, `examples/extensions/` |
| Themes | `themes.md` |
| Skills | `skills.md` |
| Prompt Templates | `prompt-templates.md` |
| TUI Components | `tui.md` |
| Keybindings | `keybindings.md` |
| SDK | `sdk.md` |
| Custom Providers | `custom-provider.md` |
| Adding Models | `models.md` |
| Package Overview | `packages.md` |
| RPC Mode | `rpc.md` |
| Session Management | `session.md` |
| Settings | `settings.md` |

## Directory Structure

```
~/.pi/                        # Agent home directory
├── agent/
│   ├── settings.json         # Global settings (overridden per-project)
│   ├── auth.json             # API keys and OAuth tokens
│   ├── extensions/           # Installed extensions
│   └── skills/               # User-installed skills
├── memory/                   # Short-term conversation memory
└── snapshots/                # Agent state snapshots
```

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.pi/agent/settings.json` | Global settings (model, tools, etc.) |
| `~/.pi/agent/auth.json` | API keys and OAuth credentials |
| `<cwd>/.pi/settings.json` | Project-local settings (overrides global) |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Override agent directory (default: `~/.pi/agent`) |

---

## Process

1. Read the relevant doc completely before implementing
2. Follow cross-references to related docs
3. Use `examples/` directory for working code
