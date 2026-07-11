/**
 * register-session-compact - Hygiene reset after context compaction.
 *
 * Re-entrancy guard + deferred side-effects (added 2026-06-29, see
 * post-compaction stack overflow trace):
 *   The previous design called `callScratchpadTool` + `sendEnforcementWhisper`
 *   synchronously from the session_compact handler. The scratchpad tool
 *   wrapper in pi-core fires `tool_call` / `tool_execution_end` synchronously,
 *   and the timer extension's `tool_execution_end` handler calls
 *   `fireExpired()` -- which can synchronously invoke `pi.sendMessage` with
 *   `triggerTurn: true` for any timer that expired at that exact moment.
 *   That synchronous chain can re-enter our handler (or other handlers) and
 *   overflow the V8 stack before the existing `MAX_REENTRY_DEPTH = 1` guard
 *   in `injection-tracker.ts` gets a chance to defer the second-level call.
 *
 *   The fix has three layers:
 *   1. Per-session `inHandler` flag (mirrors the `inBeforeAgentStart`
 *      pattern from context-lifecycle) bails early if session_compact
 *      fires twice synchronously.
 *   2. The scratchpad read + whisper delivery side-effects are deferred
 *      via `queueMicrotask` so the handler returns synchronously. The
 *      pi-core event dispatch then completes, microtasks fire on the
 *      next tick, and any pi.sendMessage calls happen on a fresh stack.
 *   3. State writes (lastCompactionTurn, etc.) stay synchronous because
 *      downstream handlers (turn_end, message_end) read them.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, determineContrastMode, SIGNAL_KEYS } from "../signals.js";
import { createLogger } from "../../../lib/core/logger.js";
import { callScratchpadTool, getExtensionState } from "../../../lib/state/extension-state.js";
import * as timerMod from "../../scheduling/timer/index.js";

const log = createLogger("enforcement:session-compact");

export function registerSessionCompactHandler(pi: ExtensionAPI): void {
  onEvent(pi, "session_compact", async (_event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    // ── Re-entrancy guard ────────────────────────────────────────────────
    // Without this guard, a synchronous re-entry into the session_compact
    // handler chain (e.g., from TOOL_EXECUTION_END -> fireExpired -> sendMessage
    // -> before_agent_start -> session_compact) can overflow the stack before
    // MAX_REENTRY_DEPTH in injection-tracker.ts has a chance to defer. See
    // file-level comment for the full failure mode.
    //
    // Per-session flag (mirrors context-lifecycle's `inBeforeAgentStart`).
    // getExtensionState keys on sessionManager.getSessionFile() so a stale
    // `true` from a previous session can't poison the next session's guard.
    const reentrancy = getExtensionState<{ inHandler: boolean }>(
      ctx,
      "enforcement/session-compact-reentrancy",
      () => ({ inHandler: false }),
    );
    if (reentrancy.inHandler) {
      log.warn("Re-entrant session_compact detected - skipping side-effects to prevent stack overflow");
      return;
    }
    reentrancy.inHandler = true;

    try {
      const compactTurn = getState(ctx).currentTurn;

    // Cancel any stale compaction-resume timer from a previous cycle.
    // These timers were scheduled by earlier versions of this handler
    // as a fallback safety net (3-min wake-up after compaction). The
    // timer is now REMOVED because pi-core's agent loop automatically
    // continues after compaction: _runAutoCompaction() returns `true`,
    // which keeps the loop running via agent.continue(). The continuation
    // whisper mechanism ([braid-whisper - enforcement]) properly delivers
    // the next turn. The 3-minute timer was firing as a spurious wake-up
    // that the agent ignored. See the 2026-07-11 removal commit.
    //
    // We still cancel stale timers here to clean up any that were
    // scheduled before this change.
    try {
      const sessionId =
        (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.() ??
        "anonymous";
      const cancelled =
        timerMod.cancelTimersByTag(sessionId, "compaction-resume") +
        timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
      if (cancelled > 0) {
        log.debug(`Cancelled ${cancelled} stale compaction resume timer(s)`);
      }
    } catch {
      // Non-fatal - timer module unavailable
    }

    // ── Sync state writes ──────────────────────────────────────────────
      // These MUST run synchronously because downstream handlers (turn_end,
      // message_end) read them on the same tick. Moving them to the
      // microtask would create a window where they appear stale.
      try {
        getState(ctx).contextNudgeSent = false;
        getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
        getState(ctx).lastCompactionTurn = compactTurn;
        getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
        getState(ctx).overflowRecently = getState(ctx).currentTurn;
        getState(ctx).hasCodeChanges = false;
        getState(ctx).lastCodeChangeTurn = 0;
        getState(ctx).memoryNudgeSent = false;
        getState(ctx).turnsSinceMemory = 0;
      } catch {
        log.debug("session_compact handler: enforcement state access failed (stale ctx?)");
      }

      // ── Deferred side-effects ─────────────────────────────────────────
      // The scratchpad read + whisper delivery must NOT run synchronously
      // from the session_compact handler. Reasons:
      //
      //   1. callScratchpadTool invokes ctx.tools.scratchpad -- pi-core's
      //      wrapper fires `tool_call` / `tool_execution_end` synchronously
      //      around the tool's execute. The timer extension's
      //      tool_execution_end handler calls `fireExpired()`, which can
      //      synchronously invoke pi.sendMessage with triggerTurn: true
      //      for any timer that expired in the same moment.
      //   2. sendEnforcementWhisper synchronously calls pi.sendMessage,
      //      which can synchronously fire before_agent_start.
      //   3. Both of these can re-enter our own handler (or context-
      //      manager's session_compact handler) and overflow the stack
      //      before the existing MAX_REENTRY_DEPTH=1 guard catches it.
      //
      // queueMicrotask defers the side-effects until the current synchronous
      // call stack has unwound. Microtasks run before the next macrotask,
      // so the whispers still arrive before the next turn / event loop
      // iteration -- the agent and user see them with no observable delay.
      // The downside (a single microtask of latency) is acceptable: the
      // user already sees the [compaction] summary from LLM summarization
      // at this point, so a tick-later whisper is not noticeable.
      //
      // CRITICAL: this is fire-and-forget. We do NOT await it from the
      // outer handler because that would push the await back onto the
      // same call stack we're trying to unwind. The errors inside the
      // microtask are logged but not propagated.
      queueMicrotask(() => {
        void (async () => {
          try {
            const scratchpadResult = await callScratchpadTool(ctx, { action: "read" });
            const details = scratchpadResult?.details;
            const learnings = details?.key_learnings ?? [];
            const unpersisted = learnings.filter((l: any) => !l.persisted);

            if (unpersisted.length > 0) {
              sendEnforcementWhisper(
                pi,
                ctx,
                `Context compacted at turn ${compactTurn}. ` +
                  `${unpersisted.length} key learning(s) not yet persisted:\n\n` +
                  unpersisted
                    .map(
                      (l: any) =>
                        `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session"])`,
                    )
                    .join("\n") +
                  `\n\nPersist them now.`,
              );
              enforcementSignals[SIGNAL_KEYS.unpersisted_learnings] = {
                turn: getState(ctx).currentTurn,
                text: `${unpersisted.length} key learning(s) not yet persisted`,
                acted: false,
              };
              eventBus.emit({
                type: "enforcement_signals",
                contrastMode: determineContrastMode(ctx),
              });
            }

            // Always send re-orientation whisper after compaction so the agent
            // knows to recover context from persisted surfaces (scratchpad, task tool).
            // This is the "prompt invariant" in action - the scratchpad survives
            // compaction because it's tool-backed, not conversation-backed.
            sendEnforcementWhisper(
              pi,
              ctx,
              `Context compacted at turn ${compactTurn}. ` +
                `Re-orient: read scratchpad for goal/plan/learnings, then check next pending task. ` +
                `These surfaces survive compaction - continue from there.`,
            );
          } catch (err) {
            log.debug(
              "session_compact handler: deferred side-effects failed (stale ctx?):",
              (err as Error)?.message,
            );
          }
        })();
      });
    } finally {
      reentrancy.inHandler = false;
    }
  });
}
