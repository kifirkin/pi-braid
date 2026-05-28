/**
 * Default Policies for heartbeat scheduler.
 *
 * Policies are evaluated on each tick and can trigger whispers or signals.
 * Includes: verification hint, reflection reminder, web verification hint,
 * and proactive context monitoring with auto-finalize at 90%.
 */

import type { Policy, PolicyContext, BeliefStore } from "../../../lib/belief-store.js";
import type { ToolTracking } from "./types.js";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import {
  USAGE_WHISPER_SOFT,
  USAGE_WHISPER_ADVISORY,
  USAGE_WHISPER_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_FIRED_RESET_BELOW,
} from "../../../lib/detection/context-thresholds.js";

const log = createLogger("heartbeat:policies");

/**
 * Persist fired threshold set across invocations so the context-monitor
 * policy doesn't re-fire the same threshold every tick.
 * Cleared when usage drops below USAGE_FIRED_RESET_BELOW.
 */
const _firedThresholds: Set<number> = new Set();

export const VERIFICATION_TOOLS = new Set([
  "grep",
  "find",
  "read",
  "read_document",
  "browser_content",
  "web_fetch",
]);

export const WEB_TOOLS = new Set(["web_fetch", "browser_navigate", "browser_content"]);

export const CODE_TOOLS = new Set(["bash", "write", "edit"]);

export function createDefaultPolicies(
  getToolTracking: () => ToolTracking,
  onSignal: (type: string, data: Record<string, unknown>) => void,
  sendWhisper: (msg: string) => void,
  getContextUsage: () => ContextUsage | undefined,
  sendSteerMessage: (msg: string) => void,
): Policy[] {
  return [
    // ── Verification hint ───────────────────────────────────────────
    {
      id: "verify-hint",
      name: "Verification Hint",
      description: "Whisper if no verification activity in 10+ turns",
      priority: 50,
      cooldownMs: 30_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const turnsSince = ctx.turnNumber - t.lastVerificationTurn;
        return turnsSince >= 10 && t.totalToolsUsed > 3;
      },
      action: async (ctx: PolicyContext) => {
        sendWhisper(
          "No verification (grep/read/search) in 10+ turns. " +
            "Consider: Are you sure the implementation is correct? " +
            "Verify with grep or read to confirm.",
        );
        onSignal("verification_reminder", {
          turn: ctx.turnNumber,
          turnsSinceVerification: ctx.turnNumber - getToolTracking().lastVerificationTurn,
        });
      },
    },

    // ── Long silence warning ─────────────────────────────────────────
    {
      id: "reflection-reminder",
      name: "Reflection Reminder",
      description: "Suggest thinking if no progress for 8+ turns",
      priority: 40,
      cooldownMs: 45_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const turnsSinceLastTool = ctx.turnNumber - t.lastToolCallTurn;
        return turnsSinceLastTool >= 8 && t.totalToolsUsed > 2;
      },
      action: async () => {
        sendWhisper(
          "8+ turns with no tool calls. Consider using /think to reflect " +
            "on progress or /finalize if the task is complete.",
        );
        onSignal("reflection_reminder", { turn: 0 });
      },
    },

    // ── Web verification hint ────────────────────────────────────────
    {
      id: "web-verification-hint",
      name: "Web Verification Hint",
      description: "Suggest web verification if using web beliefs without fetches",
      priority: 35,
      cooldownMs: 90_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const webBeliefs = store.query({ source: "web", maxAge: 3_600_000 });
        const turnsSinceWeb = ctx.turnNumber - t.lastWebFetchTurn;
        return webBeliefs.length > 2 && turnsSinceWeb >= 15;
      },
      action: async () => {
        sendWhisper(
          "You have recent web-based beliefs but haven't fetched " +
            "documentation in 15+ turns. Consider verifying claims " +
            "with web_fetch or browser_navigate.",
        );
        onSignal("web_verification_reminder", { turn: 0 });
      },
    },

    // ── Proactive context monitoring ──────────────────────────────────
    {
      id: "context-monitor",
      name: "Context Monitor",
      description: "Monitor token usage and warn before overflow",
      priority: 80,
      cooldownMs: 30_000,
      enabled: true,
      lastActivated: 0,
      trigger: async () => true,
      action: async (_ctx: PolicyContext) => {
        const usage = getContextUsage();
        if (!usage || usage.percent === null) return;
        const { percent, tokens, contextWindow } = usage;

        // Clear fired thresholds when usage drops below reset point
        if (percent < USAGE_FIRED_RESET_BELOW && _firedThresholds.size > 0) {
          _firedThresholds.clear();
        }

        // Threshold ladder: soft → advisory → warning → critical
        // Each threshold fires ONCE until usage resets below USAGE_FIRED_RESET_BELOW
        // Pipeline taught fully at critical level; lighter hints below that.
        const thresholds: Array<{ pct: number; priority: "low" | "medium" | "high"; msg: string }> =
          [
            {
              pct: USAGE_WHISPER_SOFT,
              priority: "low",
              msg: `Context at ${USAGE_WHISPER_SOFT}%. context_tag to mark progress.`,
            },
            {
              pct: USAGE_WHISPER_ADVISORY,
              priority: "medium",
              msg: `Context at ${USAGE_WHISPER_ADVISORY}%. context_tag, then context_checkout to branch with a summary.`,
            },
            {
              pct: USAGE_WHISPER_WARNING,
              priority: "medium",
              msg: `Context at ${USAGE_WHISPER_WARNING}%. context_tag now, then branch with context_checkout.`,
            },
            {
              pct: USAGE_WHISPER_CRITICAL,
              priority: "high",
              msg: `CRITICAL: Context at ${USAGE_WHISPER_CRITICAL}%. Pipeline: context_tag → context_checkout → context_archive → compact (last resort).`,
            },
          ];

        for (const { pct, msg } of thresholds) {
          if (percent >= pct && !_firedThresholds.has(pct)) {
            _firedThresholds.add(pct);
            sendWhisper(
              `${msg} (${tokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens, ${percent?.toFixed(1)}%)`,
            );
            log.warn(`Token warning: ${percent?.toFixed(1)}% (${tokens}/${contextWindow} tokens)`);
            if (pct === USAGE_WHISPER_CRITICAL) {
              const finalizationMessage =
                `[heartbeat] Context critical at ${percent?.toFixed(1)}%. ` +
                `Tag your position with context_tag now and branch with context_checkout.`;
              sendSteerMessage(finalizationMessage);
              log.warn(`Auto-finalize triggered at ${USAGE_WHISPER_CRITICAL}%`);
            }
            break;
          }
        }
      },
    },
  ];
}
