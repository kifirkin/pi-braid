/**
 * State management for the Heartbeat Scheduler extension.
 *
 * Provides factory functions and state accessors for heartbeat state,
 * cross-extension memory state, and default configuration.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../lib/extension-state.js";
import type {
  HeartbeatState,
  HeartbeatConfig,
  MemoryStoresState,
} from "./types.js";

// ── Default Configuration ────────────────────────────────────────────────────

export const DEFAULT_CONFIG: HeartbeatConfig = {
  interval: 5,
  historyWindow: 20,
  maxActivationsPerTick: 2,
  enabled: true,
};

// ── Meta-Learning Constants ───────────────────────────────────────────────────

export const META_LEARNING = {
  MIN_INTERVAL: 3,
  MAX_INTERVAL: 10,
  effectivenessWindowSize: 10,
  signalWindow: 3,
  speedUpThreshold: 0.7,
  slowDownThreshold: 0.3,
  intervalStep: 1,
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createHeartbeatState(): HeartbeatState {
  return {
    enabled: true,
    turnCount: 0,
    modules: new Map(),
    lastActivation: new Map(),
    activationHistory: [],
    stats: {
      totalTicks: 0,
      totalActivations: 0,
      activationsByModule: {},
    },
    policyEngineReady: false,
    policyTurnCount: 0,
    policyLastFire: new Map(),
    metaLearning: {
      tickInterval: DEFAULT_CONFIG.interval,
      baseInterval: DEFAULT_CONFIG.interval,
      effectivenessHistory: [],
      activationSignalWindow: new Map(),
      postActivationToolCount: 0,
      pendingSignals: new Map(),
      tokenWarningFired: new Set<number>(),
      toolTracking: {
        verificationCount: 0,
        lastVerificationTurn: 0,
        lastWebFetchTurn: 0,
        lastCodeExecutionTurn: 0,
        totalToolsUsed: 0,
        lastToolCallTurn: 0,
      },
    },
  };
}

export function getState(ctx: ExtensionContext): HeartbeatState {
  return getExtensionState(ctx, "heartbeat", createHeartbeatState);
}

// ── Cross-extension memory state ─────────────────────────────────────────────

export function getMemoryState(ctx: ExtensionContext): MemoryStoresState | null {
  try {
    return getExtensionState<MemoryStoresState>(ctx, "three-memory-stores", () => ({
      episodes: [],
      heuristics: [],
      toolStats: new Map(),
      currentSessionTools: [],
      sessionStartTime: Date.now(),
      lastSkillType: "",
      skillTransitionCount: 0,
      recentErrors: [],
      currentSessionId: "",
      loadedFromLegacy: false,
    }));
  } catch {
    return null;
  }
}
