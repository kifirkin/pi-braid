/**
 * Enforcement Whisper - direct message delivery.
 */

import { createLogger } from "../../lib/core/logger.js";
import { eventBus } from "../../lib/events/event-bus.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../lib/utils/injection-tracker.js";
import { recordNudgeSent } from "../../lib/reasoning/nudge-analytics.js";
import { areCognitiveNudgesDisabled } from "../../lib/config/braid-settings.js";
import { isRouteLatchOpen } from "./session-health.js";

const log = createLogger("enforcement");

/**
 * Send an enforcement whisper immediately using sendTrackedMessage().
 *
 * Whisper types:
 * - followUp: advisory signals, tool misuse, memory suggestions
 *             visible in TUI, no forced turn (non-critical)
 * - steer:    critical signals (blocks, error bursts, overflow)
 *             triggerTurn: true ensures agent processes immediately
 *
 * Default delivery does not start an autonomous turn: non-critical whispers
 * ride the current run (delivery class "live" - steer while the run streams,
 * append when idle) or queue for the next user prompt, which prevents
 * autonomous agent loops (compaction -> new turn -> more context -> more
 * compaction). Callers whose advisory must NOT force a continuation turn pass
 * `delivery: "park"` explicitly. Genuinely critical whispers
 * (compaction-retry exhausted, session rotation, three-memory reliability)
 * pass `triggerTurn: true` explicitly.
 *
 * Parameters:
 *   critical     - If true, emits an `enforcement_violation` event
 *                  so MARS/analytics/auto-recovery can react.
 *   options.triggerTurn - Explicit override. When set, controls
 *                  whether pi.sendMessage starts a new turn. Only pass
 *                  `true` for genuinely critical cases (compaction-retry
 *                  exhausted, session rotation, three-memory reliability).
 *   options.delivery - Delivery class for a non-waking whisper: "live"
 *                  (default) reaches the running loop, "park" records for the
 *                  end-of-turn flush. See the delivery contract in
 *                  `lib/utils/injection-tracker.ts`.
 *   options.deliverAs - Delivery mode. Defaults to `"steer"` for a
 *                  non-waking whisper; left undefined when triggerTurn:true so
 *                  pi-core's wake branch is not shadowed by the nextTurn queue.
 *   options.bypassFloodCap - Skip the per-turn/per-source whisper flood cap
 *                  in the funnel (see `sendTrackedMessage`'s JSDoc). Opt-in
 *                  per call site, default false, and reserved for a wake
 *                  whose loss is a correctness bug rather than a lost nudge:
 *                  the post-compaction resume, which is the only thing that
 *                  hands the aborted loop back. Every enforcement whisper
 *                  shares the `enforcement/whisper` bucket, so three ordinary
 *                  advisories in one turn are enough to spend it - a blanket
 *                  exemption for `triggerTurn` would instead turn every
 *                  waking caller into a flood risk, which is why the cap is
 *                  bypassed here per call rather than in the funnel.
 *
 * Nudges are suppressed when braid.suppressNudges=true in settings.json.
 */
export function sendEnforcementWhisper(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  critical: boolean = false,
  options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "nextTurn";
    delivery?: "live" | "park";
    bypassFloodCap?: boolean;
  },
): void {
  // Cognitive nudge suppression - separate from confirm dialogs
  if (areCognitiveNudgesDisabled()) {
    log.debug("[whisper] Cognitive nudges suppressed via braid.suppressNudges=true");
    return;
  }

  // Track nudge sent for A/B variant analytics.
  try {
    recordNudgeSent(ctx);
  } catch (err) {
    log.warn("Failed to record nudge sent:", err);
  }

  // Emit via event bus — only as a violation when actually critical: an
  // advisory nudge propagating as a `tool_error` event triggers MARS
  // error-recurrence and auto-recovery on the next turn, amplifying a benign
  // advisory into an error burst.
  if (critical) {
    try {
      eventBus.emit({
        type: "enforcement_violation",
        rule: "enforcement",
        description: message,
        severity: "high",
      });
    } catch (err) {
      log.warn("Failed to emit enforcement event:", err);
    }
  }

  // Tag all enforcement whispers with customType="enforcement" so the agent
  // knows these are system-generated signals, not human messages.
  // The universal "[braid-whisper - enforcement]" envelope is applied by
  // `sendTrackedMessage` (the trunk) so this wrapper just passes the raw
  // message through. See `lib/utils/whisper-format.ts` for the full design.
  //
  // Callers that need immediate agent action pass `triggerTurn: true` in
  // options. When they do, `deliverAs` stays undefined: pi-core's
  // `sendCustomMessage` routes an explicit `deliverAs === "nextTurn"` to
  // `_pendingNextTurnMessages` BEFORE evaluating `triggerTurn`
  // (agent-session.ts:1287/1295), so a `triggerTurn: true` wake with the
  // `nextTurn` default would be silently queued for the next user prompt and
  // never fire — defeating the gated auto-resume after agent-initiated
  // mid-turn compaction (context_compress tool). Undefined `deliverAs` falls
  // through to the triggerTurn branch and calls agent.prompt(), the same wake
  // path the timer extension uses.
  const requestedTriggerTurn = options?.triggerTurn ?? false;
  // Route-failure latch: a whisper that asked to wake the agent must not
  // start a turn into a route that has failed every attempt since the last
  // successful call. The advisory is not withdrawn — the same text still
  // reaches the session as the ordinary non-waking steer; only the wake is
  // withheld, so the next self-started call is not a doomed one. Only the
  // route half of the turn-start question applies here: an explicitly-waking
  // whisper never consulted the terminal breaker, and making it do so now
  // would park the post-compaction resume on a signal it never used to read.
  const demoted = requestedTriggerTurn && isRouteLatchOpen(ctx);
  if (demoted) {
    log.info("[whisper] waking whisper demoted to non-waking (route latch open)");
  }
  const triggerTurn = requestedTriggerTurn && !demoted;
  const deliverAs = options?.deliverAs ?? (triggerTurn ? undefined : "steer");
  // Default class for a non-waking enforcement whisper: live. An enforcement
  // advisory's value is read during the run it fires in (see the delivery
  // contract in lib/utils/injection-tracker.ts). Callers whose advisory must
  // not force a continuation turn pass `delivery: "park"` explicitly.
  const delivery = options?.delivery ?? (triggerTurn ? undefined : "live");
  sendTrackedMessage(
    pi,
    {
      customType: "enforcement",
      content: [{ type: "text" as const, text: message }],
      display: true,
    },
    { deliverAs, triggerTurn, delivery },
    { type: "enforcement", source: "enforcement/whisper" },
    // Forwarded per call, never defaulted on: the funnel's flood cap stays
    // the gate for every enforcement whisper that does not ask for the
    // exemption explicitly.
    { bypassFloodCap: options?.bypassFloodCap === true },
  );
}
