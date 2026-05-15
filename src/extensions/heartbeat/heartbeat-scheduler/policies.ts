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
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("heartbeat:policies");

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
        // Store fired thresholds on the getContextUsage() result as metadata
        const fired: Set<number> = new Set();

        const thresholds: Array<{ pct: number; priority: "low" | "medium" | "high"; msg: string }> =
          [
            {
              pct: 70,
              priority: "low",
              msg: "Context at 70%. Consider using /finalize or /context_archive to reduce context.",
            },
            {
              pct: 80,
              priority: "medium",
              msg: "Context at 80%. Use /context_archive or /finalize NOW.",
            },
            {
              pct: 90,
              priority: "high",
              msg: "CRITICAL: Context at 90%. Call finalize(completed=false, summary='[brief status]', tasksRemaining=[...]) RIGHT NOW.",
            },
          ];

        for (const { pct, priority, msg } of thresholds) {
          if (percent >= pct && !fired.has(pct)) {
            fired.add(pct);
            sendWhisper(
              `${msg} (${tokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens, ${percent?.toFixed(1)}%)`,
            );
            log.warn(`Token warning: ${percent?.toFixed(1)}% (${tokens}/${contextWindow} tokens)`);
            if (pct === 90) {
              const finalizationMessage =
                `[heartbeat] Context critical at ${percent?.toFixed(1)}%. Auto-finalizing to prevent overflow. ` +
                `Stop all work and call finalize(completed=false, autoProceed=true) now.`;
              sendSteerMessage(finalizationMessage);
              log.warn(`Auto-finalize triggered at 90%`);
            }
            break;
          }
        }

        if (percent < 50 && fired.size > 0) {
          fired.clear();
        }
      },
    },
  ];
}
