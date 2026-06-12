# src/lib/state/ - State Management

Per-extension state, session state, and global state utilities.

## Files

| File | Purpose |
|---|---|
| `extension-state.ts` | `getExtensionState(ctx, key, factory)` - per-session, per-extension state. The canonical pattern. |
| `global-state.ts` | Process-global state (use sparingly - only for things that must survive session boundaries). |
| `session-manager.ts` | Wrapper around pi core's session manager. |
| `session-start-queue.ts` | Queues handlers that need to run on `session_start`. |
| `metacognitive-state.ts` | State for the metacognition layer. |
| `state-checkpoint.ts` | Save/restore extension state to disk for crash recovery. |
| `workspace-snapshot.ts` | Snapshot of the workspace (file contents, session position). |
| `async-storage.ts` | Async-local-storage wrapper for context propagation. |

## Local Contracts

- **Per-extension, per-session state: use `getExtensionState(ctx, key, factory)`.**
- Module-level `let` variables leak across sessions - don't use them for stateful data.
- `global-state.ts` is for true cross-session state only (e.g., singleton references).
- See `extensions/tools/timer/index.ts` for an example of using `getExtensionState` correctly.
