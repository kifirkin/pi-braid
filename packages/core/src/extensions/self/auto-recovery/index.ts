/**
 * Auto-Recovery from Degradation - Automatic Health Check & Recovery
 *
 * On each turn_start, checks if the system is in a degraded state via
 * isDegraded(). If degraded and a recovery hasn't been suggested recently,
 * sends a steer telling the agent to check health and consider re-planning.
 *
 * This prevents the agent from compounding errors while degraded.
 *
 * The same turn_start also reports routes that are out of usable keys (see
 * reportExhaustedRoutes). That is a fact about the provider, not a verdict
 * about the agent, so it is spoken once per episode and is not gated by the
 * degradation verdict, its warm-up or its cooldown.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { readExhaustedRoutes } from "../../../lib/state/global-state.js";
import type { ExhaustedRoute } from "../../../lib/state/global-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";
import { isDegraded, getDegradationReasons } from "../../../lib/detection/degradation-detector.js";
import { getSessionHealth } from "../../enforcement/session-health.js";
import { onEvent } from "../../../lib/events/event-types.js";

const log = createLogger("auto-recovery");

const COOLDOWN_TURNS = 10; // Don't suggest recovery again within N turns
const MIN_TURNS_BEFORE_CHECK = 5; // Wait N turns before first check (let agent warm up)
const STATE_KEY = "auto-recovery";

interface RecoveryState {
  turnCounter: number;
  lastRecoveryTurn: number;
}

function getState(ctx: ExtensionContext): RecoveryState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    turnCounter: 0,
    lastRecoveryTurn: 0,
  }));
}

/**
 * Build the degradation whisper. Agent degradation (healthy provider) and
 * an external session-health condition (provider balance/auth, aborts) are
 * different states and must read differently: the external form names the
 * cause and never recommends self-checks or re-planning — re-planning
 * cannot fix a provider outage the watchdog already tracks.
 */
export function buildDegradationWhisper(reasons: string[], healthMode: string): string {
  const reasonList = reasons.map((r) => `- ${r}`).join("\n");
  if (healthMode !== "healthy") {
    return (
      `## External Degradation: session health is "${healthMode}"\n\n` +
      `**Detected reasons:**\n${reasonList}\n\n` +
      `This is an EXTERNAL condition (provider or session-level: balance, auth, aborted), ` +
      `not agent degradation. The watchdog already tracks provider outages; ` +
      `these errors say nothing about your approach. ` +
      `Pause heavy work until session health returns to healthy.`
    );
  }
  return (
    `## System Degradation Detected\n\n` +
    `**Degradation reasons:**\n${reasonList}\n\n` +
    `**Recommended actions:**\n` +
    `1. Run \`health_maintenance(action="check")\` (if available) to assess the current state\n` +
    `2. Consider whether a different approach would avoid the recurring errors\n` +
    `3. If the current approach keeps failing, use \`think()\` to re-plan\n` +
    `4. Use \`finalize()\` with task decomposition if scope is too large\n\n` +
    `Continuing without addressing degradation risks compounding errors.`
  );
}

/**
 * The whisper for a route whose every key is spent. Facts only: the route, the
 * counts, when the earliest key comes back, and the choice that is left (wait,
 * or run the work elsewhere). It never recommends a self-check or a re-plan: a
 * spent key is not a wrong approach, and reasoning does not refill one.
 */
export function buildRouteExhaustionWhisper(route: ExhaustedRoute): string {
  const next =
    route.nextRetryAt === null
      ? "No key is due back on a known schedule; the ring keeps retrying on its own."
      : `Next key due back at **${formatLocalTime(new Date(route.nextRetryAt), true)}**.`;
  // "Before that time" only when there is a time to name: a retry AFTER the
  // named return is exactly the retry that works, so the sentence must not
  // read as "never retry".
  const tail =
    route.nextRetryAt === null
      ? "Retrying cannot change it, and re-planning does not refill a key. Wait for " +
        "the ring to recover, or run the work on another configured route."
      : "Retrying before that time cannot change it, and re-planning does not refill " +
        "a key. Wait for that time, or run the work on another configured route.";
  return (
    `## Route out of keys: \`${route.routeId}\`\n\n` +
    `**${route.usable} of ${route.total}** keys usable. Every request to this route fails until one returns.\n` +
    `${next}\n\n` +
    tail
  );
}

/** Routes this session has already named, one whisper per episode. */
interface RouteExhaustionReportState {
  reported: string[];
}

const ROUTE_EXHAUSTION_STATE_KEY = "route-exhaustion-report";

/**
 * Tell the agent, once, about every route that has no usable key left.
 *
 * An episode is the stretch between the observation that spends a route's last
 * key and the observation that gives it one back. The providers package
 * publishes that record at each turn boundary (ring-health.ts), so nothing
 * here polls: the same record seen on two turns is one episode, and `reported`
 * is what makes the difference between a fact and a nag. A route that recovers
 * leaves the set, so its next exhaustion is news again.
 *
 * A record naming a return time that has already passed is skipped: the ring
 * was not re-observed since, its own backoff would have handed a key back, and
 * a claim that may already be false teaches the agent to distrust the one
 * sentence that names a time. A record that still reports a usable key is
 * skipped for the same reason at the other end: it is not an exhaustion.
 *
 * Delivery is a steer, never a wake: a wake spends a provider call, and the
 * route that would serve it is the one out of keys.
 */
function reportExhaustedRoutes(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const state = getExtensionState<RouteExhaustionReportState>(
      ctx,
      ROUTE_EXHAUSTION_STATE_KEY,
      () => ({ reported: [] }),
    );
    const now = Date.now();
    const live = readExhaustedRoutes().filter(
      (route) =>
        // A record with a usable key is not a route out of keys, whatever else
        // it says: the publisher writes only spent rings, so this can only be a
        // record from a stranger or a shape that changed under us.
        route.usable <= 0 && (route.nextRetryAt === null || now < route.nextRetryAt),
    );
    // Recovery closes the episode: the same route running dry again is new.
    state.reported = state.reported.filter((routeId) =>
      live.some((route) => route.routeId === routeId),
    );
    for (const route of live) {
      if (state.reported.includes(route.routeId)) continue;
      const text = buildRouteExhaustionWhisper(route);
      let delivered = false;
      try {
        delivered = sendTrackedMessage(
          pi,
          {
            customType: "route-exhaustion",
            content: [{ type: "text" as const, text }],
            display: true,
          },
          { deliverAs: "steer" },
          { type: "enforcement", source: "auto-recovery/route-exhaustion" },
        );
      } catch (e) {
        log.warn(`[auto-recovery] route-exhaustion whisper failed: ${(e as Error).message}`);
      }
      // Only a delivered whisper closes the episode. A suppressed one (flood
      // cap, nudges off) leaves the fact unspoken; the next turn may speak it.
      if (!delivered) continue;
      state.reported.push(route.routeId);
      log.warn(
        `[auto-recovery] route ${route.routeId} is out of keys (${route.usable}/${route.total} usable)`,
      );
    }
  } catch (e) {
    log.warn(`[auto-recovery] route-exhaustion read failed: ${(e as Error).message}`);
  }
}

export default function autoRecoveryExtension(pi: ExtensionAPI): void {
  onEvent(pi, "turn_start", async (_event: any, ctx: ExtensionContext) => {
    // Ahead of the degradation gates on purpose: those exist to keep a stale
    // verdict from nagging, and they have nothing to say about a route with no
    // key to serve. A turn is the first moment the agent can be told before
    // it spends the retry.
    reportExhaustedRoutes(pi, ctx);

    try {
      const state = getState(ctx);
      state.turnCounter++;

      // Warm-up: don't check until agent has had a chance to work
      if (state.turnCounter < MIN_TURNS_BEFORE_CHECK) return;

      // Cooldown: don't spam recovery suggestions
      if (state.turnCounter - state.lastRecoveryTurn < COOLDOWN_TURNS) return;

      if (!isDegraded(ctx)) return;

      const reasons = getDegradationReasons(ctx);
      if (reasons.length === 0) return;

      state.lastRecoveryTurn = state.turnCounter;

      const healthMode = getSessionHealth(ctx).mode;
      const message = buildDegradationWhisper(reasons, healthMode);

      log.warn(`[auto-recovery] Degraded: ${reasons.join("; ")}`);

      try {
        sendTrackedMessage(
          pi,
          {
            customType: "auto-recovery",
            content: [{ type: "text" as const, text: message }],
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
          { type: "enforcement", source: "auto-recovery/degradation" },
        );
      } catch (e) {
        log.warn(`[auto-recovery] steer delivery failed: ${(e as Error).message}`);
      }
    } catch (e) {
      log.warn(`[auto-recovery] handler error (stale ctx?): ${(e as Error).message}`);
    }
  });

  log.info("[auto-recovery] loaded: degradation detection on turn_start");
}
