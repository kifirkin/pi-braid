# src/lib/utils/ - Utility Functions

Misc utilities that don't fit a more specific subdir.

## Files

| File | Purpose |
|---|---|
| `injection-tracker.ts` | Tracks all messages injected into the agent's context. Provides the chokepoint `sendTrackedMessage` for whisper cap and metadata. |
| `extension-utils.ts` | Helpers for working with the ExtensionContext. |
| `file-mutation-queue.ts` | Serializes file mutations to prevent races. |
| `filter-safe-to-remove.ts` | Determines which messages can be safely removed from context (compaction). |
| `sop-extractor.ts` | Extracts Standard Operating Procedures from agent behavior. |
| `sop-suggestion.ts` | Suggests SOPs based on repeated patterns. |
| `error-guard.ts` | Wraps handler errors with logging and recovery. |

## Local Contracts

- **`injection-tracker.ts` is the canonical chokepoint for sending messages to the agent.** Don't use `pi.sendMessage` directly - use `sendTrackedMessage` so whispers get capped and tracked.
- See `extensions/enforcement/whisper.ts` for the pattern.
