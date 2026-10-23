/**
 * register-session-compact - Hygiene reset + re-orientation whisper after compaction.
 *
 * The re-orientation whisper honors whether the agent had already
 * stopped naturally (lastTurnWasNaturalStop, set at turn_end). A natural stop
 * gets an ADVISORY whisper (triggerTurn:false) so compaction does not force a
 * fresh turn after the agent already finished; a mid-work turn keeps
 * triggerTurn:true so compaction hands the loop back. See the deferred
 * re-orientation whisper block below.
 *
 * Re-entrancy guard + deferred side-effects (added, see
 * post-compaction stack overflow trace):
 *   The previous design called `callScratchpadTool` + `sendEnforcementWhisper`
 *   synchronously from the session_compact handler. A nested scratchpad tool
 *   invocation would fire `tool_call` / `tool_execution_end` synchronously,
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
 *   - session_compact: _extensionRunner.emit() (lines 1417, 1660)
 *   - compaction_end: this._emit() (lines 1432, 1674)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_COMPACT } from "../../../lib/core/event-names.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, SIGNAL_KEYS } from "../signals.js";
import { createLogger } from "../../../lib/core/logger.js";
import { readScratchpadState, getExtensionState } from "../../../lib/state/extension-state.js";
import * as timerMod from "../../scheduling/timer/index.js";

const log = createLogger("enforcement:session-compact");

export function registerSessionCompactHandler(pi: ExtensionAPI): void {
  onEvent(pi, SESSION_COMPACT, async (_event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const reentrancy = getExtensionState<{ inHandler: boolean }>(
      ctx,
      "enforcement/session-compact-reentrancy",
      () => ({ inHandler: false }),
    );
    if (reentrancy.inHandler) {
      log.warn(
        "Re-entrant session_compact detected - skipping side-effects to prevent stack overflow",
      );
      return;
    }
    reentrancy.inHandler = true;

    try {
      const compactTurn = getState(ctx).currentTurn;

      // Cancel any stale compaction-resume timer from a previous cycle.
      try {
        const sessionId =
          (
            ctx as { sessionManager?: { getSessionId?: () => string } }
          )?.sessionManager?.getSessionId?.() ?? "anonymous";
        const cancelled =
          timerMod.cancelTimersByTag(sessionId, "compaction-resume") +
          timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
        if (cancelled > 0) {
          log.debug(`Cancelled ${cancelled} stale compaction resume timer(s)`);
        }
      } catch {
        // Non-fatal - timer module unavailable
      }

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

      // Auto-resume decision (pi 0.79.10+ session_compact metadata).
      // Without auto-resume, an agent-initiated compaction (context_compress
      // tool sets autoResumeAfterCompaction=true) stops the agent and needs a
      // manual nudge — the post-compaction loop stop. The correct balance:
      //   - willRetry === true: overflow recovery — pi WILL retry the aborted
      //     turn after compaction. Skip auto-resume; the retry IS the resume.
      //   - reason === "threshold" | "overflow" (willRetry false):
      //     auto-compaction, auto-resume (agent continues its loop).
      //   - reason === "manual": check autoResumeAfterCompaction flag —
      //     set by context_compress tool (agent-initiated) → auto-resume;
      //     unset (user typed /compress) → no wake, advisory only.
      // The flag is one-shot: read + clear immediately so a second emit
      // (e.g. nested compaction) doesn't double-wake. Capture it BEFORE the
      // clear so the resume delivery below can override the natural-stop
      // downgrade: when the agent itself armed compaction via the
      // context_compress tool (autoResumeAfterCompaction=true), it EXPLICITLY
      // asked to resume after compaction completes — its pre-compaction turn
      // "stopping" with stopReason "stop" is the agent trusting that promise
      // ("compaction scheduled; will resume automatically"), NOT a genuine
      // completion. Downgrading that wake to an advisory nextTurn whisper is
      // the post-compaction loop stop: the
      // explicit resume request MUST always be honored. The natural-stop
      // downgrade only applies to the auto path (threshold/overflow), where
      // the agent genuinely finished.
      const agentRequestedResume = getState(ctx).autoResumeAfterCompaction;
      const shouldAutoResume =
        !_event.willRetry &&
        (_event.reason === "threshold" || _event.reason === "overflow" || agentRequestedResume);
      getState(ctx).autoResumeAfterCompaction = false;

      // Whether the turn immediately before this compaction was a
      // natural stop (assistant, stopReason "stop", no tool calls). Set at
      // turn_end by dispatchTurnEndLoop; cleared at turn_start. Captured
      // synchronously so the deferred whisper uses a stable snapshot — a
      // natural stop must get an ADVISORY re-orientation (triggerTurn:false,
      // the loop is already at rest; the user will prompt again), while a
      // mid-work turn must keep the wake (triggerTurn:true, compaction must
      // hand the loop back).
      const naturalStop = getState(ctx).lastTurnWasNaturalStop || false;

      if (!shouldAutoResume) {
        log.debug(
          `session_compact: skipping auto-resume ` +
            `(reason=${_event.reason ?? "unknown"}, willRetry=${!!_event.willRetry})`,
        );
        // No whisper, no wake. In the willRetry case pi re-runs the aborted
        // turn itself (the retry IS the resume); in the manual-without-flag
        // case the user typed /compress and will prompt again on their own.
        // Queuing a nextTurn re-orientation here would ride on the retry or
        // the user's next prompt as noise. The scratchpad survives compaction
        // and carries the re-orientation context.
        return;
      }
      log.debug(
        `session_compact: auto-resume will wake agent ` +
          `(reason=${_event.reason ?? "unknown"}, willRetry=${!!_event.willRetry})`,
      );

      // Deferred: read scratchpad
      // Deferred via setTimeout(0) to avoid stack overflow from synchronous
      // re-entry (see file-level comment). setTimeout(0) creates a macrotask
      // boundary — the call stack fully unwinds before the deferred work runs.
      // The nextTurn delivery mode queues messages for the next user-initiated
      // prompt instead of starting an autonomous agent turn, preventing the
      // self-perpetuating loop that triggerTurn:true caused.
      setTimeout(() => {
        void (async () => {
          try {
            const scratchpad = readScratchpadState(ctx);
            const learnings = scratchpad?.key_learnings ?? [];
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
                false,
                { deliverAs: "nextTurn" },
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
          } catch (err) {
            log.debug(
              "session_compact handler: scratchpad read failed (stale ctx?):",
              (err as Error)?.message,
            );
          }
        })();
      }, 0);

      // Deferred: re-orientation whisper
      // When shouldAutoResume, uses triggerTurn: true so the agent wakes and
      // continues its loop after compaction (fixes the post-compaction loop
      // stop). Otherwise nextTurn — queued for the next user-initiated prompt,
      // no autonomous turn (preserves the self-perpetuating-loop fix).
      // A NATURAL STOP before compaction (lastTurnWasNaturalStop)
      // downgrades the wake to an advisory triggerTurn:false whisper — the
      // agent finished on its own; forcing a new turn is the noise the user
      // flagged. Whisper text and envelope are unchanged; only the
      // resume-vs-advisory delivery differs. A mid-work turn stays
      // triggerTurn:true (compaction aborted the loop; it must be handed
      // back to the agent).
      //
      // bypassFloodCap: this whisper is the resume. It is the only thing that
      // restarts a turn the context_compress tool aborted, so dropping it
      // halts the session instead of losing a nudge. Every enforcement
      // whisper shares the `enforcement/whisper` per-source bucket (cap 3),
      // so three ordinary advisories earlier in the same turn are enough to
      // spend it and swallow the wake. The exemption is granted here, at the
      // one call site that cannot afford to lose the message - not in the
      // wrapper's default and not in the funnel.
      setTimeout(() => {
        sendEnforcementWhisper(
          pi,
          ctx,
          `Context compacted at turn ${compactTurn}. ` +
            `Re-orient: read scratchpad for goal/plan/learnings, then check next pending task. ` +
            `Note: compaction summaries may lack speaker labels — use the scratchpad ` +
            `(which preserves speaker context) to distinguish who said what. ` +
            `These surfaces survive compaction - continue from there.`,
          false,
          naturalStop && !agentRequestedResume
            ? { delivery: "park", bypassFloodCap: true }
            : { triggerTurn: true, bypassFloodCap: true },
        );
      }, 0);
    } finally {
      reentrancy.inHandler = false;
    }
  });
}
