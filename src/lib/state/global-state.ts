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

// ── Custom Model Keys (polyfill <-> model-resolver) ─────────────────────────────

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
export const MAX_POWER_MODEL_KEY = "maxPowerModel";

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
 * busy with finalization. A 10-minute budget per tier (20 min
 * worst-case when both utility and session are tried) is the current
 * tuning. Aborts should be signal-driven (ESC, session shutdown), not
 * timeout-driven - the timeout is a fallback for orphaned calls.
 *
 * History (from post-loop-classify.ts):
 *   - 3s (pre-2026-06-21): too tight under session-end load.
 *   - 5s (2026-06-21 fix): improvement, still tight for slow models.
 *   - 8s (2026-06-21 follow-up): still hit by very slow paths.
 *   - 30s (2026-06-22 -> 2026-06-23): still hit by slowest paths and
 *     session-end backpressure.
 *   - 600s / 10min (2026-06-23): user request - "completely remove
 *     timeouts (or make huge one like 10 minutes) but keep proper
 *     esc key handling". The default is now high enough that
 *     real provider issues surface as real errors, while signal-
 *     driven aborts (ESC) remain the normal cancellation path.
 */
export const DEFAULT_POST_LOOP_TIMEOUT_MS = 600_000;

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

// ── LLM Call Listeners (llm-call.ts) ─────────────────────────────────────
//
// The session-recovery proposal (2026-06-23) routes every LLM call outcome
// through SessionHealthState. To avoid forcing every call site to pass a
// callback, lib/ai/llm-call.ts exposes a process-wide listener registration.
// The enforcement extension registers listeners at session_start with a
// closure over the current ctx; calls go to whichever listener is currently
// registered.
//
// Single-listener design: only one consumer is expected (the enforcement
// extension). Multi-session / multi-consumer scenarios are a future concern.
//
// Encapsulated in global-state.ts (not module-level let in llm-call.ts) so
// the no-module-level-let contract is satisfied and the listeners can be
// reset between test runs via resetLlmCallListeners().
export type LlmErrorListener = (err: unknown) => void;
export type LlmSuccessListener = () => void;

let _llmErrorListener: LlmErrorListener | null = null;
let _llmSuccessListener: LlmSuccessListener | null = null;

/** Set the current LLM call listeners. Pass `null` to clear a slot. */
export function setLlmCallListeners(listeners: {
  onError?: LlmErrorListener | null;
  onSuccess?: LlmSuccessListener | null;
}): void {
  if (listeners.onError !== undefined) {
    _llmErrorListener = listeners.onError ?? null;
  }
  if (listeners.onSuccess !== undefined) {
    _llmSuccessListener = listeners.onSuccess ?? null;
  }
}

/** Read-only access to the current error listener (for the callLlm() body). */
export function getLlmErrorListener(): LlmErrorListener | null {
  return _llmErrorListener;
}

/** Read-only access to the current success listener (for the callLlm() body). */
export function getLlmSuccessListener(): LlmSuccessListener | null {
  return _llmSuccessListener;
}

/** Clear all listeners. Test helper. */
export function resetLlmCallListeners(): void {
  _llmErrorListener = null;
  _llmSuccessListener = null;
}

// ── Timer Extension Factory Counter (timer/index.ts) ─────────────────────────
//
// ROADMAP DR-C-4 documents that the timer extension factory closes over a
// `poller` and `sessionState` variable, which is correct for the standard
// pi lifecycle (one process per session) but breaks under multi-session-
// per-process. The comment block in timer/index.ts:16-41 promises a
// debug-mode counter that logs a warning if `timerExtension(pi)` is called
// more than once.
//
// The counter lives here (not as a module-level let in timer/index.ts) so
// the no-module-level-let contract is satisfied. The factory call counter
// is process-global by definition (it tracks process-wide extension
// registration), so global-state.ts is the right home.
export interface TimerExtensionFactoryState {
  callCount: number;
}

function createDefaultTimerExtensionFactoryState(): TimerExtensionFactoryState {
  return { callCount: 0 };
}

let _timerExtensionFactoryState: TimerExtensionFactoryState | undefined;

/**
 * Get the shared timer-extension-factory counter.
 *
 * The timer extension increments this on every `timerExtension(pi)` call
 * and logs a warning when the count exceeds 1 (signaling an accidental
 * double-registration that would break the single-process-per-session
 * assumption under DR-C-4).
 */
export function getTimerExtensionFactoryState(): TimerExtensionFactoryState {
  if (!_timerExtensionFactoryState) {
    _timerExtensionFactoryState = createDefaultTimerExtensionFactoryState();
  }
  return _timerExtensionFactoryState;
}

/** Reset the counter. Test helper. */
export function resetTimerExtensionFactoryState(): void {
  _timerExtensionFactoryState = undefined;
}

// ── Discoverability dedup (survives /reload module re-evaluation) ──────────────
// The discoverability handler in enforcement runs on every session_start and
// emits a bundled whisper with prior-session hints. On /reload, the extension
// module IS re-evaluated (so module-level Set in the handler doesn't persist).
// This global-state slot lets the dedup Set survive across reloads within the
// same process.

let _shownDiscoveryBundles: Set<string> | undefined;

/**
 * Get the shared discoverability dedup set. Created lazily on first access.
 * The Set contains the bundled text of already-shown discoverability whispers.
 * A fresh `pi` process starts with an empty Set (everything is "new").
 */
export function getShownDiscoveryBundles(): Set<string> {
  if (!_shownDiscoveryBundles) {
    _shownDiscoveryBundles = new Set<string>();
  }
  return _shownDiscoveryBundles;
}

/** Reset the dedup set. Test helper. */
export function resetShownDiscoveryBundles(): void {
  _shownDiscoveryBundles = undefined;
}
