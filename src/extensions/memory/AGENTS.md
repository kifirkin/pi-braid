# Memory Module

Context lifecycle, three-memory-stores, memory-agent-bridge, session-recall.

## Compaction paths and resume-timer hygiene

The module schedules "resume" timers on three code paths, all of which use a 3-minute delay. **All three paths must cancel stale resume tags before scheduling** to prevent misplaced `[timer]` whispers on later TURN_END events.

| Path | File | Tag |
|---|---|---|
| Manual `context_compress` tool | `context-manager/handlers/tools/context-compress.ts` | `compaction-resume` |
| Auto-compact escalation | `context-lifecycle/index.ts` | `auto-compaction-resume` |
| Cleanup on `session_compact` | `enforcement/handlers/register-session-compact.ts` | both (orphan cleanup) |

The `cancelTimersByTag` helper from `extensions/tools/timer/index.ts` is the shared API. The enforcement `session_compact` handler cancels both tags as a safety net (in case a previous compaction was interrupted before its tool-side cancellation ran).

## Re-entrancy safety

Both `context-lifecycle/index.ts` (line 56) and `lib/utils/injection-tracker.ts` (line 47) maintain re-entrancy guards for `before_agent_start` and `sendTrackedMessage` respectively. The latter uses `MAX_REENTRY_DEPTH = 1` — only 1 synchronous `pi.sendMessage` call is allowed before deferring to `queueMicrotask`. This is the safe floor for the runtime's re-entry depth (which the counter cannot see, since each extension's before_agent_start hook re-enters independently).
