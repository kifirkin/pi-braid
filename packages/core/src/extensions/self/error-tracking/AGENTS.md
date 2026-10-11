<!-- status: current -->

# src/extensions/error-tracking/ - Error Log Tool

Auto-catches extension errors and persists them to a JSONL log. Provides
a single LLM-callable tool to query and manage the error history.

## Tool

| Tool    | Actions                         | Purpose                                                                                                           |
| ------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `error` | `list`, `get`, `clear`, `stats` | Single tool with action discriminator. List recent errors, get details by ID, mark as handled, or get statistics. |

## Files

| File       | Purpose                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | The only file. ~307L. Loads errors from disk on session start, subscribes to error events, provides the consolidated `error` tool. |

## Local Contracts

- Module is opt-in (`disabledByDefault: true`).
- Storage: `~/.pi/agent/braid/errors/errors.jsonl` (see `lib/config/braid-paths.ts`).
- Errors are auto-captured from:
  1. `tool_execution_end` events with `isError: true`
  2. `turn_end` events with errored tools
- `error` action=clear marks the error as `handled: true` but doesn't delete it (preserves audit trail).
- Max 100 errors kept (oldest evicted first).

## Related modules

- `lib/utils/error-guard.ts` - wraps handler errors with logging + recovery (for in-process errors).
- `extensions/enforcement/whisper.ts` - whisper cap suppresses noisy errors as whispers.

## Related modules

- `lib/utils/error-guard.ts` - wraps handler errors with logging + recovery (for in-process errors).
- `extensions/enforcement/whisper.ts` - whisper cap suppresses noisy errors as whispers.
