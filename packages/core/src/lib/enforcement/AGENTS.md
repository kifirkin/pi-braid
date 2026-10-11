<!-- status: current -->

# src/lib/enforcement/ - Cross-Extension Enforcement

Utilities used by the enforcement extension and by other extensions that
need to participate in the enforcement layer (whisper cap, turn dedup).

## Files

| File                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn-dedup.ts`      | The whisper flood cap. Tracks per-turn whisper counts by priority tier (critical/high/medium/low) and source. Wired into `sendTrackedMessage` as a chokepoint so every extension benefits.                                                                                                                                                                                                                                                                |
| `adherence-meter.ts` | The read-side adherence meter. Counts durable `braid_injection` entries per rule (deliveries, repeats, suppressions) from the active branch, defines the hold verdict (`repeats < K`), plans the bounded owner escalation (milestone ladder + per-session budget), and builds/writes the owner report under `~/.pi/agent/braid/adherence/`. Rule identity is data (`source` + normalized body), never a hardcoded rule name; owner-facing only, no judge. |

## Local Contracts

- `tryWhisper(priority, source)` returns true if the whisper is allowed, false if suppressed.
- Per-turn counters reset on `beginTurn()`. Hook from the harness's `turn_start` event.
- `reprimeBodyKey` (in `lib/utils/injection-tracker.ts`) is the single definition of "the same body" for repeat suppression and for the adherence meter's rule-signal identity.
- See `extensions/enforcement/handlers/` for the enforcement-extension-specific handlers.
