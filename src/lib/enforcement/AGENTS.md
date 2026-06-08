# src/lib/enforcement/ — Cross-Extension Enforcement

Utilities used by the enforcement extension and by other extensions that
need to participate in the enforcement layer (whisper cap, turn dedup).

## Files

| File | Purpose |
|---|---|
| `turn-dedup.ts` | The whisper flood cap. Tracks per-turn whisper counts by priority tier (critical/high/medium/low) and source. Wired into `sendTrackedMessage` as a chokepoint so every extension benefits. |

## Local Contracts

- `tryWhisper(priority, source)` returns true if the whisper is allowed, false if suppressed.
- Per-turn counters reset on `beginTurn()`. Hook from the harness's `turn_start` event.
- See `extensions/enforcement/handlers/` for the enforcement-extension-specific handlers.
