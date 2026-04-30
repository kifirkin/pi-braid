/**
 * Shared global state utilities for pi-braid.
 *
 * Centralizes all globalThis usage to avoid DRY violations and make
 * global state grepable in one place.
 *
 * IMPORTANT: These should only be used when module-level state won't work.
 * Prefer ctx.getState() for per-session state, ctx.getGlobalState() for
 * truly global (cross-session) state.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Custom Model Keys (polyfill ↔ model-resolver) ─────────────────────────────

/** Symbol-keyed map shared between polyfill extension and model-resolver */
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");

/**
 * Get the shared custom model keys map.
 * polyfill writes to it (/vision-model command).
 * model-resolver reads from it (model resolution).
 */
export function getCustomModelKeys(): Map<string, string> {
  if (!(globalThis as unknown as Record<symbol, unknown>)[CUSTOM_KEYS_MAP]) {
    (globalThis as unknown as Record<symbol, unknown>)[CUSTOM_KEYS_MAP] = new Map<string, string>();
  }
  return (globalThis as unknown as Record<symbol, Map<string, string>>)[CUSTOM_KEYS_MAP];
}

/** Read a custom model key (e.g. "utilityModel", "visionModel"). */
export function getCustomModelKey(key: string): string | undefined {
  return getCustomModelKeys().get(key);
}

// ── Custom Settings Keys (polyfill) ─────────────────────────────────────────

export const VISION_MODEL_KEY = "visionModel";

// ── Rotation State (rotation.ts) ─────────────────────────────────────────────

/** Symbol-keyed rotation state — avoids string key collisions on globalThis */
const ROTATION_STATE_KEY = Symbol.for("pi-braid:cm-rotation-state");

export interface RotationState {
  lastRotationTimestamp: number;
  turnsSinceRotation: number;
  rotationCount: number;
  pendingRotation: boolean;
  continuationSummary: string;
  // Nudge deduplication fields
  lastNudgeTimestamp: number;
  lastNudgeTurn: number;
  nudgeCount: number;
  actionTaken: boolean;
  actionTakenAtTurn: number; // turn count when action was taken (for grace period)
  emergencyRotation: boolean;
}

/** Get the shared rotation state object. */
export function getRotationState(): RotationState {
  if (!(globalThis as unknown as Record<symbol, unknown>)[ROTATION_STATE_KEY]) {
    (globalThis as unknown as Record<symbol, unknown>)[ROTATION_STATE_KEY] = {
      lastRotationTimestamp: Date.now(),
      turnsSinceRotation: 0,
      rotationCount: 0,
      pendingRotation: false,
      continuationSummary: "",
      lastNudgeTimestamp: 0,
      lastNudgeTurn: 0,
      nudgeCount: 0,
      actionTaken: false,
      actionTakenAtTurn: 0,
      emergencyRotation: false,
    };
  }
  return (globalThis as unknown as Record<symbol, RotationState>)[ROTATION_STATE_KEY];
}
