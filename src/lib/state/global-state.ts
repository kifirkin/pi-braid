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

// ── pi-ai Models Instance (models-init.ts → llm-call.ts) ───────────────────
//
// pi-ai v0.80 moved `completeSimple` from the top-level export to the
// `/compat` subpath (deprecated). The forward-looking API is
// `createModels()` → `Models.completeSimple()`. This slot holds the
// process-global Models instance created by models-init.ts so that
// llm-call.ts can use it without importing from the compat subpath.
//
// When the compat subpath is removed upstream, delete the compat import
// fallback in llm-call.ts and use getModels() exclusively.
//
// Opaque type pattern (same as CognitiveMemoryInstance): the slot
// declaration avoids importing the heavy pi-ai Models type.

export interface ModelsInstance {
  readonly _brand: unique symbol;
}

let _modelsInstance: unknown = null;

/** Set the shared pi-ai Models instance (called once at startup). */
export function setModelsInstance(instance: unknown): void {
  _modelsInstance = instance;
}

/** Get the shared pi-ai Models instance (or null if not yet initialized). */
export function getModelsInstance(): unknown {
  return _modelsInstance;
}

/** Reset the models instance. Test helper. */
export function resetModelsInstance(): void {
  _modelsInstance = null;
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

// ── Discoverability dedup (survives /reload module re-evaluation) ──────────────
// The discoverability handler in enforcement runs on every session_start and
// emits a bundled whisper with prior-session hints. On /reload, the extension
// module IS re-evaluated (so module-level `let` in the handler doesn't persist).
// _This_ module is also in the extension import tree, so a module-level `let`
// here would also be lost on reload. We use `globalThis` instead, which is the
// Node.js process global and survives any module re-evaluation.
//
// Key: process-global (not module-global). A fresh `pi` process starts with
// an empty Set (everything is "new"). Within the same process, the Set persists
// across any number of /reload calls.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SHOWN_SIGNALS_FILE } from "../config/braid-paths.js";

const _GLOBAL_KEY = "__braid_discoverability_shown";

/**
 * Get the shared discoverability dedup set. Created lazily on first access.
 * The Set is stored in `globalThis` (process-global) so it survives module
 * re-evaluation on /reload.
 */
export function getShownDiscoveryBundles(): Set<string> {
  if (!(globalThis as any)[_GLOBAL_KEY]) {
    (globalThis as any)[_GLOBAL_KEY] = new Set<string>();
  }
  return (globalThis as any)[_GLOBAL_KEY];
}

/** Reset the dedup set. Test helper. */
export function resetShownDiscoveryBundles(): void {
  delete (globalThis as any)[_GLOBAL_KEY];
}

// ── Per-signal dedup (more robust than bundle dedup) ──────────────────────
// Bundle-text dedup misses when ANY dynamic content in the bundle changes
// (openPlans count, goal slice, tag list, etc.). Per-signal dedup tracks
// individual signal TYPES (semantic keys), so the same signal type is
// skipped on re-emission even if its content varies.
// Used by register-session-start-discoverability.ts (2026-07-16 fix).

const _GLOBAL_SIGNAL_KEY = "__braid_shown_signal_types";

/** Signal type identifiers used by the discoverability handler.
 *  These are the dedup keys — keep them stable across releases. */
export type DiscoverySignalType =
  | "scratchpad_prior"
  | "memory_prior"
  | "sessions_prior"
  | "resume"
  | "tags_prior"
  | "context_hygiene_tip";

/** Get the shared shown-signal-types set (process-global, survives /reload). */
export function getShownSignals(): Set<DiscoverySignalType> {
  if (!(globalThis as any)[_GLOBAL_SIGNAL_KEY]) {
    (globalThis as any)[_GLOBAL_SIGNAL_KEY] = new Set<DiscoverySignalType>();
  }
  return (globalThis as any)[_GLOBAL_SIGNAL_KEY];
}

/** Reset the shown-signal set. Test helper. */
export function resetShownSignals(): void {
  delete (globalThis as any)[_GLOBAL_SIGNAL_KEY];
}

/** Check if a signal type has been shown in this process. */
export function isSignalShown(t: DiscoverySignalType): boolean {
  return getShownSignals().has(t);
}

/** Mark a signal type as shown in this process. */
export function markSignalShown(t: DiscoverySignalType): void {
  getShownSignals().add(t);
}

// ── Disk-persisted per-project shown signals (survives process restart) ──
// On `pi --session <id>`, a new Node.js process starts, so `globalThis`
// is empty. The discoverability bundle fires again even though the user
// already saw it in the prior session. Per-project disk persistence solves
// this: when a new process starts for the same project, previously shown
// signal types are loaded from disk and skipped.

const _GLOBAL_PROJECT_SIGNAL_KEY = "__braid_project_shown_signals";

/**
 * Get the per-project shown-signals map from disk.
 * Internal cache keyed by project slug. The on-disk file is a flat JSON
 * object: `{ "<project-slug>": ["signal_type1", ...] }`.
 */
function loadProjectShownSignalsFromDisk(): Record<string, DiscoverySignalType[]> {
  try {
    if (existsSync(SHOWN_SIGNALS_FILE)) {
      const raw = readFileSync(SHOWN_SIGNALS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // File corrupt or missing — start fresh
  }
  return {};
}

function persistProjectShownSignalsToDisk(data: Record<string, DiscoverySignalType[]>): void {
  try {
    const dir = dirname(SHOWN_SIGNALS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SHOWN_SIGNALS_FILE, JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — persistence is a best-effort optimization
  }
}

/**
 * Get the process-global cache of per-project shown signals.
 * Lazily loaded from disk on first access.
 * Structure: { "<slug>": Set<signal_type> }
 */
function getProjectShownSignalsCache(): Map<string, Set<DiscoverySignalType>> {
  if (!(globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY]) {
    const fromDisk = loadProjectShownSignalsFromDisk();
    const map = new Map<string, Set<DiscoverySignalType>>();
    for (const [slug, types] of Object.entries(fromDisk)) {
      map.set(slug, new Set(types));
    }
    (globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY] = map;
  }
  return (globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY];
}

/**
 * Check if a signal type has been shown for a specific project slug.
 * Uses disk-persisted per-project state (survives process restart).
 */
export function isProjectSignalShown(slug: string, t: DiscoverySignalType): boolean {
  const cache = getProjectShownSignalsCache();
  const projectSet = cache.get(slug);
  return projectSet ? projectSet.has(t) : false;
}

/**
 * Mark a signal type as shown for a specific project slug.
 * Persists to disk immediately (best-effort, non-fatal on failure).
 */
export function markProjectSignalShown(slug: string, t: DiscoverySignalType): void {
  const cache = getProjectShownSignalsCache();
  let projectSet = cache.get(slug);
  if (!projectSet) {
    projectSet = new Set<DiscoverySignalType>();
    cache.set(slug, projectSet);
  }
  projectSet.add(t);

  // Persist to disk: convert Map to flat object
  const data: Record<string, DiscoverySignalType[]> = {};
  for (const [s, set] of cache) {
    data[s] = Array.from(set);
  }
  persistProjectShownSignalsToDisk(data);
}

/** Reset per-project shown signals. Test helper. */
export function resetProjectShownSignals(): void {
  delete (globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY];
  try {
    if (existsSync(SHOWN_SIGNALS_FILE)) {
      writeFileSync(SHOWN_SIGNALS_FILE, "{}", "utf-8");
    }
  } catch {
    // ignore
  }
}
