# lib/session-manager.ts

**Purpose**: Session management — handles session persistence, rotation, and lifecycle. Coordinates with the `context-manager` extension for compaction and branch management.

## Key Functions

| Function                            | Description                         |
| ----------------------------------- | ----------------------------------- |
| `storeSession(session)`             | Persist session to disk             |
| `loadSession(id)`                   | Load session from disk              |
| `rotateSession(oldSession, reason)` | Archive old session, create new one |
| `listSessions()`                    | List all available sessions         |

## Key Patterns

- **File-based storage**: Sessions are JSON files in `~/.pi/sessions/`. Each session has a unique ID (timestamp + random).
- **Rotation triggers**: Compaction failures, explicit shutdown, and emergency threshold (75% context usage).
- **Branch tracking**: When rotating, the old session becomes the parent of the new one — enables tree navigation via `context_checkout`.
