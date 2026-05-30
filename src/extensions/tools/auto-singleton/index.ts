/**
 * Auto-Singleton Watchdog Timer — Session Hang Recovery
 *
 * The agent arms a one-shot inactivity watchdog. On every tool_call and turn_end,
 * the deadline is renewed. If no activity occurs for the timeout period, the
 * watchdog fires — sending a steer with triggerTurn:true to wake the agent.
 *
 * After firing, the watchdog auto-cancels. The agent explicitly re-arms for
 * continued protection. This prevents feedback loops.
 *
 * Key properties:
 *   - Singleton: only one active watchdog per session
 *   - Polling-based: checks every 5s, independent of turn_end events
 *   - Auto-renew on tool_call / turn_end
 *   - One-shot: fires once, then deactivates
 *   - Agent-controlled: set, cancel, check status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { Type } from "typebox";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { TOOL_CALL, TURN_END } from "../../../lib/core/event-names.js";

const log = createLogger("auto-singleton");

// piRef at runtime is a full Pi instance with sendMessage, but ExtensionAPI
// doesn't expose it. Used for stale-reference detection only.
interface PiRefWithSendMessage {
  sendMessage?: (...args: unknown[]) => unknown;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes

// ── Watchdog Manager ─────────────────────────────────────────────────────────

interface _AutoSingletonState {
  active: boolean;
  timeoutMs: number;
  deadline: number; // renewed on each activity event
  message: string; // custom message delivered on fire
  fired: boolean; // true after fire — prevents double-fire
  lastRenewal: number; // timestamp of last activity
}

/**
 * WARNING: Module-level singleton state.
 *
 * If pi ever runs multiple sessions in one process, this state leaks between
 * sessions. Follows the same pattern as src/extensions/tools/timer/index.ts
 * (TimerManager) which has the same limitation.
 *
 * Full session-scoping via getExtensionState() is blocked by the polling loop
 * which doesn't have a stable ctx reference across ticks. The session_shutdown
 * handler in the extension calls stop() which resets state.
 */
class AutoSingletonManager {
  private active = false;
  private timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;
  private deadline = 0;
  private message = "";
  private fired = false;
  private lastRenewal = 0;

  private piRef: ExtensionAPI | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private piVersion = 0; // incremented on each start() to detect stale piRef

  /** Arm the watchdog. Replaces any existing one (singleton). */
  set(pi: ExtensionAPI, timeoutSeconds: number, message?: string): void {
    const clamped = Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, timeoutSeconds));
    this.timeoutMs = clamped * 1000;
    this.message = message ?? `No agent activity for ${clamped}s. Continue working or finalize.`;
    this.deadline = Date.now() + this.timeoutMs;
    this.lastRenewal = Date.now();
    this.active = true;
    this.fired = false;
    this.piRef = pi;

    log.info(
      `[auto-singleton] ARMED: timeout=${clamped}s, deadline=${new Date(this.deadline).toISOString()}`,
    );
  }

  /** Disarm the watchdog. */
  cancel(): void {
    if (this.active) {
      log.info(
        `[auto-singleton] CANCELLED by agent (was active for ${Math.round((Date.now() - this.lastRenewal) / 1000)}s)`,
      );
    }
    this.active = false;
    this.fired = false;
    this.deadline = 0;
  }

  /** Extend the deadline on agent activity. */
  renew(): void {
    if (!this.active || this.fired) return;
    this.deadline = Date.now() + this.timeoutMs;
    this.lastRenewal = Date.now();
  }

  /** Check current status. */
  status(): {
    active: boolean;
    deadline: number | null;
    fired: boolean;
    message: string;
    timeoutSeconds: number;
    lastActivityAgoMs: number;
  } {
    return {
      active: this.active,
      deadline: this.active ? this.deadline : null,
      fired: this.fired,
      message: this.message,
      timeoutSeconds: Math.round(this.timeoutMs / 1000),
      lastActivityAgoMs: this.active ? Date.now() - this.lastRenewal : 0,
    };
  }

  /** Register/update the pi reference on extension load. */
  registerPi(pi: ExtensionAPI): void {
    this.piRef = pi;
    this.piVersion++;
  }

  /** Start background polling — checks every POLL_INTERVAL_MS for expiry. */
  start(pi: ExtensionAPI): void {
    if (this.pollHandle) return;
    this.piRef = pi;
    this.piVersion++;
    this.pollHandle = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    log.info(`[auto-singleton] polling started (every ${POLL_INTERVAL_MS}ms)`);
  }

  /** Stop background polling. */
  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.active = false;
    this.fired = false;
    log.info(`[auto-singleton] polling stopped`);
  }

  /** Poll tick: check if watchdog should fire. */
  private tick(): void {
    if (!this.active || this.fired || !this.piRef) return;

    // piRef can go stale after session restart in same process. Guard by
    // checking that sendTrackedMessage would actually work. If piRef is
    // stale, cancel the watchdog silently rather than throwing mid-poll.
    if (typeof (this.piRef as unknown as PiRefWithSendMessage)?.sendMessage !== "function") {
      log.warn("[auto-singleton] piRef appears stale — disarming watchdog");
      this.active = false;
      return;
    }

    if (Date.now() >= this.deadline) {
      this.fire();
    }
  }

  /** Fire the watchdog: send steer, auto-cancel. */
  private fire(): void {
    if (this.fired) return; // Safety: prevent double-fire
    this.fired = true;
    this.active = false;

    const idleSeconds = Math.round((Date.now() - this.lastRenewal) / 1000);
    const fireMsg = `[auto-singleton] ${this.message} (idle ${idleSeconds}s)`;

    log.info(`[auto-singleton] FIRED: idle=${idleSeconds}s, msg="${this.message}"`);

    // Wake the agent
    if (this.piRef) {
      try {
        sendTrackedMessage(
          this.piRef,
          {
            customType: "auto-singleton",
            content: [{ type: "text" as const, text: fireMsg }],
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
          { type: "heartbeat", source: "auto-singleton/fire" },
        );
      } catch (err) {
        log.warn(`[auto-singleton] sendTrackedMessage failed (stale piRef?): ${err}`);
      }
    }

    log.info(
      `[auto-singleton] FIRED: fully expired (${idleSeconds}s idle, timeout was ${Math.round(this.timeoutMs / 1000)}s)`,
    );
  }
}

const manager = new AutoSingletonManager();

// ── Activation guard: prevent feedback loop from our own steer ───────────────
// When the auto-singleton fires, it sends a steer. The agent processes the
// steer, which generates tool_call events. We need those tool_call events
// to renew deadline of a *subsequent* watchdog, but NOT to renew when
// we've already fired. The `fired` flag in the manager handles this.

// ── Extension ────────────────────────────────────────────────────────────────

export default function autoSingletonExtension(pi: ExtensionAPI): void {
  // Keep piRef current across potential re-registrations
  manager.registerPi(pi);

  // ── auto_singleton_set ──────────────────────────────────────────────────
  pi.registerTool({
    name: "auto_singleton_set",
    label: "Auto Singleton Set",
    promptSnippet: "Arm inactivity watchdog for autonomous session recovery",
    description:
      "Arm a one-shot inactivity watchdog timer. Every tool_call and turn_end " +
      "renews the deadline. If no activity occurs for `timeout_seconds`, the watchdog " +
      "fires — delivering a steer to wake the agent. Only one watchdog can be active " +
      "at a time (calling this replaces any existing one). After firing, the watchdog " +
      "auto-cancels; re-arm explicitly for continued protection. " +
      "Use for: autonomous sessions, long-running builds, recovery from transient hangs.",
    parameters: Type.Object({
      timeout_seconds: Type.Number({
        minimum: MIN_TIMEOUT_SECONDS,
        maximum: MAX_TIMEOUT_SECONDS,
        default: DEFAULT_TIMEOUT_SECONDS,
        description: "Inactivity timeout (30-3600s, default 300)",
      }),
      message: Type.Optional(
        Type.String({
          description: "Custom message delivered on fire (default: generic wake-up)",
        }),
      ),
    }),
    execute: async (_id: string, params: any): Promise<any> => {
      const { timeout_seconds, message } = params ?? {};
      manager.set(pi, timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, message);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Auto-singleton armed for ${timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS}s inactivity. ` +
              `Will fire at ${new Date(Date.now() + (timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000).toLocaleTimeString()} ` +
              `if no activity detected. Use auto_singleton_cancel() to disarm.`,
          },
        ],
        details: {
          active: true,
          timeout_seconds: timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
          deadline: new Date(
            Date.now() + (timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
          ).toISOString(),
        },
      };
    },
  });

  // ── auto_singleton_cancel ───────────────────────────────────────────────
  pi.registerTool({
    name: "auto_singleton_cancel",
    label: "Auto Singleton Cancel",
    promptSnippet: "Disarm the inactivity watchdog",
    description:
      "Disarm the auto-singleton inactivity watchdog. Safe to call when no watchdog is active.",
    parameters: Type.Object({}),
    execute: async (): Promise<any> => {
      const wasActive = manager.status().active;
      manager.cancel();
      return {
        content: [
          {
            type: "text" as const,
            text: wasActive
              ? "Auto-singleton watchdog disarmed."
              : "No auto-singleton watchdog was active.",
          },
        ],
        details: { cancelled: wasActive, active: false },
      };
    },
  });

  // ── auto_singleton_status ─────────────────────────────────────────────────
  pi.registerTool({
    name: "auto_singleton_status",
    label: "Auto Singleton Status",
    promptSnippet: "Check inactivity watchdog status",
    description:
      "Check whether the auto-singleton inactivity watchdog is active, how long until expiry, and whether it has fired.",
    parameters: Type.Object({}),
    execute: async (): Promise<any> => {
      const s = manager.status();
      if (!s.active) {
        const fireNote = s.fired
          ? " Watchdog has fired (re-arm with auto_singleton_set to continue)."
          : "";
        return {
          content: [
            { type: "text" as const, text: `No active auto-singleton watchdog.${fireNote}` },
          ],
          details: { active: false, fired: s.fired },
        };
      }
      const remaining = Math.max(0, Math.ceil((s.deadline! - Date.now()) / 1000));
      const lastActivity =
        s.lastActivityAgoMs < 1000 ? "just now" : `${Math.round(s.lastActivityAgoMs / 1000)}s ago`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Auto-singleton: active, fires in ${remaining}s if idle. Last activity: ${lastActivity}. Timeout: ${s.timeoutSeconds}s.`,
          },
        ],
        details: {
          active: true,
          fired: false,
          remaining_seconds: remaining,
          timeout_seconds: s.timeoutSeconds,
          last_activity_ago_ms: s.lastActivityAgoMs,
        },
      };
    },
  });

  // ── Event hooks: renew deadline on agent activity ──────────────────────────

  pi.on(TOOL_CALL, () => {
    manager.renew();
  });

  pi.on("tool_result", () => {
    manager.renew();
  });

  pi.on(TURN_END, () => {
    manager.renew();
  });

  // ── Cleanup on session end ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    manager.stop();
  });

  // ── Start polling ─────────────────────────────────────────────────────────

  manager.start(pi);

  log.info(
    "[auto-singleton] loaded: auto_singleton_set, auto_singleton_cancel, auto_singleton_status",
  );
}
