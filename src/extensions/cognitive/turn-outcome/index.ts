/**
 * Turn Outcome Classification — Repetitive Failure Loop Detection
 *
 * Detects when the agent is stuck in a repetitive loop with no real progress:
 *   - Same tool sequence for >= 4 consecutive turns
 *   - Same tool erroring for >= 3 consecutive turns
 *   - Same file being churned (edit/write) for >= 3 turns
 *
 * When a loop is confirmed, sends a strategic steer suggesting a different
 * approach or re-plan. Only fires once per loop type per detection window.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { FILE_CHURN_TOOLS } from "../../../lib/tool-constants.js";
import { onEvent } from "../../../lib/event-types.js";

const log = createLogger("turn-outcome");

// ── Constants ────────────────────────────────────────────────────────────────

const WINDOW_SIZE = 12; // Rolling window of recent turns
const TOOL_REPEAT_THRESHOLD = 4; // Same tool sequence for >= N turns
const ERROR_ECHO_THRESHOLD = 3; // Same tool error for >= N turns
const FILE_CHURN_THRESHOLD = 3; // Same file edit for >= N turns
const LOOP_COOLDOWN_TURNS = 8; // Don't fire for same loop type again within N turns

// ── Types ────────────────────────────────────────────────────────────────────

interface TurnOutcome {
  tools: string[]; // tool names used this turn
  erroredTools: string[]; // tools that errored
  fileTools: string[]; // tools that modified files (edit, write)
  hadProgress: boolean; // true if tool succeeded with no errors
}

interface LoopDetectionState {
  history: TurnOutcome[];
  lastFired: Record<string, number>; // loop_type → last turn it fired
}

// ── State key ────────────────────────────────────────────────────────────────

const STATE_KEY = "turn-outcome";

function getState(ctx: ExtensionContext): LoopDetectionState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    history: [],
    lastFired: {},
  }));
}

// ── Detection Logic ──────────────────────────────────────────────────────────

/**
 * Check if agent is repeating the same tool sequence across recent turns.
 * Returns the repeated tools if detected, null otherwise.
 */
function detectToolRepetition(history: TurnOutcome[]): string | null {
  if (history.length < TOOL_REPEAT_THRESHOLD + 1) return null;

  const recent = history.slice(-TOOL_REPEAT_THRESHOLD - 1);
  const lastPattern = recent[recent.length - 1]?.tools ?? [];
  if (lastPattern.length === 0) return null;

  // Check if last N turns used the same (or subset) of tools
  const allMatch = recent.every((t) => {
    const tools = t.tools;
    if (tools.length === 0) return false;
    // Check if the turn's tool list is a subset or match of the last pattern
    return lastPattern.every((tool) => tools.includes(tool));
  });

  if (allMatch) {
    return lastPattern.join(", ");
  }
  return null;
}

/**
 * Check if the same tool has been erroring for consecutive turns.
 */
function detectErrorEcho(history: TurnOutcome[]): string | null {
  if (history.length < ERROR_ECHO_THRESHOLD) return null;

  const recent = history.slice(-ERROR_ECHO_THRESHOLD);
  const erroredSets = recent.map((t) => new Set(t.erroredTools)).filter((s) => s.size > 0);
  if (erroredSets.length < ERROR_ECHO_THRESHOLD) return null;

  // Check for common error tool across all recent turns
  const common = [...erroredSets[0]].filter((tool) => erroredSets.every((s) => s.has(tool)));
  return common.length > 0 ? common.join(", ") : null;
}

/**
 * Check if the same file-modifying tools are being used repeatedly
 * without progress (no clean consecutive turn).
 */
function detectFileChurn(history: TurnOutcome[]): string | null {
  if (history.length < FILE_CHURN_THRESHOLD) return null;

  const recent = history.slice(-FILE_CHURN_THRESHOLD);
  const allChurning = recent.every((t) => t.fileTools.length > 0 && !t.hadProgress);
  if (!allChurning) return null;

  // Check if the same file-modifying tools are used
  const firstTools = new Set(recent[0].fileTools);
  const consistent = recent.every((t) => t.fileTools.some((tool) => firstTools.has(tool)));

  return consistent ? recent.map((t) => t.fileTools.join(", ")).join(" | ") : null;
}

// ── Loop type → steer message ────────────────────────────────────────────────

interface LoopFireEntry {
  loopType: string;
  details: string;
}

function formatSteerMessage(loops: LoopFireEntry[]): string {
  const parts = loops.map((l) => {
    switch (l.loopType) {
      case "tool-repetition":
        return `- **Tool repetition**: Using \`${l.details}\` every turn for the last ${TOOL_REPEAT_THRESHOLD + 1} turns. The outcome hasn't changed.`;
      case "error-echo":
        return `- **Persistent error**: \`${l.details}\` has been erroring for the last ${ERROR_ECHO_THRESHOLD} consecutive turns. This approach is not working.`;
      case "file-churn":
        return `- **File churn**: Editing files every turn with no progress detected for ${FILE_CHURN_THRESHOLD} turns. The changes aren't fixing the issue.`;
      default:
        return `- Repetitive pattern detected: ${l.details}`;
    }
  });

  return (
    `## 🔄 Repetitive Loop Detected\n\n` +
    `${parts.join("\n")}\n\n` +
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
    const erroredTools = results
      .filter((r) => r.isError)
      .map((r) => r.toolName)
      .filter(Boolean);
    const fileTools = tools.filter((t) => FILE_CHURN_TOOLS.includes(t));
    const hadProgress = tools.length > 0 && erroredTools.length === 0;

    // Record this turn
    const outcome: TurnOutcome = {
      tools,
      erroredTools,
      fileTools,
      hadProgress,
    };
    state.history.push(outcome);
    if (state.history.length > WINDOW_SIZE) {
      state.history.shift();
    }

    // Only start checking once we have enough history
    if (state.history.length < 3) return;

    // Run detections
    const fire: LoopFireEntry[] = [];

    const toolRep = detectToolRepetition(state.history);
    if (toolRep) {
      const lastFired = state.lastFired["tool-repetition"] ?? 0;
      const currentTurn = state.history.length;
      if (currentTurn - lastFired >= LOOP_COOLDOWN_TURNS) {
        fire.push({ loopType: "tool-repetition", details: toolRep });
        state.lastFired["tool-repetition"] = currentTurn;
      }
    }

    const errEcho = detectErrorEcho(state.history);
    if (errEcho) {
      const lastFired = state.lastFired["error-echo"] ?? 0;
      const currentTurn = state.history.length;
      if (currentTurn - lastFired >= LOOP_COOLDOWN_TURNS) {
        fire.push({ loopType: "error-echo", details: errEcho });
        state.lastFired["error-echo"] = currentTurn;
      }
    }

    const fileChurn = detectFileChurn(state.history);
    if (fileChurn) {
      const lastFired = state.lastFired["file-churn"] ?? 0;
      const currentTurn = state.history.length;
      if (currentTurn - lastFired >= LOOP_COOLDOWN_TURNS) {
        fire.push({ loopType: "file-churn", details: fileChurn });
        state.lastFired["file-churn"] = currentTurn;
      }
    }

    // Fire strategic steer if any loop detected
    if (fire.length > 0) {
      const message = formatSteerMessage(fire);
      log.info(`[turn-outcome] Detected loop(s): ${fire.map((f) => f.loopType).join(", ")}`);

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
    }
  });

  log.info("[turn-outcome] loaded: loop detection on turn_end");
}
