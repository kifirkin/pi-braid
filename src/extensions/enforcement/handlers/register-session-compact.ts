/**
 * register-session-compact - Hygiene reset + re-orientation whisper after compaction.
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
 *      via `setTimeout(0)` so the handler returns synchronously. The
 *      pi-core event dispatch then completes, the macrotask fires on
 *      the next event loop turn (stack fully unwound), and any
 *      pi.sendMessage calls happen on a fresh stack.
 *   3. State writes (lastCompactionTurn, etc.) stay synchronous because
 *      downstream handlers (turn_end, message_end) read them.
 *
 * IMPORTANT: session_compact vs compaction_end
 *   Pi-core's session_compact event IS dispatched to extension handlers
 *   (via this._extensionRunner.emit()). The compaction_end event is emitted
 *   via this._emit() which only reaches internal listeners (TUI) — NOT
 *   extension handlers. So the re-orientation whisper MUST be delivered
 *   on session_compact. It fires during compaction (after LLM summarization,
 *   before bookkeeping/TUI rebuild), which is functionally equivalent to
 *   "after compaction completes" for the agent's purposes.
 *
 * See agent-session.js for the emit paths:
 *   - session_compact:  _extensionRunner.emit()  (lines 1417, 1660)
 *   - compaction_end:   this._emit()             (lines 1432, 1674)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, SIGNAL_KEYS } from "../signals.js";
import { createLogger } from "../../../lib/core/logger.js";
import { callScratchpadTool, getExtensionState } from "../../../lib/state/extension-state.js";
import * as timerMod from "../../scheduling/timer/index.js";

const log = createLogger("enforcement:session-compact");

export function registerSessionCompactHandler(pi: ExtensionAPI): void {
  onEvent(pi, "session_compact", async (_event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    // ── Re-entrancy guard ────────────────────────────────────────────────
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

      // ── Deferred: re-orientation whisper with agent wake-up ─────────────
      // Deferred via setTimeout(0) to avoid stack overflow from synchronous
      // re-entry (see file-level comment). setTimeout(0) creates a macrotask
      // boundary — the call stack fully unwinds before the deferred work runs.
      // queueMicrotask was used previously but does NOT break the stack:
      // microtasks run in the same event loop turn, so synchronous chains
      // (callScratchpadTool → tool_call → TOOL_EXECUTION_END → handlers →
      // sendTrackedMessage → pi.sendMessage → _runAgentPrompt → ...) can
      // still overflow. Uses triggerTurn: true so the agent wakes up and
      // continues its loop automatically.
      //
      // Auto-resume logic (pi 0.79.10+ added `reason` and `willRetry` to
      // session_compact events so extensions can distinguish flows):
      //   - willRetry === true:  overflow recovery — pi WILL retry the aborted
      //     turn automatically after compaction. Skip auto-resume; the retry
      //     IS the resume mechanism. Waking again would risk re-entering the
      //     pre-compaction tool_call → TOOL_EXECUTION_END chain this handler
      //     was patched to defer (see stack-overflow comment above).
      //   - reason === "threshold" | "overflow" (willRetry false): auto-compaction,
      //     auto-resume.
      //   - reason === "manual": check autoResumeAfterCompaction flag:
      //     - Flag set (by context_compress tool): agent-initiated, auto-resume.
      //     - Flag not set: user typed /compress, skip auto-resume.
      const shouldAutoResume =
        !_event.willRetry &&
        (_event.reason === "threshold" ||
          _event.reason === "overflow" ||
          getState(ctx).autoResumeAfterCompaction);
      // Clear the flag immediately (one-shot)
      getState(ctx).autoResumeAfterCompaction = false;

      if (!shouldAutoResume) {
        log.debug(
          `session_compact: skipping auto-resume ` +
            `(reason=${_event.reason ?? "unknown"}, willRetry=${!!_event.willRetry})`,
        );
        return;
      }

      setTimeout(() => {
        void (async () => {
          try {
            const scratchpadResult = await callScratchpadTool(ctx, { action: "read" });
            const details = scratchpadResult?.details;
            const learnings = details?.key_learnings ?? [];
            const unpersisted = learnings.filter((l: any) => !l.persisted);

            // Unpersisted learnings advisory (no wake-up needed)
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
              });
            }

            // Re-orientation whisper with triggerTurn: true wakes the agent
            sendEnforcementWhisper(
              pi,
              ctx,
              `Context compacted at turn ${compactTurn}. ` +
                `Re-orient: read scratchpad for goal/plan/learnings, then check next pending task. ` +
                `These surfaces survive compaction - continue from there.`,
              false,
              { triggerTurn: true },
            );
          } catch (err) {
            log.debug(
              "session_compact handler: side-effects failed (stale ctx?):",
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