/**
 * Auto-Recovery from Degradation — Automatic Health Check & Recovery
 *
 * On each turn_start, checks if the system is in a degraded state via
 * isDegraded(). If degraded and a recovery hasn't been suggested recently,
 * sends a steer telling the agent to check health and consider re-planning.
 *
 * This prevents the agent from compounding errors while degraded.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { isDegraded, getDegradationReasons } from "../../../lib/degradation-detector.js";

const log = createLogger("auto-recovery");

// ── Constants ────────────────────────────────────────────────────────────────

const COOLDOWN_TURNS = 10;  // Don't suggest recovery again within N turns
const MIN_TURNS_BEFORE_CHECK = 5; // Wait N turns before first check (let agent warm up)
const STATE_KEY = "auto-recovery";

// ── Session-scoped state ───────────────────────────────────────────────────

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

// ── Extension ────────────────────────────────────────────────────────────────

export default function autoRecoveryExtension(pi: ExtensionAPI): void {
  pi.on("turn_start" as never, async (_event: any, ctx: ExtensionContext) => {
    try {
      const state = getState(ctx);
      state.turnCounter++;

      // Warm-up: don't check until agent has had a chance to work
      if (state.turnCounter < MIN_TURNS_BEFORE_CHECK) return;

      // Cooldown: don't spam recovery suggestions
      if (state.turnCounter - state.lastRecoveryTurn < COOLDOWN_TURNS) return;

      // Check degradation state
      if (!isDegraded(ctx)) return;

      const reasons = getDegradationReasons(ctx);
      if (reasons.length === 0) return;

      state.lastRecoveryTurn = state.turnCounter;

      const reasonList = reasons.map((r) => `- ${r}`).join("\n");
      const message =
        `## ⚠️ System Degradation Detected\n\n` +
        `**Degradation reasons:**\n${reasonList}\n\n` +
        `**Recommended actions:**\n` +
        `1. Run \`health-maintenance(action="check")\` (if available) to assess the current state\n` +
        `2. Consider whether a different approach would avoid the recurring errors\n` +
        `3. If the current approach keeps failing, use \`think()\` to re-plan\n` +
        `4. Use \`finalize()\` with task decomposition if scope is too large\n\n` +
        `Continuing without addressing degradation risks compounding errors.`;

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
      } catch {
        /* non-fatal */
      }
    } catch {
      /* Non-fatal: stale ctx or state access failure */
    }
  });

  log.info("[auto-recovery] loaded: degradation detection on turn_start");
}
