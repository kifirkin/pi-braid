# Memory Module

Context lifecycle, three-memory-stores, memory-agent-bridge, session-recall.

## Compaction paths and resume-timer hygiene

The module schedules "resume" timers on three code paths, all of which use a 3-minute delay with `wake: true` (auto-resume). **All three paths must cancel stale resume tags before scheduling** to prevent misplaced `[timer]` whispers on later TURN_END events.

| Path | File | Tag |
|---|---|---|
| Manual `context_compress` tool | `context-manager/handlers/tools/context-compress.ts` | `compaction-resume` |
| Auto-compact escalation | `context-lifecycle/index.ts` | `auto-compaction-resume` |
| Cleanup on `session_compact` | `enforcement/handlers/register-session-compact.ts` | both (orphan cleanup) |

The `cancelTimersByTag` helper from `extensions/tools/timer/index.ts` is the shared API. The enforcement `session_compact` handler cancels both tags as a safety net (in case a previous compaction was interrupted before its tool-side cancellation ran).

## Whisper wake-up policy in this module

Whispers from compaction-retry, navigation, and memory hooks use `triggerTurn: true` for messages that demand the agent's action:

- **compaction-retry** (`context-manager/handlers/compaction-retry.ts`): exhausted / context-window / threshold errors all wake the agent. In-progress retry messages (`overflow`, `transient`, `threshold`) stay `triggerTurn: false` because the agent is mid-retry.
- **navigation** (`context-manager/handlers/navigation.ts`): "Context checkout prepared" with a direct action instruction wakes the agent.
- **three-memory-stores** (`memory/three-memory-stores/index.ts`): tool reliability alerts (gap > 0.2) wake the agent so it can switch tools.
- **rotation** (`context-manager/handlers/shared.ts:327`, `rotation.ts:171`): emergency rotation and rotation followUp both wake.

Advisory whispers (memory recall, past insights, hint injection, SOP suggestions) stay `triggerTurn: false` — they provide context for the agent's natural flow.

## Re-entrancy safety

Both `context-lifecycle/index.ts` (line 56) and `lib/utils/injection-tracker.ts` (line 47) maintain re-entrancy guards for `before_agent_start` and `sendTrackedMessage` respectively. The latter uses `MAX_REENTRY_DEPTH = 1` — only 1 synchronous `pi.sendMessage` call is allowed before deferring to `queueMicrotask`. This is the safe floor for the runtime's re-entry depth (which the counter cannot see, since each extension's before_agent_start hook re-enters independently).
