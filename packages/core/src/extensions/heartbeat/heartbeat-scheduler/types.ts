/**
 * Types for the Heartbeat Scheduler extension.
 *
 * Heartbeat Scheduler - proactive cognitive scheduling based on paper 2604.14178.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Episode } from "../../../lib/types/episode-types.js";
import type { HeuristicRule } from "../../memory/three-memory-stores/index.js";

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
  lastRecallTime: number;
  lastSemanticRecallHashes: string[];
  lastEpisodeRecallSignature: string;
  lastSemanticRecallTime: number;
}

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
  /**
   * AbortSignal that fires on session_shutdown. Modules that make LLM
   * calls (via callLlm or classify) MUST thread this signal through to
   * prevent orphaned calls from running for their full timeout after the
   * session ends. Created per-tick in the heartbeat tick handler.
   */
  abortSignal?: AbortSignal;
  /**
   * Prefer `whisper()` over `ctx.whisper?.()`.
   * The heartbeat tick handler batches all module whispers into one
   * aggregated message and flushes via sendTrackedMessage, which
   * honors the per-source flood cap. Calling `ctx.whisper` directly
   * bypasses the cap and injection tracking. See heartbeat-batcher.ts.
   */
  whisper(msg: string, opts?: { category?: string; priority?: string }): void;
}

export interface HeartbeatConfig {
  interval: number; // Turns between ticks
  historyWindow: number; // Turns to analyze
  maxActivationsPerTick: number;
  enabled: boolean;
}

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

export interface ToolTracking {
  verificationCount: number;
  lastVerificationTurn: number;
  lastWebFetchTurn: number;
  lastCodeExecutionTurn: number;
  totalToolsUsed: number;
  lastToolCallTurn: number;
  /** Rich trajectory data from tool_end events */
  trajectory?: Array<{ toolName: string; success: boolean; turn: number }>;
}

import type { Policy, PolicyContext } from "../../../lib/store/belief-store.js";

export interface PolicyEngine {
  register(policy: Policy): void;
  unregister(id: string): boolean;
  evaluate(context: PolicyContext): Promise<Policy[]>;
}
