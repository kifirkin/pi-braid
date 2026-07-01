<!-- status: current -->

# src/lib/utils/ - Utility Functions

Misc utilities that don't fit a more specific subdir.

## Files

| File | Purpose |
|---|---|
| `injection-tracker.ts` | Tracks all messages injected into the agent's context. Provides the chokepoint `sendTrackedMessage` for whisper cap and metadata. |
| `whisper-format.ts` | Universal whisper envelope (`[braid-whisper - <subsystem>]`). Applied at the trunk by `sendTrackedMessage` so every system-injected message is clearly distinguished from human user input. See `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` §7.16. |
| `extension-utils.ts` | Helpers for working with the ExtensionContext. |
| `file-mutation-queue.ts` | Serializes file mutations to prevent races. |
| `filter-safe-to-remove.ts` | Determines which messages can be safely removed from context (compaction). |
| `sop-extractor.ts` | Extracts Standard Operating Procedures from agent behavior. |
| `sop-suggestion.ts` | Suggests SOPs based on repeated patterns. |
| `error-guard.ts` | Wraps handler errors with logging and recovery. |
| `async-fs.ts` | Async filesystem primitives (`asyncExists`). Replaces duplicate `existsSync` checks. |

## Local Contracts

- **`injection-tracker.ts` is the canonical chokepoint for sending messages to the agent.** Don't use `pi.sendMessage` directly - use `sendTrackedMessage` so whispers get capped and tracked. The universal envelope is applied here automatically.
- **`whisper-format.ts` is the source of truth for the envelope format.** Don't add inline prefixes like `[enforcement] ${message}` in handlers - the trunk handles the universal envelope, and any body-level sub-tags should be added inside the message body (e.g. `[dream] ...`) as a second filter level.
- See `extensions/enforcement/whisper.ts` for the pattern.
