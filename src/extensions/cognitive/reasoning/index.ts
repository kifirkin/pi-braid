import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("reasoning");
/**
 * Reasoning Extension - Minimal Thinking Helper
 *
 * Key features:
 * 1. Detects malformed tool calls (XML tags as text) - catches common LLM errors
 * 2. Tracks simple step count for progress
 * 3. Reminds to verify before claiming done
 *
 * Simple and helpful, not prescriptive.
 * Note: System prompt modification is handled exclusively by prompt-builder.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";

// Helper: Send Enforcement Message as Custom (for visual distinction in TUI)

/**
 * Send a enforcement/nudge message that will be visually distinct in the TUI.
 * Uses role: "custom" with customType: "enforcement" so it renders with purple
 * background and [enforcement] label instead of looking like a user message.
 */
function sendSteerMessage(pi: ExtensionAPI, message: string): void {
  sendTrackedMessage(
    pi,
    {
      customType: "enforcement",
      content: [{ type: "text" as const, text: `[reasoning] ${message}` }],
      display: true,
    },
    { deliverAs: "steer", triggerTurn: true },
    { type: "enforcement", source: "reasoning/steer" },
  );
}

// Types

interface ReasoningState {
  step: number;
  goal: string;
  timestamp: number;
}

interface ExtensionState {
  current: ReasoningState | null;
  history: ReasoningState[];
  turnCount: number;
}

// ── Session-scoped State ────────────────────────────────────────────────────

function createReasoningState(): ExtensionState {
  return { current: null, history: [], turnCount: 0 };
}

function getReasoningState(ctx: ExtensionContext): ExtensionState {
  return getExtensionState(ctx, "reasoning", createReasoningState);
}

// Malformed Tool Call Detection

import { MALFORMED_TOOL_CALL_RE, MALFORMED_TOOL_NAME_RE } from "../../../lib/constants/tool-constants.js";
import { MESSAGE_END } from "../../../lib/core/event-names.js";

function detectMalformedToolCalls(text: string, pi: ExtensionAPI, s: ExtensionState): void {
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;
  const match = MALFORMED_TOOL_CALL_RE.exec(text);
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;

  if (match) {
    const toolNameMatch = text.match(MALFORMED_TOOL_NAME_RE);
    const detectedTool = toolNameMatch ? toolNameMatch[1].toLowerCase() : "unknown";

    if (s.current) {
      s.current.step++;
    }

    sendSteerMessage(
      pi,
      "Malformed tool call detected: <" +
        detectedTool +
        "> as TEXT. Use proper function calling format - do NOT output XML tags as plain text.",
    );
  }
}

// Extension Factory

export default function reasoningExtension(pi: ExtensionAPI) {
  // Pre-Turn: Track turn count and state (no system prompt modification)
  // System prompt is now managed exclusively by prompt-builder extension
  pi.on("before_agent_start", async (_event, ctx) => {
    const state = getReasoningState(ctx);
    state.turnCount++;

    // Initialize state if needed
    if (!state.current) {
      state.current = { step: 1, goal: "", timestamp: Date.now() };
    }
  });

  // Message End: Check for malformed tool calls

  pi.on(MESSAGE_END, async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const state = getReasoningState(ctx);

    // Extract text content
    const textContent = event.message.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");

    // Always check for malformed tool calls
    detectMalformedToolCalls(textContent, pi, state);

    // Increment step count for tracking
    if (state.current) {
      state.current.step++;
    }
  });

  // Commands

  // No agent-facing commands — reasoning works via event handlers
  // (malformed tool call detection, step tracking, verify-before-done nudge)
}

// Utilities (used by other extensions — require ctx for session-scoped state)

export function getCurrentReasoning(ctx: ExtensionContext): ReasoningState | null {
  return getReasoningState(ctx).current;
}

export function getReasoningHistory(ctx: ExtensionContext): ReasoningState[] {
  return [...getReasoningState(ctx).history];
}
