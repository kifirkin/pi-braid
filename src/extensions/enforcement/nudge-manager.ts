import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("enforcement");
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
  | "contextTool";

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

export class NudgeManager {
  private history: Map<NudgeType, NudgeHistory> = new Map();
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

  shouldSendNudge(
    type: NudgeType,
    message: string,
    _now: number = Date.now(),
  ): { shouldSend: boolean; escalated: boolean } {
    const cfg = this.config[type];
    if (!cfg) return { shouldSend: false, escalated: false };

    const existing = this.history.get(type);
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

    this.history.set(type, history);

    return { shouldSend: true, escalated };
  }

  private hashMessage(message: string): string {
    // Use stable string hash (cyrb53) for reliable dedup
    // https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
    const str = message.trim();
    let h1 = 0xdeadbeef,
      h2 = 0x41c6ce57;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  getHistory(type: NudgeType): NudgeHistory | undefined {
    return this.history.get(type);
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
