/**
 * Analytics Extension - self-contained tool usage analytics.
 *
 * Tracks tool call counts, durations, success/failure rates,
 * tool sequences and patterns, session-level metrics, and
 * A/B experiment variant tracking.
 *
 * State is session-scoped via getExtensionState to prevent
 * cross-session contamination.
 */

import { createLogger } from "../../../lib/core/logger.js";
import { resetCriticStats } from "../../../lib/ai/critic-stats.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { existsSync, mkdirSync } from "node:fs";
import { METRICS_FILE, METRICS_DIR } from "../../../lib/config/braid-paths.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeSessionManagerTyped } from "../../../lib/state/extension-state.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { isDegraded, getDegradationReasons } from "../../../lib/detection/degradation-detector.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { pushBounded } from "../../../lib/utils/bounded.js";
import { areCognitiveNudgesDisabled } from "../../../lib/config/braid-settings.js";
// Self-measurement: consume round-21t counters in the degradation
// whisper. Both formatters return null when nothing loss-worthy; they are the
// canonical one-liners context_inspect already uses (handlers/shared.ts
// formatCompactionLossLine + lib/telemetry/drift-signals formatDriftLine) — the
// formatting logic is NOT duplicated here. Importing from
// context-manager/handlers/shared pulls pruning.ts (logger + dedup only, no
// heartbeat/analytics back-reference — verified no cycle).
import { formatCompactionLossLine } from "../../../extensions/memory/context-manager/handlers/shared.js";
import { formatDriftLine } from "../../../lib/telemetry/drift-signals.js";

import { getAnalyticsStateInternal } from "./shared.js";
import { formatABResults } from "./ab-variant.js";

import { recordError, recordToolSuccess } from "../../../lib/detection/degradation-detector.js";

export { updateContextDensity, getAnalyticsState } from "./shared.js";

import { recordToolCall, flushAnalytics } from "./core.js";
import { formatCurrentSession, formatAllSessions } from "./format.js";
import {
  TURN_END,
  TOOL_EXECUTION_START,
  TOOL_EXECUTION_END,
  SESSION_SHUTDOWN,
} from "../../../lib/core/event-names.js";

const log = createLogger("analytics");

export default function analyticsExtension(pi: ExtensionAPI) {
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    resetCriticStats();
    const state = getAnalyticsStateInternal(ctx);
    const sm = safeSessionManagerTyped(ctx);
    state.sessionId = sm
      ? (sm.getSessionFile?.() ?? `session-${Date.now()}`)
      : `session-${Date.now()}`;
    state.sessionStartTime = Date.now();
    state.toolMetrics.clear();
    state.toolCallSequence = [];
    state.totalToolCallsRecorded = 0;
    state.turnToolSequence = [];
    state.turnToolCallsTotal = 0;
    state.wasDegraded = false;
    state.nudgesSent = 0;
    state.nudgesSuppressed = 0;
    state.storagePath = METRICS_FILE;

    if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });
  });

  pi.on(TOOL_EXECUTION_START, async (event, ctx) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      // PendingToolCalls leaks when tool_execution_end never fires
      // (aborted tools). Defensive prune: cap at 100, drop the oldest —
      // entries older than a few minutes are dead by definition.
      if (state.pendingToolCalls.size > 100) {
        const drop = state.pendingToolCalls.size - 100;
        let dropped = 0;
        for (const key of state.pendingToolCalls.keys()) {
          if (dropped++ >= drop) break;
          state.pendingToolCalls.delete(key);
        }
      }
      state.pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        startTime: Date.now(),
      });
    } catch (err) {
      log.warn(`[analytics] Could not track tool start: ${err}`);
    }
  });

  pi.on(TOOL_EXECUTION_END, async (event, ctx) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      const pending = state.pendingToolCalls.get(event.toolCallId);
      if (pending) {
        const success = !event.isError;
        recordToolCall(state, pending.toolName, Date.now() - pending.startTime, success);
        // Feed degradation detector
        if (success) {
          recordToolSuccess(ctx);
        } else {
          recordError(ctx);
        }
        // Track tool type for per-turn deduplication in addiction detection
        state.currentTurnTypes.add(pending.toolName);
        state.pendingToolCalls.delete(event.toolCallId);
      }
    } catch (err) {
      log.error("[analytics-tool-exec-end] error:", err);
    }
  });

  // turn_end: addiction detection + degradation
  pi.on(TURN_END, async (_event: any, ctx: any) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      state.localTurnCount++;

      // Flush per-turn deduplicated tool types into turnToolSequence
      // Defensive: currentTurnTypes may be missing if getExtensionState
      // returns a state from a stale-ctx WeakMap bucket that wasn't
      // initialized through createAnalyticsState.
      if (state.currentTurnTypes) {
        for (const tool of state.currentTurnTypes) {
          // Ring capped at the 50-event addiction window — the
          // detector's slice(-50) window IS the cap, so at the boundary the
          // window still sees every event it needs (behavior-neutral).
          // Gating uses turnToolCallsTotal (exact monotonic counter) since
          // a capped array's length plateaus.
          pushBounded(state.turnToolSequence, tool, 50);
          state.turnToolCallsTotal++;
        }
      }
      state.currentTurnTypes.clear();

      // Addiction check using per-turn deduplicated sequence (turnToolSequence)
      // This prevents multi-call turns (e.g., 3 bash + 1 read) from skewing ratios.
      //
      // CONSOLIDATION: this detector is the SECOND, more-sensitive
      // loop detector (enforcement tool-loop-detector.ts is the canonical one).
      // It produced false positives like `bash (34/50, 68%)` during legitimate
      // heavy single-tool research. Two guards now reduce noise to true
      // addiction: (1) intentional-use filtering — if the agent is thinking,
      // verifying, or finalizing within the window it is NOT stuck, so skip;
      // (2) a much higher dominance bar (ratio > 0.8 AND toolN <= 2, or ratio
      // > 0.5 with > 6x the equal-share average instead of > 4x).
      const turnCalls = state?.turnToolCallsTotal ?? 0;
      if (turnCalls >= 10 && turnCalls - state.lastAddictionCheck >= 10) {
        state.lastAddictionCheck = turnCalls;
        const window = state.turnToolSequence.slice(-50);

        // Intentional-use filtering: skip if the agent is self-reflecting within
        // the window. A window that includes think/verify/finalize/memory/scratchpad
        // means the agent is metacognitively engaged, not stuck in a loop.
        const INTENTIONAL_TOOLS = new Set([
          "think",
          "verify",
          "verify_claim",
          "finalize",
          "hypothesize",
          "scratchpad",
          "memory",
          "memory_store",
          "repl",
        ]);
        const hasIntentionalUse = window.some((t) => INTENTIONAL_TOOLS.has(t));
        if (hasIntentionalUse) {
          log.debug(
            `[analytics] Skipping addiction check: intentional tools in window (${window
              .filter((t) => INTENTIONAL_TOOLS.has(t))
              .join(",")})`,
          );
        } else {
          const counts = new Map<string, number>();
          for (const t of window) counts.set(t, (counts.get(t) ?? 0) + 1);
          const total = window.length;
          const warnings: string[] = [];
          for (const [tool, count] of counts) {
            const ratio = count / total;
            const toolN = counts.size;
            if (tool === "read") continue;
            const equalShare = total / Math.max(toolN, 1);
            // True addiction: one tool dominates > 80% with at most 2 tools, OR
            // > 50% share AND > 6x its equal share (was 4x — cut false 38-68%
            // "dominance" flags on legit research sessions).
            if (
              (ratio > 0.8 && toolN <= 2) ||
              (toolN > 1 && ratio > 0.5 && count > equalShare * 6)
            ) {
              warnings.push(`${tool} (${count}/${total} tool-turns, ${(ratio * 100).toFixed(0)}%)`);
            }
          }
          if (warnings.length > 0) {
            const signature = warnings.sort().join("|");
            if (state.lastAddictionSignatures.includes(signature)) {
              log.debug("[analytics] Skipping duplicate addiction warning:", signature);
            } else {
              state.lastAddictionSignatures.push(signature);
              // Keep last 3 signatures to bound memory (stale = 1 full window refresh)
              if (state.lastAddictionSignatures.length > 3) state.lastAddictionSignatures.shift();

              emitSignal(ctx, "tool-use", "overuse", "warn", false, {
                tools: warnings,
                windowSize: total,
              });
              // BPE recommendation handled by enforcement - no duplicate here
              // loop/addiction whisper FOLDED
              // The enforcement tool-loop detector (lib/detection/tool-loop-detector.ts)
              // is the ONE authoritative loop/addiction whisper emitter. This
              // `[analytics] Tool addiction` whisper was a third emitter for the same
              // stuck-loop signal class — the benchmark measured 332 deliveries
              // duplicating turn-outcome's 73 + enforcement's 11 (416 for one signal).
              // It is folded: detection, the BPE/MARS signal (emitSignal), and the
              // event-bus alert below are preserved observation-only; the whisper is
              // NOT delivered. Per-episode single delivery is guaranteed by the
              // surviving detector's own cooldown/dedupe (markLoopFired +
              // TOOL_LOOP_COOLDOWN_TURNS) and its triggerTurn:false guard means the
              // fold never wakes the agent. The intentional-use filtering above stays
              // as the lesson (think/verify/finalize in the window = not stuck).
              log.debug(
                `[analytics] Tool addiction warning folded into enforcement tool-loop detector: ${signature}`,
              );
              try {
                eventBus.emit({
                  type: "analytics_alert",
                  alertType: "addiction",
                  severity: "warn",
                  message: `Tool addiction pattern detected: ${warnings.join("; ")}`,
                  data: { tools: warnings, windowSize: total },
                  turn: state.localTurnCount,
                  timestamp: Date.now(),
                });
              } catch (err) {
                log.warn(`[analytics] Could not emit addiction signal: ${err}`);
              }
            }
          }
        }
      }

      // Degradation detection - CRITICAL: stability decline, use triggerTurn
      const degraded = isDegraded(ctx);
      if (degraded && !state.wasDegraded) {
        state.wasDegraded = true;
        const reasons = getDegradationReasons(ctx);

        // Self-measurement: surface compaction loss + drift signals
        // in the degradation report so the whisper explains WHY beyond raw error
        // count. Both formatters return null when nothing loss-worthy — behavior
        // is then byte-identical to before (no extra text, no data keys added).
        const compactionLossLine = formatCompactionLossLine();
        const driftLine = formatDriftLine();
        const selfMeasure = [compactionLossLine, driftLine].filter((l): l is string => l !== null);
        const signalData: Record<string, unknown> = {
          reason: reasons[0] ?? "degraded",
          consecutiveErrors: 3,
        };
        if (compactionLossLine) signalData.compactionLoss = compactionLossLine;
        if (driftLine) signalData.drift = driftLine;
        const detailSuffix = selfMeasure.length > 0 ? ` (${selfMeasure.join("; ")})` : "";
        const messageText = `Degradation detected: ${reasons.join("; ")}${detailSuffix}`;

        emitSignal(ctx, "stability", "decline", "critical", false, signalData);
        // Degradation whisper FOLDED
        // self/auto-recovery/index.ts:79 is the single actionable degradation
        // emitter (steer + triggerTurn:true, recommended actions). This
        // turn_end duplicate is folded: emitSignal + the event-bus alert below
        // are preserved observation-only; the whisper is NOT delivered
        // (whisper-REVIEW §4.3).
        log.debug(
          `[analytics] Degradation warning folded into auto-recovery (whisper-REVIEW §4.3): ${messageText}`,
        );
        try {
          eventBus.emit({
            type: "analytics_alert",
            alertType: "degradation",
            severity: "critical",
            message: messageText,
            data: {
              reasons,
              consecutiveErrors: 3,
              ...(compactionLossLine ? { compactionLoss: compactionLossLine } : {}),
              ...(driftLine ? { drift: driftLine } : {}),
            },
            turn: state.localTurnCount,
            timestamp: Date.now(),
          });
        } catch (err) {
          log.warn(`[analytics] Could not emit degradation alert: ${err}`);
        }
      } else if (!degraded && state.wasDegraded) {
        state.wasDegraded = false;
        if (areCognitiveNudgesDisabled()) {
          log.debug("[analytics] Recovery notification suppressed via braid.suppressNudges=true");
        } else {
          // Recovery notification - informational, use hint
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              content: [{ type: "text", text: "Performance recovered to healthy." }],
              display: true,
            },
            { delivery: "park", deliverAs: "steer" },
            { type: "heartbeat", source: "heartbeat/analytics/recover" },
          );
        }
        try {
          eventBus.emit({
            type: "analytics_alert",
            alertType: "recovery",
            severity: "info",
            message: "Performance recovered to healthy.",
            turn: state.localTurnCount,
            timestamp: Date.now(),
          });
        } catch (err) {
          log.warn(`[analytics] Could not emit recovery signal: ${err}`);
        }
      }
    } catch (err) {
      log.error("[analytics-turn-end] error:", err);
    }
  });

  pi.on(SESSION_SHUTDOWN, async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    if (state.toolCallSequence.length > 0) flushAnalytics(state, false);
  });

  pi.registerCommand("analytics", {
    description: "Show tool analytics for the current session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatCurrentSession(getAnalyticsStateInternal(ctx)), "info");
    },
  });
  pi.registerCommand("analytics:all", {
    description: "Show tool analytics across all historical sessions",
    handler: async (_args, _ctx) => {
      _ctx.ui.notify(formatAllSessions(), "info");
    },
  });
  // The A/B variant is set through the tool below, not a slash command, so
  // the agent can set its own variant without a human-typed command.
  pi.registerCommand("analytics:ab", {
    description: "Show A/B experiment results across variants",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatABResults(), "info");
    },
  });

  // No agent-callable observability tools here (session metrics / tool
  // reliability): the agent rarely needs self-observability and no internal
  // caller used them. Background tracking (toolMetrics, sessionStartTime)
  // still runs and feeds event-bus alerts and the analytics:all command; the
  // A/B variant is set programmatically via
  // getAnalyticsStateInternal(ctx).abVariant.
}
