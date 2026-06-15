import { createLogger } from "../../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";

const log = createLogger("agent-environment");
/**
 * Agent Environment Extension - L1 Environmental Awareness
 *
 * Provides the agent with awareness of its runtime environment and session state.
 * This is the L1 (Internal) layer - context state surfaced to the agent via:
 *   1. L1 system prompt injection - automatic context awareness
 *   2. Turn/turn-count tracking for adaptive behaviour
 *
 * L1 data: session time, turn count, last event, tool call metrics, machine info.
 * These are surfaced in the system prompt so the agent is always context-aware
 * without having to explicitly call tools.
 */

import * as os from "node:os";
import * as process from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MESSAGE_END } from "../../../lib/core/event-names.js";

// =============================================================================
// L1 State - shared with prompt-builder for system prompt injection
// =============================================================================

export interface AgentEnvironmentState {
  sessionStart: number;
  lastEventTime: number;
  turnCount: number;
  toolCallStarts: Map<string, number>;
  metrics: {
    totalToolCalls: number;
    totalToolTime: number;
    userMessageCount: number;
    assistantMessageCount: number;
  };
}

// Initial state factory. Used by the per-session state below.
function createEnvState(): AgentEnvironmentState {
  return {
    sessionStart: Date.now(),
    lastEventTime: Date.now(),
    turnCount: 0,
    toolCallStarts: new Map(),
    metrics: {
      totalToolCalls: 0,
      totalToolTime: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
    },
  };
}

// =============================================================================
// L1 State gathering - consumed by prompt-builder
// =============================================================================

export interface L1EnvironmentData {
  pid: number;
  sessionElapsedMs: number;
  turnCount: number;
  sinceLastEventMs: number;
  avgToolTimeMs: number;
  machine: {
    platform: string;
    type: string;
    hostname: string;
  };
}

export function gatherL1Environment(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
): L1EnvironmentData {
  const state = getExtensionState(ctx, "agent-environment", createEnvState);
  const now = Date.now();
  const sessionElapsed = now - state.sessionStart;
  const sinceLastEvent = now - state.lastEventTime;
  const avgToolTime =
    state.metrics.totalToolCalls > 0
      ? Math.round(state.metrics.totalToolTime / state.metrics.totalToolCalls)
      : 0;

  // OS detection - normalize platform names for clarity
  const rawPlatform = os.platform();
  const platformDisplay =
    rawPlatform === "win32"
      ? "Windows"
      : rawPlatform === "darwin"
        ? "macOS"
        : rawPlatform === "linux"
          ? "Linux"
          : rawPlatform;

  return {
    pid: process.pid,
    sessionElapsedMs: sessionElapsed,
    turnCount: state.turnCount,
    sinceLastEventMs: sinceLastEvent,
    avgToolTimeMs: avgToolTime,
    machine: {
      platform: platformDisplay,
      type: os.type(),
      hostname: os.hostname(),
    },
  };
}

export function formatL1EnvironmentSection(data: L1EnvironmentData): string {
  const minutes = Math.floor(data.sessionElapsedMs / 60000);
  const seconds = Math.floor((data.sessionElapsedMs % 60000) / 1000);
  const sinceLast = Math.round(data.sinceLastEventMs / 1000);

  const lines: string[] = [];
  lines.push("");

  // Machine info
  lines.push("## System State");
  lines.push(`- PID: ${data.pid} (${data.machine.platform})`);
  lines.push(`- Machine: ${data.machine.platform} (${data.machine.hostname})`);
  lines.push(`- Session: ${minutes}m ${seconds}s`);
  lines.push(`- Last event: ${sinceLast}s ago`);
  lines.push(`- Turns: ${data.turnCount}`);
  if (data.avgToolTimeMs > 0) {
    lines.push(`- Tool avg: ${data.avgToolTimeMs}ms`);
  }

  return lines.join("\n");
}

// =============================================================================
// Extension registration
// =============================================================================

export default function agentEnvironmentExtension(pi: ExtensionAPI) {
  // Track turns
  registerSessionStartHandler(pi, SessionPhase.Background, async (_event, ctx) => {
    const state = getExtensionState(ctx, "agent-environment", createEnvState);
    state.sessionStart = Date.now();
    state.lastEventTime = Date.now();
    state.turnCount = 0;
    state.metrics.totalToolCalls = 0;
    state.metrics.totalToolTime = 0;
    state.metrics.userMessageCount = 0;
    state.metrics.assistantMessageCount = 0;
  });

  pi.on(MESSAGE_END, (event, ctx) => {
    const state = getExtensionState(ctx, "agent-environment", createEnvState);
    if (event.message.role === "assistant") {
      state.turnCount++;
      state.lastEventTime = Date.now();
    }
    if (event.message.role === "user") {
      state.lastEventTime = Date.now();
    }
  });

}
