/**
 * Types for the Heartbeat Scheduler extension.
 *
 * Heartbeat Scheduler — proactive cognitive scheduling based on paper 2604.14178.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Episode, HeuristicRule } from "../../memory/three-memory-stores/index.js";

// ── Cross-extension state access ─────────────────────────────────────────────

export interface MemoryStoresState {
  episodes: Episode[];
  heuristics: HeuristicRule[];
  toolStats: Map<string, any>;
  currentSessionTools: string[];
  sessionStartTime: number;
  lastSkillType: string;
  skillTransitionCount: number;
  recentErrors: string[];
  currentSessionId: string;
  loadedFromLegacy: boolean;
}

// ── Cognitive Module Types ────────────────────────────────────────────────────

export interface CognitiveModule {
  name: string;
  description: string;
  priority: number;
  shouldActivate(context: ModuleContext): boolean;
  activate(context: ModuleContext): Promise<void>;
}

export interface ModuleContext {
  ctx: ExtensionContext;
  turnCount: number;
  lastActivation: Map<string, number>;
  sessionAge: number;
  toolCallsSinceLastTick: string[];
  totalToolCalls: number;
  silentTurns: number;
  metadata: Record<string, unknown>;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface HeartbeatConfig {
  interval: number; // Turns between ticks
  historyWindow: number; // Turns to analyze
  maxActivationsPerTick: number;
  enabled: boolean;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface HeartbeatState {
  enabled: boolean;
  turnCount: number;
  modules: Map<string, RegisteredModule>;
  lastActivation: Map<string, number>;
  activationHistory: ActivationRecord[];
  stats: {
    totalTicks: number;
    totalActivations: number;
    activationsByModule: Record<string, number>;
  };
  policyEngineReady: boolean;
  policyTurnCount: number;
  policyLastFire: Map<string, number>;
  metaLearning: MetaLearningState;
}

export interface MetaLearningState {
  tickInterval: number;
  baseInterval: number;
  effectivenessHistory: number[];
  activationSignalWindow: Map<string, number>;
  postActivationToolCount: number;
  pendingSignals: Map<string, number>;
  toolTracking: ToolTracking;
  tokenWarningFired: Set<number>;
}

export interface RegisteredModule {
  module: CognitiveModule;
  enabled: boolean;
  activations: number;
  lastActivated: number;
  effectiveness: number;
}

export interface ActivationRecord {
  tick: number;
  moduleName: string;
  timestamp: number;
  reason: string;
}

// ── Tool Tracking ────────────────────────────────────────────────────────────

export interface ToolTracking {
  verificationCount: number;
  lastVerificationTurn: number;
  lastWebFetchTurn: number;
  lastCodeExecutionTurn: number;
  totalToolsUsed: number;
  lastToolCallTurn: number;
}

// ── Archives ─────────────────────────────────────────────────────────────────

export interface SessionArchiveEntry {
  timestamp: number;
  turnCount: number;
  toolSuccessRate: number;
  errorRate: number;
  heuristicsUsed: number;
  outcome: string;
}

// ── Policy Engine ────────────────────────────────────────────────────────────

import type { Policy, PolicyContext } from "../../../lib/belief-store.js";

export interface PolicyEngine {
  register(policy: Policy): void;
  unregister(id: string): boolean;
  evaluate(context: PolicyContext): Promise<Policy[]>;
}
