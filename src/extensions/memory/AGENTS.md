# Memory Module

Context lifecycle, three-memory-stores, memory-agent-bridge, session-recall.

## Compaction paths and resume-timer hygiene

The module schedules "resume" timers on three code paths, all of which use a 3-minute delay with `wake: true` (auto-resume). **All paths must cancel stale resume tags to prevent misplaced `[timer]` whispers on later TURN_END events.**

| Path | File | Tag | Schedules timer? |
|---|---|---|---|
| Manual `context_compress` tool | `context-manager/handlers/tools/context-compress.ts` | `compaction-resume` | NO (cancel only) |
| Auto-compact escalation | `context-lifecycle/index.ts` | `auto-compaction-resume` | NO (cancel only) |
| `session_compact` enforcement handler | `enforcement/handlers/register-session-compact.ts` | both | **YES (after cancel)** |

**Critical design point**: the resume timer is scheduled ONLY in the `session_compact` handler, NOT in the tool or auto-compact path. Earlier designs scheduled the timer in the tool/auto-compact scope, but the `session_compact` handler (which fires shortly after) cancelled the same tag - so the timer was created and immediately destroyed, never firing. The agent never woke up.

The correct sequence is:
1. Tool or auto-compact: cancel stale timers from previous cycles (defensive).
2. Tool or auto-compact: call `ctx.compact(options)` to trigger compaction.
3. `session_compact` event fires (post-compaction).
4. `session_compact` handler: cancel any stale timers (now this is a no-op since step 1 just ran), then schedule a FRESH 3-minute resume timer.
5. After 3 minutes of no agent activity, the timer fires with `wake: true` to auto-resume the agent.

The `cancelTimersByTag` helper from `extensions/tools/timer/index.ts` is the shared API.

## Parallel-tool-call constraint

`context_compress` MUST NOT be called in a parallel batch with other tools. The pi core's `ctx.compact()` aborts the current turn via `_disconnectFromAgent()` + `abort()`, which discards any pending tool results from the same parallel batch. The tool description explicitly warns against this. If the agent must run other tools in parallel with compaction, it should split them across separate turns.

## Whisper wake-up policy in this module

Whispers from compaction-retry, navigation, and memory hooks use `triggerTurn: true` for messages that demand the agent's action:

- **compaction-retry** (`context-manager/handlers/compaction-retry.ts`): exhausted / context-window / threshold errors all wake the agent. In-progress retry messages (`overflow`, `transient`, `threshold`) stay `triggerTurn: false` because the agent is mid-retry.
- **navigation** (`context-manager/handlers/navigation.ts`): "Context checkout prepared" with a direct action instruction wakes the agent.
- **three-memory-stores** (`memory/three-memory-stores/index.ts`): tool reliability alerts (gap > 0.2) wake the agent so it can switch tools.
- **rotation** (`context-manager/handlers/shared.ts:327`, `rotation.ts:171`): emergency rotation and rotation followUp both wake.

Advisory whispers (memory recall, past insights, hint injection, SOP suggestions) stay `triggerTurn: false` - they provide context for the agent's natural flow.

## Re-entrancy safety

Both `context-lifecycle/index.ts` (line 56) and `lib/utils/injection-tracker.ts` (line 47) maintain re-entrancy guards for `before_agent_start` and `sendTrackedMessage` respectively. The latter uses `MAX_REENTRY_DEPTH = 1` - only 1 synchronous `pi.sendMessage` call is allowed before deferring to `queueMicrotask`. This is the safe floor for the runtime's re-entry depth (which the counter cannot see, since each extension's before_agent_start hook re-enters independently).

## Agent-facing tool summary

The memory extensions expose 4 LLM-callable tools. The unified `memory` tool covers the three read-heavy domains (recall/episodes/heuristics) with 9 actions.

| Tool | Extension | Store | When to use |
|---|---|---|---|
| `memory_store` | memory-agent-bridge | semantic (unified) | Save insights/patterns for cross-session recall |
| `memory` | memory-agent-bridge | all three | Unified access: `recall_search` (semantic search, also cross-searches episodes), `recall_list`, `recall_get`, `episodes_search` (case-based reasoning), `episodes_list`, `episodes_add`, `heuristics_list`, `heuristics_add`, `heuristics_evolve` |
| `session` | session-recall | session log | Search past sessions (action=search) or query one (action=query) |

**Rule of thumb:** start with `memory` action=recall_search for "have I seen this before?". Use `memory` action=episodes_search for "how did a similar task go?". Use `memory` action=heuristics_list when investigating behavior tuning. Use `session` for cross-session history.

The data-layer functions (`addEpisode`, `addPrinciple`, `recordToolCall`, etc.) live in `three-memory-stores/episodes.ts`, `heuristics.ts`, `tool-reliability.ts` and are imported by many extensions (e.g. `finalize.ts` adds episodes on task completion). These are infrastructure and should not be moved out of the directory.

