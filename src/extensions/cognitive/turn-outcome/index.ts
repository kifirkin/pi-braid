/**
 * Turn Outcome Classification — Repetitive Loop Detection (triple-critic)
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
 * — now consolidated into a single classify() call with structured history.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { onEvent } from "../../../lib/events/event-types.js";

const log = createLogger("turn-outcome");

// ── Constants ────────────────────────────────────────────────────────────────

const WINDOW_SIZE = 12; // Rolling window of recent turns
const LOOP_COOLDOWN_TURNS = 8; // Don't fire again for same loop within N turns

// ── Types ────────────────────────────────────────────────────────────────────

interface TurnOutcome {
  tools: string[]; // tool names used this turn
  errored: string[]; // tool names that errored this turn
}

interface LoopDetectionState {
  history: TurnOutcome[];
  lastFired: Record<string, number>;
}

// ── State key ────────────────────────────────────────────────────────────────

const STATE_KEY = "turn-outcome";

function getState(ctx: ExtensionContext): LoopDetectionState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    history: [],
    lastFired: {},
  }));
}

// ── Detection Logic (single classify() call) ──────────────────────────────────

/**
 * Detect if the agent is in a repetitive loop using triple-critic classification.
 *
 * Formats the recent turn history as a structured tool-sequence description
 * and passes it to classify() with CRITICS.toolLoopDetected.
 * The heuristic fallback (toolLoopFallback) handles the LLM-unavailable case.
 */
async function detectLoop(state: LoopDetectionState, ctx: ExtensionContext): Promise<string | null> {
  if (state.history.length < 4) return null;

  const recent = state.history.slice(-7); // Last 7 turns

  // Format as structured tool sequences
  const toolSequences = recent
    .map((t, i) => {
      const toolsStr = t.tools.map((name) => `\`${name}\``).join(", ");
      const errorsStr = t.errored.length > 0 ? ` [errors: ${t.errored.join(", ")}]` : "";
      return `Turn ${state.history.length - recent.length + i + 1}: ${toolsStr}${errorsStr}`;
    })
    .join("\n");

  try {
    const result = await classify(
      ctx,
      CRITICS.toolLoopDetected.criteria,
      { toolSequences: toolSequences.slice(0, 2000) },
      {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => CRITICS.toolLoopFallback(toolSequences),
      },
    );

    if (result.label === "yes") {
      // Extract the repeating tools from the last turn
      const lastTurnTools = recent[recent.length - 1]?.tools ?? [];
      return lastTurnTools.join(", ") || "unknown tools";
    }
  } catch {
    // classify() handles errors internally
  }

  return null;
}

// ── Steer formatting ──────────────────────────────────────────────────────────

function formatSteerMessage(details: string): string {
  return (
    `## 🔄 Repetitive Loop Detected\n\n` +
    `- **Tool repetition**: Using \`${details}\` every turn for the last several turns. ` +
    `The outcome hasn't changed.\n\n` +
    `**Suggested actions:**\n` +
    `1. Use \`think()\` to re-evaluate your approach\n` +
    `2. Check if the problem has changed — you may be solving the wrong issue\n` +
    `3. Consider breaking the task into smaller steps\n` +
    `4. Use \`memory_recall\` to find past solutions to similar problems`
  );
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function turnOutcomeExtension(pi: ExtensionAPI): void {
  onEvent(pi, "turn_end", async (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);

    // Collect tool results from the turn
    const results: Array<{ toolName: string; isError: boolean }> = event?.toolResults ?? [];
    const tools = results.map((r) => r.toolName).filter(Boolean);
    const errored = results
      .filter((r) => r.isError)
      .map((r) => r.toolName)
      .filter(Boolean);

    // Record this turn
    const outcome: TurnOutcome = { tools, errored };
    state.history.push(outcome);
    if (state.history.length > WINDOW_SIZE) {
      state.history.shift();
    }

    // Detect loop via triple-critic
    const details = await detectLoop(state, ctx);
    if (!details) return;

    // Check cooldown
    const lastFired = state.lastFired["tool-loop"] ?? 0;
    const currentTurn = state.history.length;
    if (currentTurn - lastFired < LOOP_COOLDOWN_TURNS) return;

    state.lastFired["tool-loop"] = currentTurn;

    // Send steer
    const message = formatSteerMessage(details);
    log.info(`[turn-outcome] Loop detected: ${details}`);

    try {
      sendTrackedMessage(
        pi,
        {
          customType: "turn-outcome",
          content: [{ type: "text" as const, text: message }],
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
        { type: "enforcement", source: "turn-outcome/loop-detection" },
      );
    } catch {
      /* non-fatal */
    }
  });

  log.info("[turn-outcome] loaded: loop detection on turn_end (triple-critic)");
}