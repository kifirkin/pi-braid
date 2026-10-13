/**
 * Degradation Detector - Track performance metrics and detect degradation
 *
 * Session-scoped via ExtensionContext (in-memory). Global fallback for legacy callers.
 * File persistence is process-global (separate concern).
 */

import * as os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { saveStateImmediate, loadState } from "../state/async-storage.js";
import { createLogger } from "../core/logger.js";

import { degradationFilePath } from "../config/braid-paths.js";

const _log = createLogger("degradation-detector");

export interface PerformanceMetrics {
  timestamp: number;
  turnNumber: number;
  healthcheckScore: number;
  errorRate: number;
  avgTurnDurationMs: number;
  toolSuccessRate: number;
  memoryUsagePercent: number;
  consecutiveErrors: number;
  toolCalls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  tokenUsage: { input: number; output: number };
}

export interface DegradationConfig {
  healthcheckMinScore: number;
  errorRateMax: number;
  toolSuccessMin: number;
  checkIntervalMs: number;
  maxConsecutiveErrors: number;
}

export interface DegradationState {
  metrics: PerformanceMetrics[];
  config: DegradationConfig;
  isDegraded: boolean;
  lastHealthcheck: { score: number; timestamp: number } | null;
}

const DEFAULT_CONFIG: DegradationConfig = {
  healthcheckMinScore: 80,
  errorRateMax: 0.1,
  toolSuccessMin: 70,
  checkIntervalMs: 60000,
  maxConsecutiveErrors: 3,
};

// Global fallback (legacy - for tool handlers without ctx)
let _global: DegradationState = {
  metrics: [],
  config: { ...DEFAULT_CONFIG },
  isDegraded: false,
  lastHealthcheck: null,
};

function getStateFrom(ctx?: ExtensionContext): DegradationState {
  if (ctx) {
    return getExtensionState(ctx, "degradation-detector", () =>
      // Per-session scoping: enforcement reacts to the
      // CURRENT session's error history only. degradation.json (the 30-day
      // _global mirror loaded by loadMetrics) stays on disk for
      // analysis/telemetry, but a NEW session must not inherit a previous
      // session's stale error metrics — a polluted file poisoned the
      // errorRate trajectory from turn 1 and drove false-positive
      // rollbacks (see test-degradation-session-scoping.mjs). Config is
      // still carried over: operator-tuned thresholds are not history.
      // Live session writes are mirrored back into _global (telemetry).
      ({
        metrics: [],
        config: { ..._global.config },
        isDegraded: false,
        lastHealthcheck: null,
      }),
    );
  }
  // Global fallback: no ExtensionContext available, state is shared across sessions
  return _global;
}

/**
 * Telemetry mirror: append a live session's metric entry to the
 * process-global mirror (_global) so degradation.json keeps receiving data
 * for cross-session analysis. Enforcement state stays per-session; only the
 * telemetry copy is shared.
 */
function mirrorToGlobal(entry: PerformanceMetrics, isDegraded: boolean): void {
  _global.metrics.push(entry);
  if (_global.metrics.length > 100) _global.metrics = _global.metrics.slice(-100);
  _global.isDegraded = isDegraded;
}

/** Runtime type guard: is this an ExtensionContext?
 *
 * The guard keys on `sessionManager`, which exists on ctx in both old and
 * new pi-core (pi-core 0.84.4 removed `settingsManager` from
 * ExtensionContext, which is what exposed the older guard). A looser guard
 * makes `recordTurnMetrics(ctx, metrics)` fail the ctx check and treat the
 * ENTIRE ctx object as metrics — every heartbeat tick then embeds the full
 * session graph (sessionManager.fileEntries) and modelRegistry
 * (credentials!) into a metrics entry, ballooning degradation.json until
 * JSON.stringify throws 'Invalid string length' and the heap OOMs.
 */
function isCtx(val: unknown): val is ExtensionContext {
  return (
    typeof val === "object" &&
    val !== null &&
    ("sessionManager" in val || "modelRegistry" in val) &&
    !("turnNumber" in val && "toolCalls" in val)
  );
}

/**
 * Whitelist-copy metrics into a fresh scalar entry. NEVER spread the
 * argument: a ctx-shaped object passed by mistake must not drag the
 * session graph or credentials into persisted state (the
 * OOM: {...ctx} embedded an 8MB sessionManager per heartbeat tick).
 */
function toScalarEntry(
  src: Partial<PerformanceMetrics>,
  defaults: { errorRate: number; toolSuccessRate: number; consecutiveErrors: number },
  healthcheckScore: number,
): PerformanceMetrics {
  return {
    turnNumber: typeof src.turnNumber === "number" ? src.turnNumber : 0,
    avgTurnDurationMs: typeof src.avgTurnDurationMs === "number" ? src.avgTurnDurationMs : 0,
    toolCalls: typeof src.toolCalls === "number" ? src.toolCalls : 0,
    errors: typeof src.errors === "number" ? src.errors : 0,
    inputTokens: typeof src.inputTokens === "number" ? src.inputTokens : 0,
    outputTokens: typeof src.outputTokens === "number" ? src.outputTokens : 0,
    errorRate: typeof src.errorRate === "number" ? src.errorRate : defaults.errorRate,
    toolSuccessRate:
      typeof src.toolSuccessRate === "number" ? src.toolSuccessRate : defaults.toolSuccessRate,
    memoryUsagePercent:
      typeof src.memoryUsagePercent === "number"
        ? src.memoryUsagePercent
        : captureSystemMetrics().memoryUsagePercent,
    consecutiveErrors:
      typeof src.consecutiveErrors === "number"
        ? src.consecutiveErrors
        : defaults.consecutiveErrors,
    tokenUsage: {
      input: typeof src.tokenUsage?.input === "number" ? src.tokenUsage.input : 0,
      output: typeof src.tokenUsage?.output === "number" ? src.tokenUsage.output : 0,
    },
    timestamp: Date.now(),
    healthcheckScore,
  };
}

// ── Recovery-aware verdict ─────────────────────────────────────────────────
//
// The heartbeat feeds the session-CUMULATIVE error share
// (errors/toolCalls over the whole trajectory). That share decays
// asymptotically: a resolved error storm kept the verdict negative for
// dozens of clean turns (a live false whisper fired 23 minutes
// into a healthy session because 3 overnight errors held the cumulative
// rate above errorRateMax). The verdict therefore evaluates the TRAILING
// WINDOW (deltas of the cumulative counters between adjacent entries)
// plus an explicit clean-streak recovery override, never the decaying
// cumulative share itself.

/** Entries (heartbeat snapshots) in the trailing verdict window. */
const VERDICT_WINDOW = 5;
/** Clean snapshots (consecutiveErrors === 0) required to clear the metric
 *  verdict after a storm. One is not enough: the window may still carry
 *  the storm's deltas. */
const RECOVERY_CLEAN_ENTRIES = 2;
/** Below this many tool calls in the window the rate clauses are noise
 *  (1 error in 2 calls is 50% but not a storm); the storm clause still
 *  covers real streaks. */
const MIN_WINDOW_TOOL_CALLS = 3;

interface WindowStats {
  toolCalls: number;
  errors: number;
  errorRate: number;
  toolSuccessRate: number;
}

/** Deltas of the cumulative counters across the window — what actually
 *  HAPPENED recently, not the session-average. Adjacent-entry deltas only:
 *  each entry's absolute errors/toolCalls carry the whole session history. */
function windowStats(metrics: PerformanceMetrics[]): WindowStats {
  let errors = 0;
  let toolCalls = 0;
  for (let i = 1; i < metrics.length; i++) {
    errors += Math.max(0, metrics[i].errors - metrics[i - 1].errors);
    toolCalls += Math.max(0, metrics[i].toolCalls - metrics[i - 1].toolCalls);
  }
  return {
    errors,
    toolCalls,
    errorRate: toolCalls > 0 ? errors / toolCalls : 0,
    toolSuccessRate: toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100,
  };
}

function updateDegradationStatusFrom(state: DegradationState): void {
  const recent = state.metrics.slice(-VERDICT_WINDOW);
  if (recent.length === 0) {
    state.isDegraded = false;
    return;
  }
  // Storm clause: consecutive means the CURRENT trailing streak (the
  // newest entry carries the scheduler's trailing-error count). A stale
  // window entry with a high count must not hold the verdict — that
  // `some()` is what kept degraded latched after the storm ended.
  const newest = recent[recent.length - 1];
  if (newest.consecutiveErrors >= state.config.maxConsecutiveErrors) {
    state.isDegraded = true;
    return;
  }
  if (state.lastHealthcheck && state.lastHealthcheck.score < state.config.healthcheckMinScore) {
    state.isDegraded = true;
    return;
  }
  // Recovery override: a streak of clean snapshots proves current tool
  // calls succeed; older window deltas are resolved history. Clear the
  // metric verdict even if the window average is still elevated.
  let cleanStreak = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i].consecutiveErrors === 0; i--) cleanStreak++;
  if (cleanStreak >= RECOVERY_CLEAN_ENTRIES) {
    state.isDegraded = false;
    return;
  }
  const win = windowStats(recent);
  if (win.toolCalls >= MIN_WINDOW_TOOL_CALLS) {
    if (win.errorRate > state.config.errorRateMax) {
      state.isDegraded = true;
      return;
    }
    if (win.toolSuccessRate < state.config.toolSuccessMin) {
      state.isDegraded = true;
      return;
    }
  }
  state.isDegraded = false;
}

// ── Public API (ctx-aware) ───────────────────────────────────────────────────────

export function getConfig(ctx?: ExtensionContext): DegradationConfig {
  return { ...getStateFrom(ctx).config };
}

// Overload: legacy call (no ctx) or ctx-scoped call
export function updateConfig(partial: Partial<DegradationConfig>): void;
export function updateConfig(ctx: ExtensionContext, partial: Partial<DegradationConfig>): void;
export function updateConfig(
  ctxOrPartial: ExtensionContext | Partial<DegradationConfig>,
  partial?: Partial<DegradationConfig>,
): void {
  const ctx =
    typeof ctxOrPartial === "object" && !("healthcheckMinScore" in ctxOrPartial)
      ? (ctxOrPartial as ExtensionContext)
      : undefined;
  const config = ctx ? partial! : (ctxOrPartial as Partial<DegradationConfig>);
  getStateFrom(ctx).config = { ...getStateFrom(ctx).config, ...config };
}

export function recordTurnMetrics(
  metrics: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void;
export function recordTurnMetrics(
  ctx: ExtensionContext,
  metrics: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void;
export function recordTurnMetrics(
  ctxOrMetrics: ExtensionContext | Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
  metrics?: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void {
  const ctx = isCtx(ctxOrMetrics) ? ctxOrMetrics : undefined;
  const actualMetrics = isCtx(ctxOrMetrics)
    ? (metrics as Partial<PerformanceMetrics> | undefined)
    : (ctxOrMetrics as Partial<PerformanceMetrics>);
  if (!actualMetrics) {
    // ctx passed with no metrics object (or a stray one-arg ctx call) —
    // record nothing rather than guessing. Logging instead of throwing:
    // metrics are advisory, a bad call must not break the turn_end handler.
    _log.warn("recordTurnMetrics called with a ctx-shaped argument and no metrics — entry skipped");
    return;
  }
  const s = getStateFrom(ctx);

  const toolCalls = actualMetrics.toolCalls || 0;
  const errors = actualMetrics.errors || 0;
  const errorRate = actualMetrics.errorRate ?? (toolCalls > 0 ? errors / toolCalls : 0);
  const toolSuccessRate =
    actualMetrics.toolSuccessRate ??
    (toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100);

  const entry = toScalarEntry(
    actualMetrics,
    { errorRate, toolSuccessRate, consecutiveErrors: errors > 0 ? errors : 0 },
    s.lastHealthcheck?.score ?? 100,
  );
  s.metrics.push(entry);
  if (s.metrics.length > 100) s.metrics = s.metrics.slice(-100);
  updateDegradationStatusFrom(s);
  if (ctx) mirrorToGlobal(entry, s.isDegraded);
}

export function recordError(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  const last = s.metrics[s.metrics.length - 1];
  if (last) {
    last.consecutiveErrors++;
    last.errorRate = Math.min(1, last.errorRate + 0.1);
  }
}

export function recordToolSuccess(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  const last = s.metrics[s.metrics.length - 1];
  if (last) {
    last.consecutiveErrors = 0;
  }
}

export function isDegraded(ctx?: ExtensionContext): boolean {
  return getStateFrom(ctx).isDegraded;
}

export function getDegradationReasons(ctx?: ExtensionContext): string[] {
  const reasons: string[] = [];
  const s = getStateFrom(ctx);
  const recent = s.metrics.slice(-VERDICT_WINDOW);

  if (recent.length > 0) {
    // Mirror updateDegradationStatusFrom exactly: the newest entry's
    // trailing streak (not `some()` over stale entries) and the trailing
    // window's deltas (not the decaying cumulative share).
    const newest = recent[recent.length - 1];
    if (newest.consecutiveErrors >= s.config.maxConsecutiveErrors)
      reasons.push(`High consecutive errors (max: ${newest.consecutiveErrors})`);
    let cleanStreak = 0;
    for (let i = recent.length - 1; i >= 0 && recent[i].consecutiveErrors === 0; i--) cleanStreak++;
    if (cleanStreak < RECOVERY_CLEAN_ENTRIES) {
      const win = windowStats(recent);
      if (win.toolCalls >= MIN_WINDOW_TOOL_CALLS) {
        if (win.errorRate > s.config.errorRateMax)
          reasons.push(`High error rate: ${(win.errorRate * 100).toFixed(1)}%`);
        if (win.toolSuccessRate < s.config.toolSuccessMin)
          reasons.push(`Low tool success: ${win.toolSuccessRate.toFixed(1)}%`);
      }
    }
  }

  // Always check healthcheck score (doesn't depend on having metrics)
  if (s.lastHealthcheck && s.lastHealthcheck.score < s.config.healthcheckMinScore)
    reasons.push(`Low healthcheck: ${s.lastHealthcheck.score}%`);

  return reasons;
}

export function getRecentMetrics(count?: number): PerformanceMetrics[];
export function getRecentMetrics(ctx: ExtensionContext, count?: number): PerformanceMetrics[];
export function getRecentMetrics(
  ctxOrCount?: ExtensionContext | number,
  count?: number,
): PerformanceMetrics[] {
  const ctx = isCtx(ctxOrCount) ? ctxOrCount : undefined;
  const actualCount = typeof ctxOrCount === "number" ? ctxOrCount : count;
  return getStateFrom(ctx).metrics.slice(actualCount ? -actualCount : undefined);
}

export function getAllMetrics(ctx?: ExtensionContext): PerformanceMetrics[] {
  return [...getStateFrom(ctx).metrics];
}

export function getMetricsSummary(): {
  totalTurns: number;
  avgHealthcheck: number;
  avgErrorRate: number;
  avgToolSuccess: number;
  degraded: boolean;
  reasons: string[];
};
export function getMetricsSummary(ctx: ExtensionContext): {
  totalTurns: number;
  avgHealthcheck: number;
  avgErrorRate: number;
  avgToolSuccess: number;
  degraded: boolean;
  reasons: string[];
};
export function getMetricsSummary(ctx?: ExtensionContext) {
  const s = getStateFrom(ctx);
  const recent = s.metrics;
  if (recent.length === 0)
    return {
      totalTurns: 0,
      avgHealthcheck: 100,
      avgErrorRate: 0,
      avgToolSuccess: 100,
      degraded: false,
      reasons: [],
    };
  return {
    totalTurns: recent.length,
    avgHealthcheck: recent.reduce((a, m) => a + m.healthcheckScore, 0) / recent.length,
    avgErrorRate: recent.reduce((a, m) => a + m.errorRate, 0) / recent.length,
    avgToolSuccess: recent.reduce((a, m) => a + m.toolSuccessRate, 0) / recent.length,
    degraded: isDegraded(ctx),
    reasons: getDegradationReasons(ctx),
  };
}

export async function saveMetrics(): Promise<void> {
  try {
    await saveStateImmediate(degradationFilePath(), _global);
  } catch (error) {
    _log.error("Failed to save degradation metrics:", error);
  }
}

// ── Sanitize-on-load (OOM follow-up) ─────────────────────────────────
//
// The write side whitelists via toScalarEntry, but loadMetrics() had NO
// filter: a polluted degradation.json on disk was JSON-parsed and spread
// straight into _global at startup, re-introducing the ctx-shaped entries
// (9MB sessionManager graphs + modelRegistry credentials) the write-side
// guard exists to prevent — and re-stringifying them on every heartbeat.
// Rebuild through the whitelist instead of spreading. Never log dropped
// entry CONTENT — counts only (credentials may be inside polluted entries).

/** Entries older than this are stale pollution from before the purge. */
const METRICS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Strings longer than this inside a metric entry are the pollution
 *  signature (embedded session graphs), not metric data. */
const METRIC_ENTRY_MAX_STRING_CHARS = 256;

/** Scalar values only: primitives (short strings bounded above) or the
 *  plain {input, output} token object. Functions, arrays, nested provider
 *  objects, and huge strings all fail — the ctx pollution signature. */
function isScalarMetricValue(val: unknown): boolean {
  if (val === null) return true;
  const t = typeof val;
  if (t === "number" || t === "boolean") return true;
  if (t === "string") return (val as string).length <= METRIC_ENTRY_MAX_STRING_CHARS;
  if (t === "object") {
    // Only the tokenUsage shape: exactly { input: number, output: number }.
    const o = val as Record<string, unknown>;
    return (
      !Array.isArray(o) &&
      Object.keys(o).length === 2 &&
      "input" in o &&
      "output" in o &&
      typeof o.input === "number" &&
      typeof o.output === "number"
    );
  }
  return false;
}

/** A loadable metric entry: plain object, every value scalar, timestamp
 *  present and fresh (<= 30 days). Non-conforming entries are DROPPED,
 *  not repaired. */
function isLoadableMetricEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const o = entry as Record<string, unknown>;
  if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return false;
  if (Date.now() - o.timestamp > METRICS_MAX_AGE_MS) return false;
  for (const key of Object.keys(o)) {
    if (!isScalarMetricValue(o[key])) return false;
  }
  return true;
}

/**
 * Rebuild a DegradationState from whatever is on disk, whitelist-first.
 * Unknown top-level keys are NEVER copied; every field passes a shape
 * check. `dropped` counts filtered metric entries (scalar-check failures,
 * stale timestamps, and the >100 cap) for the count-only warn log.
 */
function sanitizeLoadedState(loaded: unknown): DegradationState {
  const next: DegradationState = {
    metrics: [],
    config: { ...DEFAULT_CONFIG },
    isDegraded: _global.isDegraded,
    lastHealthcheck: _global.lastHealthcheck,
  };
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) return next;

  const src = loaded as Record<string, unknown>;
  let dropped = 0;
  let unknownConfigKeys = 0;

  // metrics: scalar entries only, fresh, capped to the LAST 100 (the
  // write-side cap) — rebuilt via toScalarEntry, never spread.
  if (Array.isArray(src.metrics)) {
    const kept: PerformanceMetrics[] = [];
    for (const raw of src.metrics) {
      if (isLoadableMetricEntry(raw)) {
        const entry = raw as Partial<PerformanceMetrics>;
        kept.push(
          toScalarEntry(
            entry,
            { errorRate: 0, toolSuccessRate: 100, consecutiveErrors: 0 },
            typeof entry.healthcheckScore === "number" ? entry.healthcheckScore : 100,
          ),
        );
      } else {
        dropped++;
      }
    }
    if (kept.length > 100) {
      dropped += kept.length - 100;
      next.metrics = kept.slice(-100);
    } else {
      next.metrics = kept;
    }
  }

  // config: known scalar fields only, unknown keys dropped.
  if (typeof src.config === "object" && src.config !== null && !Array.isArray(src.config)) {
    const cfg = src.config as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof DegradationConfig)[]) {
      if (typeof cfg[key] === "number") next.config[key] = cfg[key];
    }
    unknownConfigKeys = Object.keys(cfg).filter((k) => !(k in DEFAULT_CONFIG)).length;
  }

  // lastHealthcheck: shape-valid only (numeric score + timestamp).
  const lh = src.lastHealthcheck;
  if (typeof lh === "object" && lh !== null && !Array.isArray(lh)) {
    const { score, timestamp } = lh as Record<string, unknown>;
    if (
      typeof score === "number" &&
      Number.isFinite(score) &&
      typeof timestamp === "number" &&
      Number.isFinite(timestamp)
    ) {
      next.lastHealthcheck = { score, timestamp };
    }
  }

  // Remaining state fields: booleans only.
  if (typeof src.isDegraded === "boolean") next.isDegraded = src.isDegraded;

  if (dropped > 0 || unknownConfigKeys > 0) {
    _log.warn(
      `loadMetrics: sanitized loaded state — dropped ${dropped} metric ` +
        `entr${dropped === 1 ? "y" : "ies"}, ignored ${unknownConfigKeys} unknown ` +
        `config key${unknownConfigKeys === 1 ? "" : "s"} (counts only, content never logged)`,
    );
  }
  return next;
}

export async function loadMetrics(): Promise<void> {
  try {
    const loaded = await loadState<unknown>(degradationFilePath());
    if (loaded) {
      _global = sanitizeLoadedState(loaded);
    }
  } catch (error) {
    _log.error("Failed to load degradation metrics:", error);
  }
}

export function resetMetrics(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  s.metrics = [];
  s.isDegraded = false;
  s.lastHealthcheck = null;
}

export function captureSystemMetrics(): Pick<PerformanceMetrics, "memoryUsagePercent"> {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  return { memoryUsagePercent: ((totalMem - freeMem) / totalMem) * 100 };
}
