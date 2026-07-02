
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
import { createLogger } from "../../lib/core/logger.js";
import { getRawNudgeConfigOverrides } from "../../lib/config/braid-settings.js";

const log = createLogger("enforcement:nudge-manager");

// Nudge Types
//
// Every NudgeType in this union must have at least one caller of
// `getNudgeManager(ctx).shouldSendNudge(<type>, ...)` somewhere in
// src/. The cross-cutting test
// `test/runtime/lib/test-nudgetype-wiring.mjs` enforces this contract.
// If you add a type here, wire it up in the same commit; if you
// remove one, delete both the union member and the config entry.

export type NudgeType =
  | "validation"
  | "recordFailure"
  | "malformed"
  | "memory"
  | "scratchpad"
  | "context"
  // EW-7.9: L2 "Session Signals" bundle. Each sub-signal gets its own
  // per-key history so adding/removing a signal doesn't re-arm the
  // others. Used for sub-signals without a dedicated NudgeType (think,
  // localization).
  | "sessionSignals";

export interface NudgeConfig {
  /** Base cooldown in ms (minimum between nudges of this type) */
  baseCooldownMs: number;
  /** Escalation: how many nudges until we escalate severity */
  escalateAfter: number;
  /** Whether to deduplicate messages (prevent same text repeated) */
  deduplicate: boolean;
}

// REMOVED NudgeTypes (EW-7.2):
//   - `lazy`, `claim`: pre-LLM-judge heuristics replaced by
//     verification judge and BPE policy engine. The matching
//     `lastLazyNudgeTime` field on ErrorTrackingState is dead and
//     removed in this change.
//   - `toolDiversity`: dead flag (`toolDiversityNudged`) already
//     removed from ToolTrackingState in v1.2; the NudgeType config
//     followed in this change.
//   - `exploreBeforeAct`, `phaseValidation`: blocking was downgraded
//     to passthrough (see `handlers/blocking.ts:42-49`); no triggering
//     logic remains.
//   - `toolError`: no caller; tool-error rate-limiting is handled by
//     `consecutiveErrorTurns` (error burst detection) directly.
//   - `judge`: the verification judge uses its own state
//     (`verificationJudgeRunning`, `lastJudgeTime`,
//     `lastVerificationJudgeTurn` on VerificationJudgeState) -- no
//     caller in NudgeManager path.
//   - `contextTool`: no caller. The agent's context-tool usage is
//     observed via `lastContextCheckTurn` (not as a nudge).
//   - `dangerousCommand`: no detection exists. Adding this type
//     without triggering logic would re-introduce the false promise
//     EW-7.2 was created to fix. Re-create when detection exists.

export const DEFAULT_NUDGE_CONFIGS: Record<NudgeType, NudgeConfig> = {
  validation: { baseCooldownMs: 20_000, escalateAfter: 3, deduplicate: true },
  recordFailure: { baseCooldownMs: 20_000, escalateAfter: 1, deduplicate: true },
  malformed: { baseCooldownMs: 10_000, escalateAfter: 1, deduplicate: false },
  // L2 bundle sub-signal cooldowns (each sub-signal gets its own
  // history entry via the subKey parameter). These are wired in
  // Phase 5 (ROADMAP P1-5 / EW-7.2).
  memory: { baseCooldownMs: 45_000, escalateAfter: 2, deduplicate: false },
  scratchpad: { baseCooldownMs: 60_000, escalateAfter: 2, deduplicate: true },
  // Context bundle covers both `context-tokens` and `context-percent`
  // sub-signals. subKey distinguishes them; both share this config.
  context: { baseCooldownMs: 90_000, escalateAfter: 2, deduplicate: true },
  // EW-7.9: fallback for L2 sub-signals without a dedicated NudgeType
  // (`think`, `localization`). 60s matches the prior bundle-wide cooldown.
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
 *
 * EW-7.11: passes settings.json overrides (validated via
 * parseNudgeConfigOverrides) into the NudgeManager constructor. The
 * `customConfig` constructor parameter was previously a dead hook;
 * the only caller now wires the validated settings through it.
 */
export function getNudgeManager(ctx: ExtensionContext): NudgeManager {
  const overrides = parseNudgeConfigOverrides(getRawNudgeConfigOverrides());
  return getExtensionState(
    ctx,
    "enforcement/nudge-manager",
    () => new NudgeManager(overrides),
  );
}

// ── Settings validation (EW-7.11) ──────────────────────────────────────────────────────

const VALID_NUDGE_CONFIG_FIELDS: ReadonlySet<keyof NudgeConfig> = new Set([
  "baseCooldownMs",
  "escalateAfter",
  "deduplicate",
]);

export interface NudgeConfigValidation {
  valid: boolean;
  /** Human-readable error messages; logged but never thrown. */
  errors: string[];
  /**
   * The validated partial. Invalid fields are dropped from `parsed`;
   * the rest of the override is preserved (defense in depth: one bad
   * field doesn't lose the whole entry).
   */
  parsed: Partial<NudgeConfig>;
}

/**
 * Validate a single NudgeConfig partial.
 *
 * Rules:
 *   - cfg must be a plain object (not null, not array)
 *   - each key must be a valid NudgeConfig field name
 *     (`baseCooldownMs` | `escalateAfter` | `deduplicate`)
 *   - `deduplicate` must be boolean
 *   - `baseCooldownMs` and `escalateAfter` must be non-negative integers
 *
 * Invalid fields are dropped from `parsed`; valid fields in the same
 * entry are preserved. Empty `{}` is valid (no overrides).
 */
export function validateNudgeConfig(type: string, cfg: unknown): NudgeConfigValidation {
  const errors: string[] = [];
  const parsed: Partial<NudgeConfig> = {};

  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    const got = cfg === null ? "null" : Array.isArray(cfg) ? "array" : typeof cfg;
    errors.push(
      `[nudge-config] braid.enforcement.nudgeConfigs.${type} must be an object, got ${got}`,
    );
    return { valid: false, errors, parsed };
  }

  const obj = cfg as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const path = `braid.enforcement.nudgeConfigs.${type}.${key}`;
    if (!VALID_NUDGE_CONFIG_FIELDS.has(key as keyof NudgeConfig)) {
      errors.push(
        `[nudge-config] ${path} is not a valid field ` +
          `(valid: ${[...VALID_NUDGE_CONFIG_FIELDS].join(", ")})`,
      );
      continue;
    }

    if (key === "deduplicate") {
      if (typeof value !== "boolean") {
        errors.push(`[nudge-config] ${path} must be a boolean, got ${typeof value}`);
      } else {
        parsed.deduplicate = value;
      }
    } else {
      // baseCooldownMs | escalateAfter
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        const got = typeof value === "number" ? String(value) : typeof value;
        errors.push(
          `[nudge-config] ${path} must be a non-negative integer, got ${got}`,
        );
      } else if (key === "baseCooldownMs") {
        parsed.baseCooldownMs = value;
      } else {
        parsed.escalateAfter = value;
      }
    }
  }

  return { valid: errors.length === 0, errors, parsed };
}

/**
 * Parse the raw braid.enforcement.nudgeConfigs block into the shape
 * NudgeManager expects.
 *
 * Two layers of filtering:
 *   1. Unknown NudgeType keys are dropped (with a warning).
 *   2. Per-entry validation drops invalid fields but keeps valid
 *      ones in the same entry.
 *
 * The result is always usable (empty on full failure); NudgeManager
 * always falls back to DEFAULT_NUDGE_CONFIGS for any type without
 * an override entry.
 */
export function parseNudgeConfigOverrides(
  raw: Record<string, unknown>,
): Partial<Record<NudgeType, Partial<NudgeConfig>>> {
  const validTypes = new Set(Object.keys(DEFAULT_NUDGE_CONFIGS) as NudgeType[]);
  const overrides: Partial<Record<NudgeType, Partial<NudgeConfig>>> = {};

  for (const [type, cfg] of Object.entries(raw)) {
    if (!validTypes.has(type as NudgeType)) {
      log.warn(
        `[nudge-config] braid.enforcement.nudgeConfigs.${type} is not a valid NudgeType ` +
          `(valid: ${[...validTypes].join(", ")}); ignored`,
      );
      continue;
    }
    const { errors, parsed } = validateNudgeConfig(type, cfg);
    for (const err of errors) log.warn(err);
    if (Object.keys(parsed).length > 0) {
      overrides[type as NudgeType] = parsed;
    }
  }

  return overrides;
}

export class NudgeManager {
  // EW-7.9: history is keyed by composite `${type}:${subKey ?? ""}` so
  // a single NudgeType can have independent cooldown + dedup slots per
  // sub-signal. When subKey is omitted, the key reduces to just the
  // type -- preserving the original single-slot-per-type behavior.
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
   * @param message  The full message text -- used for hash dedup.
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
 *
 * NOTE: This function is defined but never called. The enforcement system
 * dispatches whispers directly via sendEnforcementWhisper() in turn-end-handler.ts,
 * bypassing this wrapper. Kept for future use if nudge-manager gaines adaptive
 * rate-limiting or escalation logic.
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
