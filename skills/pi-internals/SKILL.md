---
name: pi-internals
description: Use this skill when the user asks about pi's internal structure, where it stores settings, sessions, or anything about the ~/.pi directory.
---

# Pi Internals

Use this skill when the user asks about pi's internal structure, configuration storage, or the `~/.pi` directory.

## Directory Structure

```
~/.pi/
├── agent/                    # Agent configuration and runtime data
│   ├── settings.json         # Global settings (can be overridden per-project)
│   ├── auth.json              # API keys and OAuth tokens
│   ├── models.json            # Custom model definitions
│   ├── AGENTS.md             # User-level agent instructions
│   ├── agents/               # Custom agent definitions
│   ├── extensions/           # Installed extensions
│   ├── skills/               # User-installed skills
│   ├── prompts/              # User prompt templates
│   ├── themes/               # User themes
│   ├── sessions/             # Session history
│   │   └── <encoded-cwd>/    # Per-project sessions (encoded working directory)
│   │       ├── metadata.json
│   │       └── messages/     # Message logs
│   ├── presets.json           # Saved command presets
│   ├── sandbox.json          # Sandbox extension config
│   └── generated-images/     # AI-generated images storage
├── memory/                    # Short-term conversation memory
│   └── memories.json
├── snapshots/                 # Agent state snapshots
├── healthcheck/               # Health check temporary files
└── infinite-loop.lock         # Prevents runaway processes
```

## Key Locations

| Path | Purpose |
|------|---------|
| `~/.pi/agent/settings.json` | Global settings (model, tools, etc.) |
| `~/.pi/agent/auth.json` | API keys and OAuth credentials |
| `~/.pi/agent/sessions/` | Session history by project |
| `~/.pi/agent/extensions/` | Installed extensions |
| `~/.pi/agent/skills/` | Custom skills |
| `~/.pi/memory/` | Conversation memory |
| `~/.pi/snapshots/` | State snapshots |
| `<cwd>/.pi/` | Project-local settings (overrides global) |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Override agent directory (default: `~/.pi/agent`) |
| `PI_SHARE_VIEWER_URL` | Override share viewer URL |

## Project-Local Settings

Settings can be overridden per-project at `<project>/.pi/settings.json`. Project-local settings take precedence over global settings.

## Backing Up Configuration

To backup your pi configuration:
```bash
cp -r ~/.pi ~/pi-backup-$(date +%Y%m%d)
```

Key files to backup:
- `~/.pi/agent/settings.json`
- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/extensions/`
- `~/.pi/agent/skills/`
- `~/.pi/agent/AGENTS.md`
