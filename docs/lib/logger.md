# lib/logger.ts

**Purpose**: Structured logging with module prefixes and level control. All extensions use this instead of `console.log`.

## Key Functions

| Function               | Description                            |
| ---------------------- | -------------------------------------- |
| `createLogger(module)` | Create a logger with `[module]` prefix |
| `.info(...args)`       | Info-level log                         |
| `.warn(...args)`       | Warning-level log                      |
| `.debug(...args)`      | Debug-level log                        |
| `.error(...args)`      | Error-level log                        |

## Usage

```typescript
const log = createLogger("my-extension");
log.info("Session started");
log.warn("Compaction failed", err);
log.debug("Tool call details:", toolName, duration);
```

## Key Patterns

- **No configuration**: Always on. No log levels to configure — simplicity over flexibility.
- **Prefix formatting**: Output format: `[pi-braid] [module] message` — enables grep filtering.
- **Console sink**: Writes to stdout/stderr. No file logging (extensions that need persistence handle it themselves).
