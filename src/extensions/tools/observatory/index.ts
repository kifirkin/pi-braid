/**
 * Observatory Extension — lightweight client for the singleton observatory daemon.
 *
 * This extension is a CLIENT, not a server. It connects to the singleton
 * observatory daemon (started via braid-daemon.sh) if it's running.
 * If the daemon isn't running, this extension does nothing — no crash.
 *
 * The daemon runs `braid-os/observatory-daemon.ts` which starts the WebSocket
 * server on port 4199 for the three.js frontend at observatory/index.html.
 *
 * Architecture:
 *   braid-daemon.sh ──→ observatory-daemon (WebSocket server, port 4199)
 *                          ↑
 *   pi instance ──→ observatory extension (thin client, push metrics)
 *                          ↑
 *                     Event Bus (turn_complete, timer_fire, etc.)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const log = createLogger("observatory");
const OBSERVATORY_PIDFILE = path.join(os.homedir(), ".pi-braid", "observatory.pid");

// ── Daemon detection ───────────────────────────────────────────────────

function isDaemonRunning(): boolean {
  try {
    if (!fs.existsSync(OBSERVATORY_PIDFILE)) return false;
    const pid = parseInt(fs.readFileSync(OBSERVATORY_PIDFILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    // Send signal 0 to check if process exists (no actual signal sent)
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Clean up stale PID file
      fs.unlinkSync(OBSERVATORY_PIDFILE);
      return false;
    }
  } catch {
    return false;
  }
}

export default function observatoryExtension(pi: ExtensionAPI) {
  // ── Tool: /observatory ─────────────────────────────────────────────
  // Reports status of the singleton observatory daemon.

  pi.registerTool({
    name: "observatory",
    label: "Agent Observatory",
    description:
      "Agent Observatory — real-time monitoring dashboard. " +
      "Checks the singleton daemon status, or starts/stops it via braid-daemon.sh. " +
      "The daemon runs one WebSocket server on port 4199 shared by all pi instances. " +
      "Open observatory/index.html in a browser for the 3D visualization.",
    parameters: Type.Object({
      action: StringEnum(["status", "start", "stop", "restart"], {
        default: "status",
      }),
    }),
    execute: async (_toolCallId: string, params: { action?: string }): Promise<any> => {
      const action = params.action ?? "status";

      switch (action) {
        case "start": {
          const running = isDaemonRunning();
          if (running) {
            return {
              content: [{
                type: "text" as const,
                text: "✅ Observatory daemon already running on ws://localhost:4199\nOpen observatory/index.html in a browser.",
              }],
            };
          }
          // Try to start via shell
          try {
            const { execSync } = await import("node:child_process");
            execSync(`${process.cwd()}/braid-os/braid-daemon.sh observatory start`, {
              encoding: "utf-8",
              timeout: 5000,
            });
            return {
              content: [{
                type: "text" as const,
                text: "✅ Observatory daemon started. Run /observatory status to confirm.\nOpen observatory/index.html in a browser.",
              }],
            };
          } catch (e: any) {
            return {
              content: [{
                type: "text" as const,
                text: `❌ Failed to start observatory: ${e.message}\nRun: ./braid-os/braid-daemon.sh observatory start`,
              }],
            };
          }
        }
        case "stop": {
          try {
            const { execSync } = await import("node:child_process");
            execSync(`${process.cwd()}/braid-os/braid-daemon.sh observatory stop`, {
              encoding: "utf-8",
              timeout: 5000,
            });
            return {
              content: [{ type: "text" as const, text: "✅ Observatory daemon stopped." }],
            };
          } catch (e: any) {
            return {
              content: [{ type: "text" as const, text: `❌ Failed to stop: ${e.message}` }],
            };
          }
        }
        case "restart": {
          try {
            const { execSync } = await import("node:child_process");
            execSync(`${process.cwd()}/braid-os/braid-daemon.sh observatory stop`, {
              encoding: "utf-8",
              timeout: 5000,
            });
            execSync(`${process.cwd()}/braid-os/braid-daemon.sh observatory start`, {
              encoding: "utf-8",
              timeout: 5000,
            });
            return {
              content: [{
                type: "text" as const,
                text: "✅ Observatory daemon restarted on ws://localhost:4199",
              }],
            };
          } catch (e: any) {
            return {
              content: [{ type: "text" as const, text: `❌ Failed to restart: ${e.message}` }],
            };
          }
        }
        case "status":
        default: {
          if (isDaemonRunning()) {
            return {
              content: [{
                type: "text" as const,
                text: `✅ Observatory daemon is RUNNING\nPID: ${fs.readFileSync(OBSERVATORY_PIDFILE, "utf-8").trim()}\nWebSocket: ws://localhost:4199\nDashboard: observatory/index.html`,
              }],
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: "❌ Observatory daemon is NOT running.\nStart it: ./braid-os/braid-daemon.sh observatory start",
            }],
          };
        }
      }
    },
  });

  // ── Event: session_start ───────────────────────────────────────────
  // Check if daemon is running. If so, whisper availability.
  // Does NOT start any server itself — that's the daemon's job.

  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event: any, ctx: ExtensionContext) => {
    if (isDaemonRunning()) {
      log.info("Observatory daemon detected — monitoring available.");
      ctx.whisper?.(
        "📊 Observatory active: open observatory/index.html for real-time agent monitoring.",
        { category: "cognitive", priority: "low" },
      );
    } else {
      log.info("Observatory daemon not running — monitoring unavailable.");
    }
  });

  log.info("Observatory extension registered (client mode).");
}
