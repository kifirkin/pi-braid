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

## State Policy (which file to use for what)

| Need to store | Use | Why |
|---|---|---|
| Per-session data for one extension | `getExtensionState(ctx, "key", factory)` | Session-scoped; resets on session_start. |
| Cross-extension configuration (e.g., custom model keys from /commands) | `global-state.ts` (`getCustomModelKey`, etc.) | Process-lifetime; one map shared across all sessions. |
| Per-session data spanning many extensions (e.g., recent errors) | `getExtensionState` with a shared key | Scoped to the session. |
| Singleton class instances used by multiple extensions | `global-state.ts` (one per singleton) | Process-lifetime is correct. |
| Caches that span session boundaries (e.g., resolved model specs) | `global-state.ts` with explicit cache invalidation | Reusing across sessions is the goal. |
| Scratchpad / plan / current goal | `getExtensionState(ctx, "scratchpad", factory)` | Per-session. |
| Cached LLM responses | `global-state.ts` keyed by input hash, with TTL | Reuse across sessions. |

## Local Contracts

- **Per-extension, per-session state: use `getExtensionState(ctx, key, factory)`.**
- Module-level `let` variables leak across sessions - don't use them for stateful data.
- `global-state.ts` is for true cross-session state only (e.g., singleton references).
- See `extensions/scheduling/timer/index.ts` for an example of using `getExtensionState` correctly.

## Migration target: remove all module-level `let` state in extensions/

Audit: see `docs/CODE-QUALITY-REMEDIATION-PLAN.md` TASK-2.1 for the
list of remaining violations. The pattern is: find a `let foo` at
module scope, replace with `const foo = getExtensionState(ctx, "key", factory)`,
and pass `foo` through the call chain. Helpers in `extension-state.ts`
(`getSessionIdSafe`, `getLeafIdSafe`) make the session-key derivation
clean.
