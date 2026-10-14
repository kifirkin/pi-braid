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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCmState, log, buildContinuationSummary, triggerEmergencyRotation } from "./shared.js";
import { getRotationState } from "../../../../lib/state/global-state.js";
import type { RotationState } from "../../../../lib/state/global-state.js";
import {
  sendTrackedMessage,
  hasUnresolvedAdvisory,
} from "../../../../lib/utils/injection-tracker.js";
import {
  tryRestoreAppendMessage,
  clearInterceptState,
  flushPendingOwnerInputs,
  clearOwnerInputSeats,
} from "./compaction.js";
import { TURN_END, SESSION_SHUTDOWN } from "../../../../lib/core/event-names.js";
import {
  MAX_SESSION_AGE_MS,
  NUDGE_COOLDOWN_TURNS,
  NUDGE_COOLDOWN_MS,
} from "../../../../lib/constants/session-thresholds.js";

const MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TURNS_SINCE_ROTATION = 500; // 500 turns

// Advisory kind for the in-flight registry (injection-tracker). One size
// notice in flight at a time: a second one would queue behind the first on
// pi's delivery lane and land after the work it asks for.
const ROTATION_ADVISORY = "rotation";

// Rotation state provided by global-state.ts (Symbol-keyed, DRY)
function _sessionRotationState(): RotationState {
  return getRotationState();
}

function estimateSessionSize(ctx: ExtensionContext): number {
  try {
    const sm = ctx.sessionManager as {
      sessionFile?: string;
      getSessionFile?(): string | undefined;
      getBranch?(): Array<unknown>;
    };
    const filePath = sm.sessionFile ?? sm.getSessionFile?.();
    if (filePath) {
      const stat = statSync(filePath);
      return stat.size;
    }
    // Fallback: estimate from branch length
    const branch = sm.getBranch?.() ?? [];
    return branch.length * 2000; // rough estimate: 2KB per entry
  } catch {
    return 0;
  }
}

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
    // Grace period expired - reset actionTaken so nudges can resume if still needed
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

export function registerRotationHandlers(pi: ExtensionAPI): void {
  pi.on(TURN_END, async (_event: any, ctx: ExtensionContext) => {
    try {
      const state = _sessionRotationState();
      state.turnsSinceRotation++;

      const { needed, reason } = shouldRotate(ctx);

      if (!needed) return;

      // NUDGE DEDUPLICATION: suppress duplicate nudges within cooldown
      const currentTurn = state.turnsSinceRotation;

      // If we already nudged this turn, skip (prevents rapid-fire during single turn)
      // Deep-branch whisper to the agent (if needed). Fires BEFORE the
      // rotation-nudge check so a deep branch always gets a whisper,
      // independent of whether the session also needs rotation. The
      // throttle (NUDGE_COOLDOWN_TURNS / NUDGE_COOLDOWN_MS) keeps it to
      // one whisper per cooldown period — a per-turn log.warn would spam
      // the operator console on a deep branch. The advice is for the agent
      // (use context_tag / context_compress / finalize) so it goes
      // through sendTrackedMessage.
      try {
        const sm = ctx.sessionManager as { getBranch?(): unknown[] };
        const branch = sm.getBranch?.() ?? [];
        if (branch.length > 150) {
          const timeSinceDeepBranchWhisper = state.lastDeepBranchWhisperTimestamp
            ? Date.now() - state.lastDeepBranchWhisperTimestamp
            : Infinity;
          if (
            state.lastDeepBranchWhisperTurn !== currentTurn &&
            (currentTurn - state.lastDeepBranchWhisperTurn >= NUDGE_COOLDOWN_TURNS ||
              timeSinceDeepBranchWhisper >= NUDGE_COOLDOWN_MS)
          ) {
            state.lastDeepBranchWhisperTurn = currentTurn;
            state.lastDeepBranchWhisperTimestamp = Date.now();
            try {
              sendTrackedMessage(
                pi,
                {
                  customType: "context",
                  display: true,
                  content: [
                    {
                      type: "text" as const,
                      text: [
                        "## Session Branch Depth Notice",
                        "",
                        `The current branch is ${branch.length} entries deep. Deep branches can slow down context operations.`,
                        "",
                        "To keep the session manageable:",
                        "1. **`context_navigate(action='tag')`** - mark a checkpoint before continuing on a long thread",
                        "2. **`context_compress`** - compress completed work mid-session",
                        "3. **`finalize()`** - when done with current work; rotates session with summary",
                        "",
                        "These are non-urgent suggestions - take them when natural in your workflow.",
                      ].join("\n"),
                    },
                  ],
                },
                { delivery: "park", deliverAs: "followUp" },
                { type: "context", source: "context-manager/deep-branch" },
              );
            } catch (err) {
              log.error("deep-branch whisper failed:", err);
            }
          }
        }
      } catch {
        // Nudge bookkeeping reads optional enforcement state; without it the
        // deep-branch enhancement is skipped and the base nudge path runs.
      }

      if (state.lastNudgeTurn === currentTurn) return;

      // Suppress nudge if: not enough turns passed (<50) AND too soon since last nudge (<5 min)
      const timeSinceNudge = state.lastNudgeTimestamp
        ? Date.now() - state.lastNudgeTimestamp
        : Infinity;
      const turnsSinceNudge = currentTurn - state.lastNudgeTurn;
      if (turnsSinceNudge < NUDGE_COOLDOWN_TURNS && timeSinceNudge < NUDGE_COOLDOWN_MS) {
        log.debug(
          `Nudge suppressed: ${turnsSinceNudge} turns, ${Math.round(timeSinceNudge / 1000)}s since last`,
        );
        return;
      }

      // Refuse to stack: while an earlier notice is still in flight (handed
      // to pi but not yet appended), a second notice would queue behind it
      // and arrive after the work it asks for. Leave the nudge state
      // untouched so the emission retries at the next `turn_end` once the
      // first one lands; the cooldown above still paces retries.
      if (hasUnresolvedAdvisory(ROTATION_ADVISORY)) {
        log.debug("Rotation nudge skipped: a previous notice is still in flight");
        return;
      }

      state.lastNudgeTurn = currentTurn;
      state.lastNudgeTimestamp = Date.now();
      state.nudgeCount++;
      state.actionTaken = false; // reset for next cycle

      log.info(`Session rotation nudge #${state.nudgeCount}: ${reason}`);

      state.continuationSummary = buildContinuationSummary(ctx);
      state.pendingRotation = true;

      // Off the run-stop lane while a run is streaming. `followUp` drains
      // one message per run stop, so a notice queued there waits for the
      // agent to stop - the measured median was 12 minutes, and 15 of 24
      // notices landed after the agent had already taken the action they
      // asked for. While streaming, park it: pi-core flushes parked
      // messages at the same `turn_end`, after handler dispatch. When the
      // session is idle, keep the wake - a parked notice would never start
      // a turn. `ctx.isIdle()` is probed at the same moment pi-core reads
      // its own `isStreaming`; a race lands in a branch that either parks or
      // appends, both safe, and the wake gate covers the pre-flight window.
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      const deliveryOptions = idle
        ? { triggerTurn: true }
        : { delivery: "park" as const, deliverAs: "steer" };

      // Notify agent - ONCE - with identity-framed language (not compliance directives)
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
                "1. **`finalize()`** - when done with current work; rotates session with summary",
                "2. **`context_compress(action='archive', startIndex, endIndex, topic, summary)`** - archive completed work mid-session",
                "3. **`memory_store(...)`** - preserve critical facts before compression",
                "",
                "If this stamp predates your last `context_compress`/`finalize`, this notice is already satisfied; ignore it.",
                "",
                "Taking any of these actions will reset the session counter for 25 turns.",
              ].join("\n"),
            },
          ],
        },
        deliveryOptions,
        { type: "context", source: "context-manager/rotation", advisory: ROTATION_ADVISORY },
      );
    } catch (err) {
      log.error("turn_end rotation check error:", err);
    }
  });

  pi.on("tool_result", async (event: any, _ctx: ExtensionContext) => {
    try {
      if (!event?.toolName) return;
      const state = _sessionRotationState();
      const contextTools = new Set([
        "memory_store",
        "context_navigate",
        "context_compress",
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

  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    try {
      if (event?.toolName !== "finalize") return;

      const state = _sessionRotationState();
      if (!state.pendingRotation) return;

      // Rotation triggered by finalize - task boundary detected
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
                "## [..] Session Rotated",
                "",
                `Rotation #${state.rotationCount} completed at task boundary.`,
                "Key context has been preserved in memory stores.",
                "Use the `memory` tool to retrieve relevant context.",
              ].join("\n"),
            },
          ],
          display: true,
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "context", source: "context-manager/rotation" },
      );
    } catch (err) {
      log.error("tool_end rotation error:", err);
    }
  });
}

// Cleans up retry guards and compaction state when session ends.
// Prevents stale state from leaking between sessions.

export function registerSessionShutdownHandler(pi: ExtensionAPI): void {
  pi.on(SESSION_SHUTDOWN, async (_event: unknown, ctx: ExtensionContext) => {
    log.debug("Session shutdown: clearing compaction retry state and intercept");
    const cmState = getCmState(ctx);
    cmState.compactionRetryActive = false;
    cmState.overflowRetryActive = false;

    // CRITICAL: Clear intercept state to prevent stale intercept on next session.
    // The intercept was set up during compaction. If session ends without
    // proper cleanup (e.g., crash, force quit), the intercept could remain
    // active in the new session.
    // A seat still undelivered at shutdown is written into the session before
    // the bookkeeping goes: the durable entry survives either way, but the
    // session entry is what a resumed branch replays.
    flushPendingOwnerInputs(ctx, "shutdown");
    tryRestoreAppendMessage(ctx);
    clearInterceptState(ctx);
    clearOwnerInputSeats(ctx);
  });
}

// Export for use in compaction retry guard
export { triggerEmergencyRotation, buildContinuationSummary };
