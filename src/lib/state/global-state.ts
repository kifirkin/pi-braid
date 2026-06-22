/**
 * Shared global state utilities for pi-braid.
 *
 * Module-level state shared between extensions that can't use
 * getExtensionState() because they span separate extension contexts.
 *
 * Previously used globalThis symbols for cross-bundle safety, but pi
 * runs all extensions in a single process - plain module-level state
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
  // Deep-branch whisper throttle (separate from rotation nudge so a
  // very-deep branch doesn't share a counter with a soon-to-rotate one)
  lastDeepBranchWhisperTimestamp: number;
  lastDeepBranchWhisperTurn: number;
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
    lastDeepBranchWhisperTimestamp: 0,
    lastDeepBranchWhisperTurn: 0,
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

// ── Nudge Analytics Fallback (nudge-analytics.ts) ──────────────────────────

/**
 * Last-known nudge state from the most recent session.
 * Used by code paths that read nudge state without an ExtensionContext
 * (e.g., a tool result handler that already returned to the agent loop).
 * When a ctx is available, prefer getExtensionState(ctx, "nudge-analytics").
 */
export interface NudgeAnalyticsFallbackState {
  nudgesSent: number;
  nudgesSuppressed: number;
  abVariant: string;
  contextDensity: number;
  wasDegraded: boolean;
}

function createDefaultNudgeAnalyticsFallback(): NudgeAnalyticsFallbackState {
  return {
    nudgesSent: 0,
    nudgesSuppressed: 0,
    abVariant: "control",
    contextDensity: 0,
    wasDegraded: false,
  };
}

let _nudgeAnalyticsFallback: NudgeAnalyticsFallbackState | undefined;

/** Get the shared nudge-analytics fallback object (process-global mirror). */
export function getNudgeAnalyticsFallback(): NudgeAnalyticsFallbackState {
  if (!_nudgeAnalyticsFallback) {
    _nudgeAnalyticsFallback = createDefaultNudgeAnalyticsFallback();
  }
  return _nudgeAnalyticsFallback;
}

// ── CognitiveMemory Singleton (lib/memory/index.ts) ─────────────────────────

/**
 * Process-global singleton instance of CognitiveMemory.
 * The class is renamed to "process-global" here, distinct from the
 * per-session pattern used in `extension-state.ts`. Used because the
 * memory engine maintains indices in memory that are expensive to
 * rebuild on every session start.
 */
export interface CognitiveMemoryInstance {
  // Opaque type - the actual class lives in lib/memory/index.ts. The
  // getter/setter pattern here lets us declare the slot in global-state
  // without importing the (heavy) class.
  readonly _brand: unique symbol;
}

let _cognitiveMemoryInstance: unknown = null;

/** Set the shared CognitiveMemory instance (called once at first use). */
export function setCognitiveMemoryInstance(instance: unknown): void {
  _cognitiveMemoryInstance = instance;
}

/** Get the shared CognitiveMemory instance (or null if not yet initialized). */
export function getCognitiveMemoryInstance(): unknown {
  return _cognitiveMemoryInstance;
}

// ── Post-Loop Timeout (post-loop-classify.ts) ──────────────────────────────

/**
 * Default per-LLM-tier timeout for post-loop classify() calls. The
 * post-loop path runs at session end, when the session model may be
 * busy with finalization. A 30s budget per tier (60s worst-case when
 * both utility and session are tried) is the current tuning.
 *
 * History (from post-loop-classify.ts):
 *   - 3s (pre-2026-06-21): too tight under session-end load.
 *   - 5s (2026-06-21 fix): improvement, still tight for slow models.
 *   - 8s (2026-06-21 follow-up): still hit by very slow paths.
 *   - 30s (current): full headroom for worst-case post-loop paths.
 */
export const DEFAULT_POST_LOOP_TIMEOUT_MS = 30_000;

let _postLoopTimeoutMs: number | undefined;

/**
 * Get the per-LLM-tier timeout for post-loop classify() calls.
 * Defaults to DEFAULT_POST_LOOP_TIMEOUT_MS (30_000). Tunable via
 * setPostLoopTimeoutMs() - typically called from a /command or
 * startup config so the value can be changed without code changes.
 */
export function getPostLoopTimeoutMs(): number {
  if (_postLoopTimeoutMs === undefined) {
    _postLoopTimeoutMs = DEFAULT_POST_LOOP_TIMEOUT_MS;
  }
  return _postLoopTimeoutMs;
}

/** Override the post-loop timeout. Pass a positive number in ms. */
export function setPostLoopTimeoutMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`setPostLoopTimeoutMs: value must be a positive finite number, got ${value}`);
  }
  _postLoopTimeoutMs = value;
}

/** Reset the post-loop timeout to the default. Test helper. */
export function resetPostLoopTimeoutMs(): void {
  _postLoopTimeoutMs = undefined;
}
