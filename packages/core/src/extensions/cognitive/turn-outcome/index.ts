/**
 * Turn Outcome Classification - Repetitive Loop Detection (triple-critic)
 *
 * Detects when the agent is stuck in a repetitive loop using classify() with
 * CRITICS.toolLoopDetected. Three-tier fallback:
 *   Tier 1: toolLoopFallback (heuristic token/error repetition)
 *   Tier 2: utility model (if configured)
 *   Tier 3: session model (always available)
 *
 * When a loop is confirmed, sends a strategic steer suggesting a different
 * approach or re-plan. Only fires once per loop type per detection window.
 *
 * Replaces the previous implementation with three separate heuristic
 * functions (detectToolRepetition, detectErrorEcho, detectFileChurn)
 * - now consolidated into a single classify() call with structured history.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { classifyWithOffline } from "../../../lib/reasoning/classifier-offline.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { TURN_END } from "../../../lib/core/event-names.js";
import { toolLoopFallback } from "../../../lib/ai/critic-fallbacks.js";

const log = createLogger("turn-outcome");

const WINDOW_SIZE = 12; // Rolling window of recent turns
const LOOP_COOLDOWN_TURNS = 8; // Don't fire again for same loop within N turns

interface TurnOutcome {
  tools: string[]; // tool names used this turn
  errored: string[]; // tool names that errored this turn
}

interface LoopDetectionState {
  history: TurnOutcome[];
  lastFired: Record<string, number>;
}

const STATE_KEY = "turn-outcome";

function getState(ctx: ExtensionContext): LoopDetectionState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    history: [],
    lastFired: {},
  }));
}

// Detection Logic (single classify call)

/**
 * Detect if the agent is in a repetitive loop using triple-critic classification.
 *
 * Formats the recent turn history as a structured tool-sequence description
 * and passes it to classify() with CRITICS.toolLoopDetected.
 * The heuristic fallback (toolLoopFallback) handles the LLM-unavailable case.
 */
/**
 * Sentinel return value when the loop detector is offline (the LLM
 * classify() call failed at all tiers). Distinct from the null
 * "not in a loop" return so the consumer can branch on it.
 *
 * Same anti-pattern as topic-drift and sycophancy: when the classifier is
 * down, never silently default to "no problem."
 */
export const LOOP_DETECTOR_OFFLINE = "__loop_detector_offline__" as const;

async function detectLoop(
  state: LoopDetectionState,
  ctx: ExtensionContext,
): Promise<string | null> {
  if (state.history.length < 4) return null;

  const recent = state.history.slice(-7); // Last 7 turns

  const toolSequences = recent
    .map((t, i) => {
      const toolsStr = t.tools.map((name) => `\`${name}\``).join(", ");
      const errorsStr = t.errored.length > 0 ? ` [errors: ${t.errored.join(", ")}]` : "";
      return `Turn ${state.history.length - recent.length + i + 1}: ${toolsStr}${errorsStr}`;
    })
    .join("\n");

  let result: Awaited<ReturnType<typeof classifyWithOffline>> | null;
  try {
    // B-class: toolLoopFallback returns "no" by default (safe but
    // uninformative). tierPolicy: fallback-only downweights the
    // heuristic to 0.5 confidence so consumers can tell it's degraded.
    result = await classifyWithOffline(
      ctx,
      CRITICS.toolLoopDetected.criteria,
      { toolSequences: toolSequences.slice(0, 2000) },
      {
        timeoutMs: 60_000,
        label: CRITICS.toolLoopDetected.label,
        fallback: () => toolLoopFallback(toolSequences),
        tierPolicy: "fallback-only",
      },
    );

    if (result.value === "yes") {
      const lastTurnTools = recent[recent.length - 1]?.tools ?? [];
      return lastTurnTools.join(", ") || "unknown tools";
    }

    // Detect the "classifier failed" case. The LLM could not produce a
    // usable answer; the agent might be in a loop and we just can't
    // see it. Return the LOOP_DETECTOR_OFFLINE sentinel so the consumer
    // can emit a "detector offline" steer instead of the usual
    // "no loop detected" silent return.
    if (result.classifierDown) {
      log.warn(
        `[turn-outcome] Loop detector classifier unavailable ` +
          `(tier=failed, latency=${result.latencyMs}ms). Run /logs level info for details.`,
      );
      return LOOP_DETECTOR_OFFLINE;
    }
  } catch {
    // classifyWithOffline() handles errors internally
  }

  return null;
}

export default function turnOutcomeExtension(pi: ExtensionAPI): void {
  onEvent(pi, TURN_END, async (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);

    const results: Array<{ toolName: string; isError: boolean }> = event?.toolResults ?? [];
    const tools = results.map((r) => r.toolName).filter(Boolean);
    const errored = results
      .filter((r) => r.isError)
      .map((r) => r.toolName)
      .filter(Boolean);

    const outcome: TurnOutcome = { tools, errored };
    state.history.push(outcome);
    if (state.history.length > WINDOW_SIZE) {
      state.history.shift();
    }

    const details = await detectLoop(state, ctx);
    if (!details) return;

    // Handle the "loop detector offline" case. When the LLM classify()
    // call failed at all tiers, the agent might be in a loop but the
    // detector can't see it. Emit a softer "detector offline" steer
    // (no specific tool names, just the warning) so the agent knows
    // to be cautious. Cooldown still applies so we don't spam.
    if (details === LOOP_DETECTOR_OFFLINE) {
      const lastFiredOffline = state.lastFired["loop-detector-offline"] ?? 0;
      const currentTurnOffline = state.history.length;
      if (currentTurnOffline - lastFiredOffline < LOOP_COOLDOWN_TURNS) return;
      state.lastFired["loop-detector-offline"] = currentTurnOffline;

      log.info(`[turn-outcome] Loop detector offline; sending soft-warning steer`);
      const offlineMessage =
        `## Loop Detector Offline\n\n` +
        `The loop-detection classifier is unavailable this turn, so this check could not run normally. ` +
        `If you are in a repetitive loop, this extension cannot detect it. ` +
        `Please self-monitor: if you notice yourself calling the same tools with the same results ` +
        `for several turns, use \`think()\` to re-evaluate your approach, or consider \`context_compress(action="archive")\` ` +
        `to checkpoint your work.`;
      try {
        sendTrackedMessage(
          pi,
          {
            customType: "turn-outcome",
            content: [{ type: "text" as const, text: offlineMessage }],
            display: true,
          },
          { delivery: "live", deliverAs: "steer" },
          { type: "enforcement", source: "turn-outcome/loop-detector-offline" },
        );
      } catch {
        /* non-fatal */
      }
      return;
    }

    const lastFired = state.lastFired["tool-loop"] ?? 0;
    const currentTurn = state.history.length;
    if (currentTurn - lastFired < LOOP_COOLDOWN_TURNS) return;

    state.lastFired["tool-loop"] = currentTurn;

    // loop-detected whisper FOLDED
    // The enforcement tool-loop detector (lib/detection/tool-loop-detector.ts)
    // is the ONE authoritative loop/addiction whisper emitter. This
    // "Repetitive Loop Detected" steer was a second emitter for the same
    // stuck-loop signal class — the benchmark measured 73 deliveries,
    // and it used triggerTurn:true (it WOKE the agent on a loop, violating
    // the advisory no-wake rule). It is folded: the triple-critic detection
    // above still runs (history + classification), but no loop whisper is
    // delivered. Per-episode single delivery is guaranteed by the surviving
    // detector's cooldown/dedupe (markLoopFired + TOOL_LOOP_COOLDOWN_TURNS),
    // and the surviving emission is triggerTurn:false. Deliberately NOT
    // claiming the shared "loop" tryClaim category here: claiming would still
    // suppress the dreamer's independent advisory.
    log.info(
      `[turn-outcome] Loop detected but folded into enforcement tool-loop detector (no whisper): ${details}`,
    );
  });

  log.info("[turn-outcome] loaded: loop detection on turn_end (triple-critic)");
}
