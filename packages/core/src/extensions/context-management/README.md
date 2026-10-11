<!-- status: current -->

# Context Management Extension

Narrows the active tool set to a curated profile on request, using `pi.setActiveTools()`.

## Problem

The core package alone documents 33 tools in [TOOLS.md](../../../TOOLS.md); a
full install adds the contrib and third-party families on top. Most sessions
use only a subset. Displaying every registered tool in the system prompt wastes
tokens and increases cognitive load on the model.

## Solution

A **tool profile** is a curated subset of the registered tools, optimized for a
specific task category. A session asks for one with the `set_tool_profile`
tool, and the chosen profile is re-asserted before a run if the active set
drifted from it.

## Profiles

| Profile     | Tools                                                                                                                          | Use case                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `lean`      | read, edit, write, bash, grep, find, ls, think, verify, finalize, scratchpad, memory                                           | General-purpose coding & reasoning   |
| `research`  | read, fetch_content, grep, find, ls, bash, think, memory, scratchpad, verify                                                   | Information gathering, web search    |
| `debugging` | read, edit, write, bash, grep, find, ls, think, hypothesize, explore_paths, verify, conflict_qa                                | Bug finding and fixing               |
| `browser`   | browser_navigate, browser_snapshot, browser_eval, browser_screenshot, read, bash, think, describe_image, fetch_content, verify | Web browsing, UI testing             |
| `deep`      | read, edit, write, bash, grep, find, ls, think, verify, codebase, file_diff, scratchpad                                        | Deep code analysis, dependency graph |

## How It Works

1. A session is born with pi-core's default tool selection plus every tool
   the extensions register. This extension never narrows the set on its own;
   see "Why there is no default profile".
2. `set_tool_profile` applies a profile through `pi.setActiveTools()`. The
   chosen profile is then re-asserted before each run when the active set has
   drifted from it, which pi-core's runtime build, `/reload` and sibling
   extensions all cause by re-activating every registered tool. Nothing is
   re-asserted while no profile was chosen.
3. Tools outside the profile are still registered in pi-core but hidden from
   the agent's system prompt (no tool descriptions, no parameter schemas).
4. The system prompt is rebuilt automatically after each profile switch.
5. An explicit tool list saved by `/tools` (`braid.contrib._global.enabled`)
   outranks the re-assertion: the operator configured that set by hand, so
   background restoration yields to it. A live `set_tool_profile` call still
   applies, because the agent is the one asking.

## Why there is no default profile

A profile applied at session start is a guess at what the session was started
to do, and a wrong guess is a silent loss: the list hides every tool family it
omits. A dispatch session that comes up on `lean` cannot open the Telegram
poller, cannot see or dispatch a worker, and cannot set a timer, so it cannot
follow its own boot contract, and nothing in its tool list says why.

Nothing readable at session start separates the sessions a narrowing suits from
the ones it breaks. The registry, the installed packages and the agent-directory
settings are the same for both, and a role name is the dispatcher's vocabulary,
not the extension's. Narrowing is therefore a request rather than a default,
made by the layer that knows the session's role: `set_tool_profile` from the
session itself, or pi's own `--tools` allowlist from the process that launched
it.

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
- **`set_tool_profile` is in every profile** (see the `PROFILES` table in
  `index.ts`), so a profile switch can never lock the agent out of switching
  to another profile. It stays registered whether or not it is active.
- **Narrowing is never automatic.** The extension asserts only a profile the
  session asked for; with none asked for, the active set belongs to pi-core,
  to the operator's saved list, and to the sibling extensions.
