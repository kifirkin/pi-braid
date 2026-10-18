<!-- status: current -->

# Memory Module

Context lifecycle, three-memory-stores, memory-agent-bridge, session-recall.

## Compaction fails safe instead of looping

Every compaction failure class ends in a landed entry, or the session is declared
unable to summarize itself and cuts deterministically. Three mechanisms carry that
contract (`context-manager/handlers/`):

- **Ladder integrity** - the retry ladders (`compaction-retry.ts`) walk plain retries,
  then a bounded chunked summarizer, then a no-LLM deterministic cut. The attempt a
  retry spends survives its own dispatch: `RetryState.inFlight` holds it across the
  `turn_end` that pi-core's manual `compact()` causes by aborting the in-flight turn
  first. The exhausted rungs reset the ladder so the ceiling is a sequence boundary,
  not a session sentence.
- **Guard release** - `compactionRetryActive` / `overflowRetryActive` are released by
  the cycle OUTCOME, whichever it is. Releasing them only on success left the first
  failed retry guarding the session forever, and every later dispatch then reset the
  ladder instead of climbing it.
- **No-progress fail-safe** - `COMPACTION_NO_PROGRESS_LIMIT` consecutive cycles that
  land no entry while usage is at or above `USAGE_WHISPER_CRITICAL` arm one
  deterministic cut (`shared.ts` fail-safe state, consumed at the top of
  `session_before_compact`). A cut needs no provider, so it holds for every failure
  class: an aborted cycle carries no error text at all, and a spent-allowance 402 has
  nowhere to rotate because the compaction path selects no model - it uses the session
  model (`ctx.model`) or pi-core's own. An operator slide keeps precedence and leaves
  the cut armed; a dispatched retry owns the next cycle and consumes it there.
  Fixture: `packages/core/test/runtime/memory/test-compaction-failsafe.mjs`.

## Compaction paths and stale-timer cleanup

All three code paths cancel stale compaction-resume timers to prevent misplaced `[timer]` whispers on later TURN_END events. The timer itself was **removed in 2026-07-11** because pi-core's internal `_runAutoCompaction()` continues the agent on its own - but only on `willRetry` (overflow recovery) or when queued messages exist (`agent.hasQueuedMessages()` → `agent.continue()`). That auto-continue does **NOT** cover the manual `ctx.compact()` path that the agent-initiated `context_compress` tool uses: manual compaction calls `_disconnectFromAgent() + abort()` (killing the loop) and never resumes it. For that path the resume is the enforcement `session_compact` re-orientation whisper (`enforcement/handlers/register-session-compact.ts`) gated on `autoResumeAfterCompaction`, delivered with `triggerTurn: true`. The 3-minute fallback timer was removed as spurious noise for the auto path, but the agent-initiated manual path depends on the whisper wake - verified 2026-08-02 after the whisper's `triggerTurn` was found defeated by a `deliverAs: "nextTurn"` default; see `enforcement/whisper.ts`.

Operator-initiated manual compaction (`/compact`, RPC) with a message queued mid-compaction is a **full stop** (verified 2026-09-16): the compaction's queued message is parked via the context-manager pre-append, and the context-manager input-hook hold (`context-manager/handlers/compaction.ts`, armed on `session_compact` with `reason === "manual"`) swallows the TUI flush's replay prompt (`{action: "handled"}`), so no assistant turn starts from pre-compaction input; the operator's next input or a wake (whisper/timer with `triggerTurn: true`) starts the next turn. Auto compactions (`threshold`/`overflow`) keep the flush replay as their resume and are never armed. Fixture: `packages/core/test/runtime/memory/test-manual-compaction-stop.mjs`.

| Path                                  | File                                                 | Cancels tags?           |
| ------------------------------------- | ---------------------------------------------------- | ----------------------- |
| Manual `context_compress` tool        | `context-manager/handlers/tools/context-compress.ts` | YES (defensive cleanup) |
| Auto-compact escalation               | `context-lifecycle/index.ts`                         | YES (defensive cleanup) |
| `session_compact` enforcement handler | `enforcement/handlers/register-session-compact.ts`   | YES (defensive cleanup) |

The `cancelTimersByTag` helper from `extensions/scheduling/timer/index.ts` is the shared API. Cancellation is kept as a safety measure to clean up any timers that were scheduled before the removal.

## Parallel-tool-call constraint

`context_compress` returns its result immediately and defers the actual
`ctx.compact()` to the next safe boundary (batch-settle scheduler in
`context-manager/handlers/tools/context-compress.ts`): the first `turn_end`
whose persisted `toolResults` account for every active tool call, or
`agent_settled`, whichever comes first. Active calls are tracked by
`toolCallId`, registered at `tool_execution_start` and released by its own
`tool_execution_end` or by a boundary event whose `toolResults` carry that
id; `agent_settled` clears whatever is left. The earlier in-flight COUNT was
decremented only by the exact end event it waited for, so one missed
`tool_execution_end` left it positive and every later boundary returned
before the armed compaction could drain; identity cannot drift that way, and
an id with no result stays protective. This removes the old
mid-batch abort race: a still-executing parallel sibling's tool result is
delivered BEFORE the aborting compact fires and is no longer discarded
(pinned by `test/runtime/memory/test-compress-batch-settle.mjs` and
`test/runtime/memory/test-compress-drain-boundaries.mjs`). The
degraded path (batch-settle bookkeeping unavailable) uses a bounded
`DEGRADED_DEFERRAL_MS` (150ms) deferral - never a raw `setTimeout(0)`.

The agent-facing guidance in the tool description still warns against
parallel batches ("Never in a parallel batch (it aborts the turn)"): the
deferred `ctx.compact()` still aborts the run at the settle point, so
compaction remains a turn-boundary action, not a mid-batch one. The
mechanism is loss-preserving; the boundary discipline stands.

## Whisper wake-up policy in this module

Whispers from compaction-retry, navigation, and memory hooks use `triggerTurn: true` for messages that demand the agent's action:

- **compaction-retry** (`context-manager/handlers/compaction-retry.ts`): exhausted / context-window / threshold errors all wake the agent. In-progress retry messages (`overflow`, `transient`, `threshold`, `summary-cap`) park (`delivery: "park"`, no forced continuation turn) because the agent is mid-retry; a summary-cap failure self-recovers on the retry cycle with a bounded chunked summary (compaction-chunked.ts), so only its exhausted path wakes.
- **navigation** (`context-manager/handlers/navigation.ts`): "Context checkout prepared" with a direct action instruction wakes the agent.
- **three-memory-stores** (`memory/three-memory-stores/index.ts`): tool reliability alerts (gap > 0.2) wake the agent so it can switch tools.
- **rotation** (`context-manager/handlers/shared.ts:327`, `rotation.ts`): emergency rotation wakes. The size notice parks while a run is streaming (flushed at the same `turn_end`) and keeps its wake only when the session is idle; a notice still in flight suppresses a second emission through the unresolved-advisory registry in `lib/utils/injection-tracker.ts`.

Advisory whispers (memory recall, past insights, hint injection, SOP suggestions) park (`delivery: "park"`) - they provide context for the agent's natural flow.

## Re-entrancy safety

Both `context-lifecycle/index.ts` (line 56) and `lib/utils/injection-tracker.ts` (line 47) maintain re-entrancy guards for `before_agent_start` and `sendTrackedMessage` respectively. The latter uses `MAX_REENTRY_DEPTH = 1` - only 1 synchronous `pi.sendMessage` call is allowed before deferring to `queueMicrotask`. This is the safe floor for the runtime's re-entry depth (which the counter cannot see, since each extension's before_agent_start hook re-enters independently).

## Agent-facing tool summary

The memory extensions expose 4 LLM-callable tools. The unified `memory` tool covers the three read-heavy domains (recall/episodes/heuristics) with 9 actions.

| Tool           | Extension           | Store              | When to use                                                                                                                                                                                                                                       |
| -------------- | ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_store` | memory-agent-bridge | semantic (unified) | Save insights/patterns for cross-session recall                                                                                                                                                                                                   |
| `memory`       | memory-agent-bridge | all three          | Unified access: `recall_search` (semantic search, also cross-searches episodes), `recall_list`, `recall_get`, `episodes_search` (case-based reasoning), `episodes_list`, `episodes_add`, `heuristics_list`, `heuristics_add`, `heuristics_evolve` |
| `session`      | session-recall      | session log        | Search past sessions (action=search) or query one (action=query)                                                                                                                                                                                  |

**Rule of thumb:** start with `memory` action=recall_search for "have I seen this before?". Use `memory` action=episodes_search for "how did a similar task go?". Use `memory` action=heuristics_list when investigating behavior tuning. Use `session` for cross-session history.

The data-layer functions (`addEpisode`, `addPrinciple`, `recordToolCall`, etc.) live in `three-memory-stores/episodes.ts`, `heuristics.ts`, `tool-reliability.ts` and are imported by many extensions (e.g. `finalize.ts` adds episodes on task completion). These are infrastructure and should not be moved out of the directory.
