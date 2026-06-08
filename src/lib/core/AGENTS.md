# src/lib/core/ — Foundation Utilities

Cross-cutting foundation code. Imported by virtually every other module.

## Files

| File | Purpose |
|---|---|
| `logger.ts` | `createLogger(scope)` factory. Use this instead of `console.log` — it adds scope prefix, level filtering, and log file output. |
| `event-names.ts` | Centralized event name constants (e.g., `TOOL_CALL`, `TURN_END`, `SESSION_COMPACT`). Structural test enforces that all event names are declared here. |

## Local Contracts

- **`logger.ts`**: never use `console.log` in extensions. Use `createLogger("scope")`.
- **`event-names.ts`**: every `pi.on("...")` string must be a constant from this file. The structural test in `test/runtime/lib/` enforces this.

## When NOT to add to core

- If it's a data type, put it in `lib/types/`.
- If it's a utility, put it in `lib/utils/`.
- If it's event-bus infrastructure, put it in `lib/events/`.
