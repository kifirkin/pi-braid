/**
 * Pi Watchdog Extension
 *
 * Monitors session health without polluting stdout.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SessionManager } from "../../lib/state/session-manager.js";
import { safeSessionManager } from "../../lib/state/extension-state.js";
import { createLogger } from "../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../lib/state/session-start-queue.js";
import { eventBus } from "../../lib/events/event-bus.js";

// pi's native SessionManager has getSessionFile() not in our wrapper
interface SmWithSessionFile extends SessionManager {
  getSessionFile(): string;
}

const log = createLogger("watchdog");

interface SessionState {
  startTime: number;
  lastProgressTime: number;
  messageCount: number;
  isStreaming: boolean;
}

const sessions = new Map<string, SessionState>();

function formatTime(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

export default function (pi: ExtensionAPI) {
  registerSessionStartHandler(pi, SessionPhase.Background, async (_event, ctx) => {
    const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
    const path = sm?.getSessionFile?.() ?? ctx.cwd;
    sessions.set(path, {
      startTime: Date.now(),
      lastProgressTime: Date.now(),
      messageCount: 0,
      isStreaming: false,
    });
    ctx.ui.setStatus("watchdog", "active");
  });

  // Subscribe to analytics_alert for monitoring alerts
  eventBus.on("analytics_alert", (event) => {
    if (event.severity === "critical") {
      log.warn(`[watchdog] Critical analytics alert: ${event.message}`);
    } else if (event.severity === "warn") {
      log.info(`[watchdog] Analytics warning: ${event.message}`);
    }
  });

  pi.on("message_end", async (_event, ctx) => {
    const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
    const path = sm?.getSessionFile?.() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.lastProgressTime = Date.now();
      sessionState.messageCount++;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
    const path = sm?.getSessionFile?.() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) sessionState.isStreaming = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
    const path = sm?.getSessionFile?.() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.isStreaming = false;
      sessionState.lastProgressTime = Date.now();
    }
  });

  pi.registerCommand("watchdog-status", {
    description: "Show watchdog status",
    handler: async (_args, ctx) => {
      const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
      const path = sm?.getSessionFile?.() ?? ctx.cwd;
      const sessionState = sessions.get(path);
      if (!sessionState) return;
      const now = Date.now();
      ctx.ui?.notify(
        `Watchdog: ${formatTime(now - sessionState.startTime)} uptime, ` +
          `${formatTime(now - sessionState.lastProgressTime)} idle, ${sessionState.messageCount} msgs`,
        "info",
      );
    },
  });
}
