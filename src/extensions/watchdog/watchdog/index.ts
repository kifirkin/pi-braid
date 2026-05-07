import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";

const log = createLogger("watchdog");
/**
 * Pi Watchdog Extension
 *
 * Monitors session health without polluting stdout.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
    const path = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
    sessions.set(path, {
      startTime: Date.now(),
      lastProgressTime: Date.now(),
      messageCount: 0,
      isStreaming: false,
    });
    ctx.ui.setStatus("watchdog", "active");
  });

  pi.on("message_end", async (_event, ctx) => {
    const path = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.lastProgressTime = Date.now();
      sessionState.messageCount++;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    const path = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) sessionState.isStreaming = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const path = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.isStreaming = false;
      sessionState.lastProgressTime = Date.now();
    }
  });

  pi.registerCommand("watchdog-status", {
    description: "Show watchdog status",
    handler: async (_args, ctx) => {
      const path = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
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
