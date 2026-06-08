# src/extensions/error-tracking/ — Error Log Tools

Auto-catches extension errors and persists them to a JSONL log. Provides
LLM-callable tools to query and manage the error history.

## Tools

| Tool | Purpose |
|---|---|
| `error_list` | List recent errors with counts (by type and source). |
| `error_get` | Get full error details by ID. |
| `error_clear` | Clear an error after handling (marks as handled). |
| `error_stats` | Get error statistics grouped by type and source. |

## Files

| File | Purpose |
|---|---|
| `index.ts` | The only file. ~307L. Loads errors from disk on session start, subscribes to error events, provides the four tools. |

## Local Contracts

- Module is opt-in (`disabledByDefault: true`).
- Storage: `~/.pi/agent/braid/errors/errors.jsonl` (see `lib/config/braid-paths.ts`).
- Errors are auto-captured from:
  1. `tool_execution_end` events with `isError: true`
  2. `turn_end` events with errored tools
- `error_clear` marks the error as `handled: true` but doesn't delete it (preserves audit trail).
- Max 100 errors kept (oldest evicted first).

## Related modules

- `lib/utils/error-guard.ts` — wraps handler errors with logging + recovery (for in-process errors).
- `extensions/enforcement/whisper.ts` — whisper cap suppresses noisy errors as whispers.
