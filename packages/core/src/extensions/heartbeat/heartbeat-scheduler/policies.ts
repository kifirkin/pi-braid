/**
 * Default Policies for heartbeat scheduler.
 *
 * Policies are evaluated on each tick and can trigger whispers or signals.
 * Includes: verification hint, reflection reminder, web verification hint,
 * and proactive context monitoring with auto-finalize at 90%.
 */

import type { Policy, PolicyContext, BeliefStore } from "../../../lib/store/belief-store.js";
import type { ToolTracking } from "./types.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  USAGE_WHISPER_SOFT,
  USAGE_WHISPER_ADVISORY,
  USAGE_WHISPER_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_FIRED_RESET_BELOW,
} from "../../../lib/detection/context-thresholds.js";
import {
  CONTEXT_USAGE_TIERS,
  getContextUsage,
  type ContextUsageTierInfo,
} from "../../../lib/detection/context-tiers.js";

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
  "document_parse",
  "browser_content",
  "fetch_content",
]);

export const WEB_TOOLS = new Set(["fetch_content", "browser_navigate", "browser_content"]);

export const CODE_TOOLS = new Set(["bash", "write", "edit"]);

export function createDefaultPolicies(
  getToolTracking: () => ToolTracking,
  onSignal: (type: string, data: Record<string, unknown>) => void,
  sendWhisper: (msg: string) => void,
  sendSteerMessage: (msg: string) => void,
): Policy[] {
  return [
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
            "with fetch_content or browser_navigate.",
        );
        onSignal("web_verification_reminder", { turn: 0 });
      },
    },

    {
      id: "context-monitor",
      name: "Context Monitor",
      description: "Monitor token usage and warn before overflow",
      priority: 80,
      cooldownMs: 30_000,
      enabled: true,
      lastActivated: 0,
      trigger: async () => true,
      action: async (policyCtx: PolicyContext) => {
        const usage = getContextUsage(policyCtx);
        if (!usage || usage.percent === null) return;
        // PolicyContext's ContextUsage contract has percent/tokens/contextWindow
        // required; the shared accessor types them optional (other sites read a
        // subset). Values are always present per the wiring (heartbeat-scheduler
        // index.ts), so these defaults never fire — preserved from the original
        // required-typed destructure.
        const { percent = 0, tokens = 0, contextWindow = 0 } = usage;

        if (percent < USAGE_FIRED_RESET_BELOW && _firedThresholds.size > 0) {
          _firedThresholds.clear();
        }

        // Threshold ladder: soft -> advisory -> warning -> critical
        // Each threshold fires ONCE until usage resets below USAGE_FIRED_RESET_BELOW.
        // Pipeline taught fully at critical level; lighter hints below that.
        // Tier→(threshold, priority) mapping shared from
        // lib/detection/context-tiers.ts (CONTEXT_USAGE_TIERS); this policy
        // keeps its own per-tier message copy (different copy from the
        // enforcement nudge text).
        const TIER_MESSAGES: Record<"soft" | "advisory" | "warning" | "critical", string> = {
          soft: `Context at ${USAGE_WHISPER_SOFT}%. Inspect and track: context_inspect(detail="quick"). Tag with context_navigate(action="tag") to mark progress.`,
          advisory: `Context at ${USAGE_WHISPER_ADVISORY}%. Light pruning: context_inspect(detail="prune") then context_compress(action="archive") or context_navigate(action="tag") + context_compress(action="archive").`,
          warning: `Context at ${USAGE_WHISPER_WARNING}%. Deep compaction: tag + archive now. Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> compact if needed.`,
          critical: `CRITICAL: Context at ${USAGE_WHISPER_CRITICAL}%. FORCE IMMEDIATE HYGIENE. Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> context_compress(action="slide"). Do not continue work until done.`,
        };

        const thresholds: Array<{ pct: number; priority: "low" | "medium" | "high"; msg: string }> =
          CONTEXT_USAGE_TIERS.filter(
            (
              t,
            ): t is ContextUsageTierInfo & { tier: "soft" | "advisory" | "warning" | "critical" } =>
              t.tier !== "compact",
          )
            .slice()
            .reverse()
            .map((t) => ({ pct: t.threshold, priority: t.priority, msg: TIER_MESSAGES[t.tier] }));

        for (const { pct, msg } of thresholds) {
          if (percent >= pct && !_firedThresholds.has(pct)) {
            _firedThresholds.add(pct);
            sendWhisper(
              `${msg} (${tokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens, ${percent?.toFixed(1)}%)`,
            );
            if (pct === USAGE_WHISPER_CRITICAL) {
              const finalizationMessage =
                `[heartbeat] Context critical at ${percent?.toFixed(1)}%. ` +
                `Tag your position with context_navigate(action="tag") now and archive with context_compress(action="archive").`;
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
