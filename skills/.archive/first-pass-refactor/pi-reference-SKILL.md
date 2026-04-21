---
name: pi-reference
description: "Use when the user asks about pi itself: its SDK, extensions, themes, skills, TUI, keybindings, configuration, internal structure, ~/.pi directory, or anything about how pi works under the hood."
---

# Pi Reference

Complete reference for pi's architecture, configuration, and internals.

## Documentation Index

| Topic | Location |
|-------|----------|
| Extensions | `docs/extensions.md`, `examples/extensions/` |
| Themes | `docs/themes.md` |
| Skills | `docs/skills.md` |
| Prompt Templates | `docs/prompt-templates.md` |
| TUI Components | `docs/tui.md` |
| Keybindings | `docs/keybindings.md` |
| SDK | `docs/sdk.md` |
| Custom Providers | `docs/custom-provider.md` |
| Adding Models | `docs/models.md` |
| Package Overview | `docs/packages.md` |
| Agent Package | `packages/agent/README.md` |
| AI Package | `packages/ai/README.md` |
| Coding Agent | `packages/coding-agent/README.md` |
| TUI Package | `packages/tui/README.md` |

Process: Read the relevant doc **completely** before implementing. Follow cross-references. Use `examples/` for working code.

## Directory Structure

```
~/.pi/
├── agent/
│   ├── settings.json         # Global settings (overridden per-project)
│   ├── auth.json             # API keys and OAuth tokens
│   ├── models.json           # Custom model definitions
│   ├── AGENTS.md             # User-level agent instructions
│   ├── agents/               # Custom agent definitions
│   ├── extensions/           # Installed extensions
│   ├── skills/               # User-installed skills
│   ├── prompts/              # User prompt templates
│   ├── themes/               # User themes
│   ├── sessions/             # Session history (per-project, encoded cwd)
│   │   └── <encoded-cwd>/
│   │       ├── metadata.json
│   │       └── messages/
│   ├── presets.json           # Saved command presets
│   ├── sandbox.json           # Sandbox extension config
│   └── generated-images/     # AI-generated images
├── memory/                    # Short-term conversation memory
├── snapshots/                 # Agent state snapshots
├── healthcheck/               # Health check temp files
└── infinite-loop.lock         # Prevents runaway processes
```

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.pi/agent/settings.json` | Global settings (model, tools, etc.) |
| `~/.pi/agent/auth.json` | API keys and OAuth credentials |
| `~/.pi/agent/sessions/` | Session history by project |
| `~/.pi/agent/extensions/` | Installed extensions |
| `~/.pi/agent/skills/` | Custom skills |
| `<cwd>/.pi/` | Project-local settings (overrides global) |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Override agent directory (default: `~/.pi/agent`) |
| `PI_SHARE_VIEWER_URL` | Override share viewer URL |

## Project-Local Settings

Settings can be overridden per-project at `<project>/.pi/settings.json`. Project-local settings take precedence over global.

## Backup

```bash
cp -r ~/.pi ~/pi-backup-$(date +%Y%m%d)
```

Key files: `settings.json`, `auth.json`, `models.json`, `extensions/`, `skills/`, `AGENTS.md`
