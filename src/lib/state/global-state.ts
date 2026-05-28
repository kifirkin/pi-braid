/**
 * Shared global state utilities for pi-braid.
 *
 * Module-level state shared between extensions that can't use
 * getExtensionState() because they span separate extension contexts.
 *
 * Previously used globalThis symbols for cross-bundle safety, but pi
 * runs all extensions in a single process — plain module-level state
 * is simpler, faster, and equally correct.
 *
 * IMPORTANT: These should only be used when module-level state won't work.
 * Prefer getExtensionState() for per-session state.
 */

// ── Custom Model Keys (polyfill ↔ model-resolver) ─────────────────────────────

const _customModelKeys = new Map<string, string>();

/**
 * Get the shared custom model keys map.
 * polyfill writes to it (/vision-model command).
 * model-resolver reads from it (model resolution).
 */
export function getCustomModelKeys(): Map<string, string> {
  return _customModelKeys;
}

/** Read a custom model key (e.g. "utilityModel", "visionModel"). */
export function getCustomModelKey(key: string): string | undefined {
  return _customModelKeys.get(key);
}

/** Set a custom model key. Used by polyfill for /utility-model and /vision-model. */
export function setCustomModelKey(key: string, value: string): void {
  _customModelKeys.set(key, value);
}

// ── Custom Settings Keys (polyfill) ─────────────────────────────────────────

export const VISION_MODEL_KEY = "visionModel";
export const UTILITY_MODEL_KEY = "utilityModel";

// ── Rotation State (rotation.ts) ─────────────────────────────────────────────

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

function createDefaultRotationState(): RotationState {
  return {
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

let _rotationState: RotationState | undefined;

/** Get the shared rotation state object. */
export function getRotationState(): RotationState {
  if (!_rotationState) {
    _rotationState = createDefaultRotationState();
  }
  return _rotationState;
}
