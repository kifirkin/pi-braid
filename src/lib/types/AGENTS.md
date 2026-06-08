# src/lib/types/ — Shared Type Definitions

Shared types and result wrappers used across the codebase.

## Files

| File | Purpose |
|---|---|
| `standard-result.ts` | The standard result wrapper for tool execution. All tool `execute` functions should return this shape. |
| `extension-context.d.ts` | Type augmentation for the ExtensionContext from pi core. |

## Local Contracts

- **All tool results should use `StandardResult<T>`.** This is the contract between tool authors and the enforcement layer.
- Don't add types here that are only used by one extension. Put them in the extension's own files.
