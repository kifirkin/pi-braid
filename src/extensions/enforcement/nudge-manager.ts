
import { hashForDedup } from "../../lib/utils/dedup.js";


/**
 * Enforcement Nudge System - Smart Nudge Management
 *
 * Prevents notification fatigue with:
 * - Adaptive thresholds (scale based on session context)
 * - Message deduplication (block similar nudges)
 * - Per-type cooldowns (different rules per nudge category)
 * - Context-aware escalation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../lib/state/extension-state.js";
import { sendEnforcementWhisper } from "./whisper.js";

// Nudge Types

export type NudgeType =
  | "validation"
  | "memory"
  | "recordFailure"
  | "toolError"
  | "lazy"
  | "claim"
  | "toolDiversity"
  | "exploreBeforeAct"
  | "phaseValidation"
  | "scratchpad"
  | "malformed"
  | "dangerousCommand"
  | "judge"
  | "context"
  | "contextTool"
  // EW-7.9: L2 "Session Signals" bundle. Each sub-signal gets its own
  // per-key history so adding/removing a signal doesn't re-arm the
  // others. Pass subKey="memory" | "scratchpad-edit" | "think" | etc.
  | "sessionSignals";

export interface NudgeConfig {
  /** Base cooldown in ms (minimum between nudges of this type) */
  baseCooldownMs: number;
  /** Escalation: how many nudges until we escalate severity */
  escalateAfter: number;
  /** Whether to deduplicate messages (prevent same text repeated) */
  deduplicate: boolean;
}

export const DEFAULT_NUDGE_CONFIGS: Record<NudgeType, NudgeConfig> = {
  validation: { baseCooldownMs: 20_000, escalateAfter: 3, deduplicate: true },
  memory: { baseCooldownMs: 45_000, escalateAfter: 2, deduplicate: false },
  recordFailure: { baseCooldownMs: 20_000, escalateAfter: 1, deduplicate: true },
  toolError: { baseCooldownMs: 15_000, escalateAfter: 2, deduplicate: true },
  lazy: { baseCooldownMs: 15_000, escalateAfter: 2, deduplicate: false },
  claim: { baseCooldownMs: 20_000, escalateAfter: 2, deduplicate: true },
  toolDiversity: { baseCooldownMs: 60_000, escalateAfter: 1, deduplicate: true },
  exploreBeforeAct: { baseCooldownMs: 30_000, escalateAfter: 2, deduplicate: true },
  phaseValidation: { baseCooldownMs: 15_000, escalateAfter: 3, deduplicate: true },
  scratchpad: { baseCooldownMs: 60_000, escalateAfter: 2, deduplicate: true },
  malformed: { baseCooldownMs: 10_000, escalateAfter: 1, deduplicate: false },
  dangerousCommand: { baseCooldownMs: 5_000, escalateAfter: 1, deduplicate: false },
  judge: { baseCooldownMs: 30_000, escalateAfter: 2, deduplicate: true },
  context: { baseCooldownMs: 90_000, escalateAfter: 2, deduplicate: true },
  contextTool: { baseCooldownMs: 120_000, escalateAfter: 3, deduplicate: true },
  // EW-7.9: per-signal gating for the L2 bundle. Each subKey has its
  // own history entry; the 60s cooldown matches the original
  // "scratchpad" gate that the bundle used before per-signal splitting.
  sessionSignals: { baseCooldownMs: 60_000, escalateAfter: 2, deduplicate: true },
};

// Nudge State Tracking

interface NudgeHistory {
  lastSent: number;
  count: number;
  lastMessageHash: string;
}

// Smart Threshold Calculation

export function calculateAdaptiveAnalysisThreshold(totalToolCalls: number): number {
  if (totalToolCalls < 10) return 0.1;
  if (totalToolCalls < 30) return 0.2;
  if (totalToolCalls < 100) return 0.25;
  return 0.3;
}

// Nudge Manager

/**
 * Get the per-session NudgeManager. Cooldowns are scoped to the session:
 * a new session starts with a fresh history (no carry-over). This is
 * the canonical accessor; the enforcement index no longer constructs
 * a NudgeManager directly.
 */
export function getNudgeManager(ctx: ExtensionContext): NudgeManager {
  return getExtensionState(ctx, "enforcement/nudge-manager", () => new NudgeManager());
}

export class NudgeManager {
  // EW-7.9: history is keyed by composite `${type}:${subKey ?? ""}` so
  // a single NudgeType can have independent cooldown + dedup slots per
  // sub-signal. When subKey is omitted, the key reduces to just the
  // type — preserving the original single-slot-per-type behavior.
  private history: Map<string, NudgeHistory> = new Map();
  private readonly config: Record<NudgeType, NudgeConfig>;

  constructor(customConfig?: Partial<Record<NudgeType, Partial<NudgeConfig>>>) {
    this.config = { ...DEFAULT_NUDGE_CONFIGS };
    if (customConfig) {
      for (const [type, overrides] of Object.entries(customConfig)) {
        const t = type as NudgeType;
        if (this.config[t]) {
          this.config[t] = { ...this.config[t], ...overrides };
        }
      }
    }
  }

  /**
   * Decide whether to send a nudge.
   *
   * @param type   Nudge category (cooldown + dedup config bucket).
   * @param message  The full message text — used for hash dedup.
   * @param subKey  Optional. When set, isolates this call's history
   *                from other sub-signals of the same type. Without
   *                subKey, the call shares history with all other
   *                callers of the same type (legacy behavior).
   * @param _now   Optional override for the current time (tests).
   */
  shouldSendNudge(
    type: NudgeType,
    message: string,
    subKey?: string,
    _now: number = Date.now(),
  ): { shouldSend: boolean; escalated: boolean } {
    const cfg = this.config[type];
    if (!cfg) return { shouldSend: false, escalated: false };

    const key = subKey ? `${type}:${subKey}` : type;
    const existing = this.history.get(key);
    const history: NudgeHistory = existing
      ? { ...existing }
      : { lastSent: 0, count: 0, lastMessageHash: "" };

    // 1. Check cooldown
    const timeSinceLast = _now - history.lastSent;
    if (timeSinceLast < cfg.baseCooldownMs) {
      return { shouldSend: false, escalated: false };
    }

    // 2. Check deduplication
    if (cfg.deduplicate && existing?.lastMessageHash) {
      const msgHash = this.hashMessage(message);
      if (msgHash === existing.lastMessageHash) {
        return { shouldSend: false, escalated: false };
      }
    }

    // 3. Update state
    history.lastSent = _now;
    history.lastMessageHash = this.hashMessage(message);
    history.count++;
    const escalated = history.count % cfg.escalateAfter === 0;

    this.history.set(key, history);

    return { shouldSend: true, escalated };
  }

  private hashMessage(message: string): string {
    return hashForDedup(message.trim());
  }

  /**
   * Look up history for a (type, subKey) pair. Without subKey, returns
   * the un-scoped history for that type.
   */
  getHistory(type: NudgeType, subKey?: string): NudgeHistory | undefined {
    const key = subKey ? `${type}:${subKey}` : type;
    return this.history.get(key);
  }

  getAllStats(): Record<string, { count: number; lastSent: number }> {
    const stats: Record<string, { count: number; lastSent: number }> = {};
    for (const [type, hist] of this.history) {
      stats[type] = { count: hist.count, lastSent: hist.lastSent };
    }
    return stats;
  }

  reset(): void {
    this.history.clear();
  }
}

/**
 * Smart nudge wrapper for sendEnforcementWhisper.
 */
export function sendSmartNudge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: NudgeType,
  message: string,
  nudgeManager: NudgeManager,
): { sent: boolean; escalated: boolean } {
  const { shouldSend, escalated } = nudgeManager.shouldSendNudge(type, message);

  if (shouldSend) {
    const prefix = escalated ? `[ESCALATED] ` : "";
    sendEnforcementWhisper(pi, ctx, prefix + message);
  }

  return { sent: shouldSend, escalated };
}
