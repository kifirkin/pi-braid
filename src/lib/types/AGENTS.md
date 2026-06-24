<!-- status: current -->

# src/lib/types/ - Shared Type Definitions

Shared types and result wrappers used across the codebase.

## Files

| File | Purpose |
|---|---|
| `standard-result.ts` | The standard result wrapper for tool execution. All tool `execute` functions should return this shape. |
| `episode-types.ts` | The `Episode` interface shared by three-memory-stores, heartbeat-scheduler, and sop-suggestion. |

> **Note:** `extension-context.d.ts` lives in `src/types/` (a TypeScript
> `typeRoot`), not here. That's where ambient declarations are picked up by
> `tsc` and by the IDE.

## Local Contracts

- **All tool results should use `StandardResult<T>`.** This is the contract between tool authors and the enforcement layer.
- Don't add types here that are only used by one extension. Put them in the extension's own files.
