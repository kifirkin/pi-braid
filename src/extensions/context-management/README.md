<!-- status: current -->

# Context Management Extension

Reduces the active tool set from ~45 to ~10 by default using
`pi.setActiveTools()`, with context-appropriate profiles.

## Problem

The agent has ~45 tools available (22 from braid extensions + ~12 from pi-core
built-ins + additional browser/system tools). Most sessions use only a subset.
Displaying all 45 tools in the system prompt wastes tokens and increases
cognitive load on the model.

## Solution

A **tool profile** is a curated set of ~10 tools optimized for a specific task
category. The extension applies the default profile on load and provides a
`set_tool_profile` tool to switch at runtime.

## Profiles

| Profile | Tools | Use case |
|---------|-------|----------|
| `lean` | read, edit, write, bash, grep, find, ls, think, verify, finalize, scratchpad, memory | General-purpose coding & reasoning (default) |
| `research` | read, web_fetch, batch_web_fetch, grep, find, ls, bash, think, memory, scratchpad, verify | Information gathering, web search |
| `debugging` | read, edit, write, bash, grep, find, ls, think, hypothesize, explore_paths, verify, conflict_qa | Bug finding and fixing |
| `browser` | browser_navigate, browser_snapshot, browser_eval, browser_screenshot, read, bash, think, analyze_image, web_fetch, verify | Web browsing, UI testing |
| `deep` | read, edit, write, bash, grep, find, ls, think, verify, codebase, file_diff, scratchpad | Deep code analysis, dependency graph |

## How It Works

1. On extension load, `pi.setActiveTools()` is called with the `lean` profile.
2. Tools outside the profile are still registered in pi-core but hidden from
   the agent's system prompt (no tool descriptions, no parameter schemas).
3. The agent can call `set_tool_profile` at any time to switch profiles.
4. The system prompt is rebuilt automatically after each profile switch.

## Usage

```bash
# Agent call (not a CLI command):
set_tool_profile profile=research
```

## Adding a Profile

Edit `PROFILES` in `index.ts`:

```typescript
const PROFILES: Record<string, string[]> = {
  my_profile: [
    "read",
    "edit",
    "write",
    "bash",
    "think",
    "verify",
    // ...
  ],
};
```

The profile name is automatically added to the `set_tool_profile` parameter
schema via the `PROFILE_NAMES` array.

## Design Decisions

- **Profiles are flat tool lists**, not additive layers. A profile replaces
  the active set entirely. This keeps the token count predictable.
- **The default profile is `lean`**, not "all". Every session starts with
  the reduced tool set. The agent can expand as needed.
- **The `set_tool_profile` tool is always available** (it's in every profile).
  Wait — it's not in any profile by design. The agent discovers it via the
  extension loading, and it's always registered. Once active, it stays in
  the registry even if not in the current profile. The agent can call it
  as long as the extension is loaded.