<!-- status: current -->

# src/extensions/memory/workspace-snapshot/ - File State Time-Travel

Captures and restores file states for safe time-travel experimentation. The
agent can snapshot a directory, make changes, and roll back if things go wrong.

## Tool

| Tool | Actions | Purpose |
|---|---|---|
| `workspace_snapshot` | capture, restore, list, diff | Capture file states, restore from snapshot, list captures, diff between captures. |

## Why "memory/" and not "core/" or "tools/"

- It's a state-management tool (saves/restores file states) - fits the memory theme
- It's not infrastructure other extensions depend on - doesn't fit core/
- It's not time-based - doesn't fit scheduling/
- The captures themselves are persistent state - fits the "remembering" theme
