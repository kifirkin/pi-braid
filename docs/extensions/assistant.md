# Extension: assistant

**Status**: ✅ Working
**Tests**: None
**Version**: v0.9.x

## Purpose

Interactive tool management — `/tools` command with fuzzy search and scrollable list for enabling/disabling tools. State persisted to disk (`~/.pi/agent/tools-config.json`) so configuration survives pi restarts.

## Architecture

Dual persistence: session entries (for branch navigation) + disk file (for restart survival). On restore, disk file takes priority, session entry is fallback. Version numbers on config entries prevent stale data from being applied.

## Commands

| Command | Description |
|---------|-------------|
| `/tools` | Interactive tool enable/disable with SettingsList UI (fuzzy search, scrollable) |
| `/tool-status` | Show current enabled/disabled tool list |

## Key Patterns

- **SettingsList UI**: Uses `SettingsList` from `@mariozechner/pi-tui` for keyboard-navigable list with built-in search. Each tool is a `SettingItem` with toggle checkbox.
- **Versioned config**: Each `tools-config` entry has a version number. On restore, the highest version wins. Old entries accumulate but are ignored.
- **Disk persistence**: `saveState()`/`loadState()` from `async-storage.ts` to `~/.pi/agent/tools-config.json`.
- **No direct tool registration**: This is a command-only extension. The tools themselves are registered by their respective extensions; this manages which are active.
