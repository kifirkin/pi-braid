/**
 * Auto-Recovery from Degradation - Automatic Health Check & Recovery
 *
 * On each turn_start, checks if the system is in a degraded state via
 * isDegraded(). If degraded and a recovery hasn't been suggested recently,
 * sends a steer telling the agent to check health and consider re-planning.
 *
 * This prevents the agent from compounding errors while degraded.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
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

export default function autoRecoveryExtension(pi: ExtensionAPI): void {
  onEvent(pi, "turn_start", async (_event: any, ctx: ExtensionContext) => {
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
