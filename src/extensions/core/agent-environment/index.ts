import { createLogger } from "../../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";

const log = createLogger("agent-environment");
/**
 * Agent Environment Extension - L1 Environmental Awareness
 *
 * Provides the agent with awareness of its runtime environment and session state.
 * This is the L1 (Internal) layer - context state surfaced to the agent via:
 *   1. `time_status` tool - explicit time queries
 *   2. L1 system prompt injection - automatic context awareness
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

const _state: AgentEnvironmentState = {
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
  ctx: ExtensionContext | undefined,
): L1EnvironmentData {
  const now = Date.now();
  const sessionElapsed = now - _state.sessionStart;
  const sinceLastEvent = now - _state.lastEventTime;
  const avgToolTime =
    _state.metrics.totalToolCalls > 0
      ? Math.round(_state.metrics.totalToolTime / _state.metrics.totalToolCalls)
      : 0;

  // Sync turnCount from extension state (survives extension reloads in resumed sessions).
  // When module reloads mid-session, _state.turnCount starts at 0. Extension state
  // persists because pi-core stores it per-session, not per-extension-load.
  if (_state.turnCount === 0 && ctx) {
    try {
      const extState = getExtensionState(ctx, "agent-environment", () => ({
        turnCount: 0,
        lastEventTime: Date.now(),
      }));
      _state.turnCount = extState.turnCount;
      _state.lastEventTime = extState.lastEventTime;
    } catch {
      // Extension state unavailable — fall back to module-level defaults
    }
  }

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
    turnCount: _state.turnCount,
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
// time_status tool
// =============================================================================
// time_status tool — REMOVED
// =============================================================================
// The time_status tool was removed because it's out of scope: the agent
// can get the same information via `bash date` (one line). The function
// createTimeStatusTool and its schema were deleted with the tool.

// =============================================================================
// Extension registration
// =============================================================================

export default function agentEnvironmentExtension(pi: ExtensionAPI) {
  // Track turns
  registerSessionStartHandler(pi, SessionPhase.Background, async () => {
    _state.sessionStart = Date.now();
    _state.lastEventTime = Date.now();
    _state.turnCount = 0;
    _state.metrics.totalToolCalls = 0;
    _state.metrics.totalToolTime = 0;
    _state.metrics.userMessageCount = 0;
    _state.metrics.assistantMessageCount = 0;
  });

  pi.on(MESSAGE_END, (event, ctx) => {
    if (event.message.role === "assistant") {
      _state.turnCount++;
      // Persist to extension state so turn count survives extension reload
      try {
        const extState = getExtensionState(ctx, "agent-environment", () => ({
          turnCount: 0,
          lastEventTime: Date.now(),
        }));
        extState.turnCount = _state.turnCount;
        extState.lastEventTime = _state.lastEventTime;
      } catch {
        // Extension state unavailable — module-level tracking only
      }
    }
    if (event.message.role === "user") {
      _state.lastEventTime = Date.now();
    }
  });

  // Note: time_status tool removed (out of scope — agent can use 'bash date' for the same info).
  // createTimeStatusTool() is still exported above for any future dev/research use.
}
