// ── Session Rotation Handler ─────────────────────────────────────────────────
// Smart session file rotation for long-running daemon sessions.
// Prevents unbounded session file growth by rotating based on size + task boundaries.
//
// Rotation strategies:
// 1. Size-based: rotate when session file > MAX_SESSION_SIZE_BYTES
// 2. Task-based: rotate after finalize() call (task boundary detected)
// 3. Time-based: rotate after MAX_SESSION_AGE_MS since last rotation
//
// State preservation across rotations:
// - Tags/checkpoints are preserved in the new session
// - Memory stores (episodic, heuristics, tool reliability) survive via three-memory-stores
// - Key context is carried forward as a "continuation summary"

import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCmState } from "./shared.js";
import { log } from "./shared.js";
import { getRotationState } from "../../../../lib/global-state.js";
import type { RotationState } from "../../../../lib/global-state.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { tryRestoreAppendMessage, clearInterceptState } from "./compaction.js";

// ── Rotation configuration ───────────────────────────────────────────────────
const MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TURNS_SINCE_ROTATION = 500; // 500 turns

// Rotation state provided by global-state.ts (Symbol-keyed, DRY)
function _sessionRotationState(): RotationState {
  return getRotationState();
}

// ── Size estimation ──────────────────────────────────────────────────────────
function estimateSessionSize(ctx: ExtensionContext): number {
  try {
    const sm = ctx.sessionManager as {
      session?: { filePath?: string };
      getBranch?(): Array<unknown>;
    };
    if (sm.session?.filePath) {
      const stat = statSync(sm.session.filePath);
      return stat.size;
    }
    // Fallback: estimate from branch length
    const branch = sm.getBranch?.() ?? [];
    return branch.length * 2000; // rough estimate: 2KB per entry
  } catch {
    return 0;
  }
}

// ── Rotation check ───────────────────────────────────────────────────────────
function shouldRotate(ctx: ExtensionContext): { needed: boolean; reason: string } {
  const state = _sessionRotationState();
  const size = estimateSessionSize(ctx);
  const age = Date.now() - state.lastRotationTimestamp;

  // If the agent recently took context-preserving action, suppress nudges for a grace period
  // (25 turns / ~5 min) to avoid spam during legitimate long tasks.
  if (state.actionTaken) {
    const turnsSinceAction = state.turnsSinceRotation - state.actionTakenAtTurn;
    if (turnsSinceAction < 25) {
      log.debug(
        `Rotation nudge suppressed: actionTaken=true, grace period (${turnsSinceAction}/25 turns since action)`,
      );
      return { needed: false, reason: "" };
    }
    // Grace period expired — reset actionTaken so nudges can resume if still needed
    state.actionTaken = false;
  }

  if (size > MAX_SESSION_SIZE_BYTES) {
    return {
      needed: true,
      reason: `Session file ${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(MAX_SESSION_SIZE_BYTES / 1024 / 1024)}MB limit`,
    };
  }
  if (state.turnsSinceRotation > MAX_TURNS_SINCE_ROTATION) {
    return {
      needed: true,
      reason: `${state.turnsSinceRotation} turns since last rotation (limit: ${MAX_TURNS_SINCE_ROTATION})`,
    };
  }
  if (age > MAX_SESSION_AGE_MS) {
    return {
      needed: true,
      reason: `Session age ${Math.round(age / 86400000)}d exceeds ${Math.round(MAX_SESSION_AGE_MS / 86400000)}d limit`,
    };
  }
  return { needed: false, reason: "" };
}

// ── Build continuation summary ───────────────────────────────────────────────
function buildContinuationSummary(ctx: ExtensionContext): string {
  try {
    const sm = ctx.sessionManager as {
      getBranch?(): Array<{
        id: string;
        type?: string;
        message?: { role?: string; content?: string | Array<{ text?: string }> };
      }>;
      getLabel?(id: string): string | undefined;
    };
    const branch = sm.getBranch?.() ?? [];
    const tags: string[] = [];

    // Collect all tags
    for (const entry of branch) {
      const label = sm.getLabel?.(entry.id);
      if (label) tags.push(label);
    }

    const lines: string[] = [
      "## Session Continuation",
      "",
      "This session continues from a previous session that was rotated.",
      "",
      `Previous session: ${branch.length} entries, ${tags.length} tags`,
    ];

    if (tags.length > 0) {
      lines.push(`Tags preserved: ${tags.join(", ")}`);
    }

    // Find the most recent user messages to carry context
    const recentUserMessages: string[] = [];
    for (let i = branch.length - 1; i >= Math.max(0, branch.length - 5); i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "user") {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : (entry.message.content?.[0]?.text ?? "");
        if (text) recentUserMessages.unshift(text.slice(0, 200));
      }
    }

    if (recentUserMessages.length > 0) {
      lines.push("", "Recent context:");
      for (const msg of recentUserMessages.slice(-3)) {
        lines.push(`- ${msg}`);
      }
    }

    lines.push("", "Use `memory_recall` to retrieve cross-session knowledge.");

    return lines.join("\n");
  } catch {
    return "Session continuation from rotated session. Use memory_recall for context.";
  }
}

// ── Emergency rotation trigger ─────────────────────────────────────────────
// Called when context overflow is imminent to force rotation before cascade
function triggerEmergencyRotation(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const state = _sessionRotationState();
    if (state.pendingRotation) {
      log.info("[Emergency] Rotation already pending, skipping duplicate trigger");
      return;
    }

    state.pendingRotation = true;
    state.emergencyRotation = true;
    state.continuationSummary = buildContinuationSummary(ctx);

    // Send immediate notification to agent
    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: [
              "## Session Rotation Required",
              "",
              "Context overflow detected. Automatic rotation triggered to prevent data loss.",
              "",
              "Please call `finalize()` to complete this task and start fresh.",
              "",
              "Rotation will happen automatically on next `finalize()`.",
            ].join("\n"),
          },
        ],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "context", source: "context-manager/rotation" },
    );

    log.info("[Emergency] Rotation triggered due to context overflow risk");
  } catch (err) {
    log.error("[Emergency] Rotation trigger failed:", err);
  }
}

// ── Register rotation handlers ───────────────────────────────────────────────
export function registerRotationHandlers(pi: ExtensionAPI): void {
  // Check rotation need on each turn_end
  pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
    try {
      const state = _sessionRotationState();
      state.turnsSinceRotation++;

      const { needed, reason } = shouldRotate(ctx);

      // Session tree auto-compaction: warn on deep branch
      try {
        const sm = ctx.sessionManager as any;
        const branch = sm.getBranch?.() ?? [];
        if (branch.length > 150) {
          log.warn(`Branch ${branch.length} entries deep — consider context_tag + session_compact`);
        }
      } catch {
        /* non-fatal */
      }

      if (!needed) return;

      // NUDGE DEDUPLICATION: suppress duplicate nudges within cooldown
      const currentTurn = state.turnsSinceRotation;

      // If we already nudged this turn, skip (prevents rapid-fire during single turn)
      if (state.lastNudgeTurn === currentTurn) return;

      // Suppress nudge if: not enough turns passed (<50) AND too soon since last nudge (<5 min)
      const timeSinceNudge = state.lastNudgeTimestamp
        ? Date.now() - state.lastNudgeTimestamp
        : Infinity;
      const turnsSinceNudge = currentTurn - state.lastNudgeTurn;
      if (turnsSinceNudge < 50 && timeSinceNudge < 5 * 60 * 1000) {
        log.debug(
          `Nudge suppressed: ${turnsSinceNudge} turns, ${Math.round(timeSinceNudge / 1000)}s since last`,
        );
        return;
      }

      // Track this nudge
      state.lastNudgeTurn = currentTurn;
      state.lastNudgeTimestamp = Date.now();
      state.nudgeCount++;
      state.actionTaken = false; // reset for next cycle

      log.info(`Session rotation nudge #${state.nudgeCount}: ${reason}`);

      // Build continuation summary before rotation
      state.continuationSummary = buildContinuationSummary(ctx);
      state.pendingRotation = true;

      // Notify agent — ONCE — with identity-framed language (not compliance directives)
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [
            {
              type: "text" as const,
              text: [
                "## Session Size Notice",
                "",
                reason,
                "",
                "The session has grown large. To keep working smoothly:",
                "1. **`finalize()`** — when done with current work; rotates session with summary",
                "2. **`context_archive(start, end, summary)`** — archive completed work mid-session",
                "3. **`memory_store(...)`** — preserve critical facts before compression",
                "",
                "Taking any of these actions will reset the session counter for 25 turns.",
              ].join("\n"),
            },
          ],
        },
        { deliverAs: "followUp", triggerTurn: true },
        { type: "context", source: "context-manager/rotation" },
      );
    } catch (err) {
      log.error("turn_end rotation check error:", err);
    }
  });

  // Track when agent takes rotation-relevant action
  pi.on("tool_result", async (event: any, _ctx: ExtensionContext) => {
    try {
      if (!event?.toolName) return;
      const state = _sessionRotationState();
      const contextTools = new Set([
        "memory_store",
        "context_tag",
        "context_archive",
        "scratchpad",
        "finalize",
      ]);
      if (contextTools.has(event.toolName)) {
        state.actionTaken = true;
        state.actionTakenAtTurn = state.turnsSinceRotation;
        log.info(`Rotation action recorded: ${event.toolName} at turn ${state.turnsSinceRotation}`);
      }
    } catch (err) {
      log.error("tool_end action tracking error:", err);
    }
  });

  // Trigger rotation on finalize
  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    try {
      if (event?.toolName !== "finalize") return;

      const state = _sessionRotationState();
      if (!state.pendingRotation) return;

      // Rotation triggered by finalize — task boundary detected
      state.pendingRotation = false;
      state.rotationCount++;
      state.lastRotationTimestamp = Date.now();
      state.turnsSinceRotation = 0;
      state.lastNudgeTurn = 0;
      state.lastNudgeTimestamp = 0;
      state.nudgeCount = 0;
      state.actionTaken = false;

      // Reset compaction retry guards to prevent stale state
      const cmState = getCmState(ctx);
      cmState.compactionRetryActive = false;
      cmState.overflowRetryActive = false;

      log.info(`Session rotation triggered at task boundary (rotation #${state.rotationCount})`);

      // Store continuation summary as memory for next session
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          content: [
            {
              type: "text" as const,
              text: [
                "## 🔄 Session Rotated",
                "",
                `Rotation #${state.rotationCount} completed at task boundary.`,
                "Key context has been preserved in memory stores.",
                "Use `memory_recall` to retrieve relevant context.",
              ].join("\n"),
            },
          ],
          display: true,
        },
        { deliverAs: "steer", triggerTurn: false },
        { type: "context", source: "context-manager/rotation" },
      );
    } catch (err) {
      log.error("tool_end rotation error:", err);
    }
  });
}

// ── Session Shutdown Cleanup ────────────────────────────────────────
// Cleans up retry guards and compaction state when session ends.
// Prevents stale state from leaking between sessions.

export function registerSessionShutdownHandler(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    log.debug("Session shutdown: clearing compaction retry state and intercept");
    const cmState = getCmState(ctx);
    cmState.compactionRetryActive = false;
    cmState.overflowRetryActive = false;

    // CRITICAL: Clear intercept state to prevent stale intercept on next session.
    // The intercept (_interceptActive, _origAppendMessage, etc.) was set up
    // during compaction. If session ends without proper cleanup (e.g., crash,
    // force quit), the intercept could remain active in the new session.
    tryRestoreAppendMessage(pi);
    clearInterceptState();
  });
}

// Export for use in compaction retry guard
export { triggerEmergencyRotation };
