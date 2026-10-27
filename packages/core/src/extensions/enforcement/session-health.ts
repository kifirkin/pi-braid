/**
 * Session Health State - one source of truth for "is the session healthy?".
 *
 * Owned by the enforcement layer. Heartbeat informs, context-manager
 * executes, the recovery handler (Layer 3, deferred) decides what to do.
 *
 * State machine:
 *   healthy
 *     ├── (1+ transient) -> healthy (auto-cleared after N healthy turns)
 *     ├── (1 balance) -> balance (no auto-clear; user must act)
 *     ├── (3+ transient) -> degraded (cleared after 10 healthy turns)
 *     ├── (context_window)-> context_overflow (cleared after compaction)
 *     ├── (auth) -> auth (no auto-clear; user must act)
 *     └── (abort) -> aborted (cleared on next turn_start)
 *
 * The state is per-session via getExtensionState. Consumers read it via
 * getSessionHealth(ctx); updates happen via recordLlmError / recordLlmSuccess
 * or explicit setSessionHealthMode.
 *
 * Layer 2 of the session-recovery proposal. Skips the
 * recovery handler (Layer 3) -- the state is populated, but the consumer
 * of the state is downstream code (consolidation gate in heartbeat,
 * the L1 environment hook, the session_health tool).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../lib/state/extension-state.js";
import type { ClassifiedLlmError, LlmErrorCategory } from "../../lib/errors/llm-error.js";
import { getRouteBreakerConfig } from "../../lib/config/braid-settings.js";

export type SessionHealthMode =
  | "healthy"
  | "degraded"
  | "balance"
  | "context_overflow"
  | "auth"
  | "aborted";

export interface SessionHealthState {
  mode: SessionHealthMode;
  /** Last error classification (omitted when mode is healthy). */
  lastError?: ClassifiedLlmError;
  consecutiveErrors: number;
  consecutiveHealthyTurns: number;
  /** ms timestamp of the first error in the current degraded window. */
  firstErrorAt?: number;
  /** ms timestamp of the current mode's entry. */
  modeEnteredAt?: number;
  /** Counts errors by category since session start. Diagnostic only. */
  providerErrorsByCategory: Record<LlmErrorCategory, number>;
  /** Counts successful LLM calls since session start. Diagnostic only. */
  providerSuccessCount: number;
  /**
   * How many heartbeat consolidation candidates were skipped per health mode
   * this session — without it, a latched auth mode runs for minutes with
   * zero visibility. Bumped from the heartbeat agent_end consolidation gate
   * via recordConsolidationSkip().
   */
  consolidationSkipsByMode: Partial<Record<SessionHealthMode, number>>;
  /**
   * Terminal-class (auth/balance) LLM errors since the last completed clean
   * turn or explicit reset. Monotonic between resets: a latch, not a window.
   * `tickSessionHealth`'s mode auto-clear never touches it — deriving it from
   * `mode` would close the guard during the quiet gaps of a long outage.
   */
  terminalErrorsSinceHealthyTurn: number;
  /**
   * ms timestamp of the first time the counter reached TERMINAL_BREAKER_N in
   * the current episode. Diagnostic; cleared together with the counter.
   */
  breakerOpenedAt?: number;
  /**
   * Provider failures of any class except context_window/abort since the last
   * successful LLM call. The route-failure latch reads this; only an explicit
   * reset (clean turn, provider success, route change, owner recovery,
   * session start) lowers it.
   */
  routeErrorsSinceHealthyTurn: number;
  /**
   * ms timestamp of the first time routeErrorsSinceHealthyTurn reached the
   * configured threshold in the current episode. One half of the floor's
   * clock; undefined while the latch has never opened.
   */
  routeLatchOpenedAt?: number;
  /**
   * ms timestamp of the last turn the floor released while the latch stayed
   * open. The other half of the floor's clock: the predicate allows exactly
   * one self-started turn per `floorMs`, then this stamp closes the gate for
   * the next window.
   */
  routeLatchLastReleaseAt?: number;
}

function emptyCategoryCounts(): Record<LlmErrorCategory, number> {
  return {
    balance: 0,
    rate_limit: 0,
    context_window: 0,
    transient: 0,
    abort: 0,
    auth: 0,
    unknown: 0,
  };
}

const DEFAULT_STATE: SessionHealthState = {
  mode: "healthy",
  consecutiveErrors: 0,
  consecutiveHealthyTurns: 0,
  providerErrorsByCategory: emptyCategoryCounts(),
  providerSuccessCount: 0,
  consolidationSkipsByMode: {},
  terminalErrorsSinceHealthyTurn: 0,
  routeErrorsSinceHealthyTurn: 0,
};

/**
 * Terminal-category errors (auth/balance) that must accumulate since the last
 * clean turn before a wake fire stops starting a turn. Chosen to equal the
 * watchdog's quotaErrors so the two guards cannot disagree about when a route
 * is down; one terminal error is not evidence of a terminal route (a 401 was
 * observed followed by a pass-through success, and 401/402 mix on one key).
 */
export const TERMINAL_BREAKER_N = 3;

const DEGRADED_THRESHOLD = 3; // N consecutive transient errors -> degraded
const HEALTHY_CLEAR_TURNS = 10; // N healthy turns to leave degraded
// Bounded re-probe cadence shared by balance AND auth: after this
// long without another error of the latched mode, tickSessionHealth clears
// the error window so the next LLM call re-probes the provider.
const HEALTH_PROBE_CLEAR_MS = 5 * 60 * 1000; // 5 min

export function getSessionHealth(ctx: ExtensionContext): SessionHealthState {
  const s = getExtensionState<SessionHealthState>(ctx, "session-health", () => ({
    ...DEFAULT_STATE,
    providerErrorsByCategory: emptyCategoryCounts(),
    consolidationSkipsByMode: {},
  }));
  // Older in-session states predate these fields — backfill defensively.
  if (!s.consolidationSkipsByMode) s.consolidationSkipsByMode = {};
  if (typeof s.terminalErrorsSinceHealthyTurn !== "number") {
    s.terminalErrorsSinceHealthyTurn = 0;
  }
  if (typeof s.routeErrorsSinceHealthyTurn !== "number") {
    s.routeErrorsSinceHealthyTurn = 0;
  }
  return s;
}

/**
 * Would a new turn start against a route this session has already seen fail
 * terminally? Latch state only — no provider/model/error names, so callers in
 * generic layers (the timer wake path) cannot learn a domain fact from it.
 *
 * `threshold` lets a caller pass the configured bound for the terminal
 * counter; the default keeps the built-in N. Open-ness is derived from the
 * monotonic counter, which only the explicit reset signals (session_start,
 * owner recovery, route change) and a clean wake turn lower — hence "latch".
 *
 * The route disjunct is the second latch on the same question: a route that
 * fails every self-started turn parks them too, on its own configured
 * threshold and floor. It is asked here, once, so the three seams that
 * self-start turns cannot each keep their own answer.
 */
export function isTurnStartBlocked(
  ctx: ExtensionContext,
  threshold: number = TERMINAL_BREAKER_N,
): boolean {
  const s = getSessionHealth(ctx);
  return s.terminalErrorsSinceHealthyTurn >= threshold || isRouteLatchOpen(ctx);
}

/**
 * Is the route-failure latch open right now? The route-only half of
 * `isTurnStartBlocked`, for the two seams that must not inherit the terminal
 * wake policy: a watchdog escalation and an explicitly-waking whisper never
 * consulted the terminal breaker, so their demotion has to key on the route
 * fact alone. `braid.session.routeBreaker.enabled = false` answers false
 * unconditionally, which is what makes the off switch inert rather than
 * partial.
 *
 * The floor is a release, not a bypass: while the latch stays open the
 * predicate lets exactly one self-started turn through per `floorMs` and
 * stamps the release, so a parked session cannot starve and cannot loop.
 */
export function isRouteLatchOpen(ctx: ExtensionContext): boolean {
  const cfg = getRouteBreakerConfig();
  if (!cfg.enabled) return false;
  const s = getSessionHealth(ctx);
  if (s.routeErrorsSinceHealthyTurn < cfg.threshold) return false;
  const anchor = Math.max(s.routeLatchOpenedAt ?? 0, s.routeLatchLastReleaseAt ?? 0);
  if (Date.now() - anchor < cfg.floorMs) return true;
  s.routeLatchLastReleaseAt = Date.now();
  return false;
}

/**
 * Count one provider failure for the route latch. The category decides
 * whether it counts: a context-window overflow and an operator abort are not
 * evidence about the route, and counting them would park the very wakes a
 * recovery needs. Read by `isRouteLatchOpen` only — deliberately not folded
 * into `recordLlmError`, whose consumers (mode, terminal counter, degraded
 * rows) must keep their own semantics.
 */
export function recordRouteFailure(ctx: ExtensionContext, category: LlmErrorCategory): void {
  if (category === "context_window" || category === "abort") return;
  const s = getSessionHealth(ctx);
  s.routeErrorsSinceHealthyTurn++;
  if (s.routeLatchOpenedAt === undefined) {
    const cfg = getRouteBreakerConfig();
    if (s.routeErrorsSinceHealthyTurn >= cfg.threshold) s.routeLatchOpenedAt = Date.now();
  }
}

/** Drop the route latch and every stamp the floor reads. */
function clearRouteLatch(s: SessionHealthState): void {
  s.routeErrorsSinceHealthyTurn = 0;
  s.routeLatchOpenedAt = undefined;
  s.routeLatchLastReleaseAt = undefined;
}

/** Clear the latch and its counter (the reset signals share this). */
export function clearTerminalBreaker(ctx: ExtensionContext): void {
  const s = getSessionHealth(ctx);
  s.terminalErrorsSinceHealthyTurn = 0;
  s.breakerOpenedAt = undefined;
  // A clean turn, a route change, an owner recovery and a session start all
  // mean the route is being retried from a fresh premise: the route latch
  // releases on the same signals.
  clearRouteLatch(s);
}

export function recordLlmError(ctx: ExtensionContext, err: ClassifiedLlmError): void {
  const s = getSessionHealth(ctx);
  s.lastError = err;
  s.providerErrorsByCategory[err.category]++;
  s.consecutiveErrors++;
  s.consecutiveHealthyTurns = 0;
  s.modeEnteredAt = s.modeEnteredAt ?? Date.now();
  if (s.firstErrorAt == null) s.firstErrorAt = Date.now();

  // Terminal-category errors feed the wake breaker's own counter. It is
  // deliberately independent of `mode` and of the transient streak: rate
  // limits are excluded here (a throttled ring must not stop waking).
  if (err.category === "auth" || err.category === "balance") {
    s.terminalErrorsSinceHealthyTurn++;
    if (s.breakerOpenedAt == null && s.terminalErrorsSinceHealthyTurn >= TERMINAL_BREAKER_N) {
      s.breakerOpenedAt = Date.now();
    }
  }

  // Mode transitions driven by error category. Terminal categories
  // (balance, auth, context_window) jump immediately. Transient errors
  // accumulate. Abort is informational -- does not change mode.
  switch (err.category) {
    case "balance":
      s.mode = "balance";
      s.modeEnteredAt = Date.now();
      break;
    case "auth":
      s.mode = "auth";
      s.modeEnteredAt = Date.now();
      break;
    case "context_window":
      s.mode = "context_overflow";
      s.modeEnteredAt = Date.now();
      break;
    case "abort":
      s.mode = "aborted";
      s.modeEnteredAt = Date.now();
      break;
    case "transient":
    case "rate_limit":
    case "unknown":
      if (s.consecutiveErrors >= DEGRADED_THRESHOLD && s.mode === "healthy") {
        s.mode = "degraded";
        s.modeEnteredAt = Date.now();
      }
      break;
  }
}

export function recordLlmSuccess(ctx: ExtensionContext): void {
  const s = getSessionHealth(ctx);
  s.providerSuccessCount++;
  s.consecutiveErrors = 0;
  s.consecutiveHealthyTurns++;

  // Any successful provider call is a release signal for the route latch: the
  // route just answered, so the premise the latch parks on ("every attempt on
  // this route fails") is false. Deliberately not gated on a run outcome — a
  // parked session makes no self-started call, so this is how it re-opens.
  clearRouteLatch(s);

  // Recover from degraded/aborted after enough healthy turns.
  if (s.mode === "degraded" || s.mode === "aborted" || s.mode === "context_overflow") {
    if (s.consecutiveHealthyTurns >= HEALTHY_CLEAR_TURNS) {
      clearToHealthy(s);
    }
  }

  // Balance and auth auto-clear via two bounded paths; without this, one
  // 401 burst would latch auth for the whole session and skip heartbeat
  // consolidation permanently.
  //   1. Probe: tickSessionHealth cleared the error window (firstErrorAt
  //      gone) after the quiet period; a successful LLM call proves the
  //      provider is back. A fresh 401 re-latches immediately (recordLlmError
  //      case "auth" is unchanged — the initial escalation is not weakened).
  //   2. Streak: without a probe tick, a sufficient consecutive-success
  //      streak is evidence the provider recovered.
  if (s.mode === "balance" || s.mode === "auth") {
    if (s.firstErrorAt == null || s.consecutiveHealthyTurns >= HEALTHY_CLEAR_TURNS) {
      clearToHealthy(s);
    }
  }
}

/** Clear a blocking mode to healthy (shared by the recovery paths). */
function clearToHealthy(s: SessionHealthState): void {
  s.mode = "healthy";
  s.modeEnteredAt = Date.now();
  s.firstErrorAt = undefined;
  s.lastError = undefined;
}

export function setSessionHealthMode(
  ctx: ExtensionContext,
  mode: SessionHealthMode,
  reason?: string,
): void {
  const s = getSessionHealth(ctx);
  s.mode = mode;
  s.modeEnteredAt = Date.now();
  if (mode === "healthy") {
    s.consecutiveErrors = 0;
    s.consecutiveHealthyTurns = 0;
    s.firstErrorAt = undefined;
    s.lastError = undefined;
    // Owner recovery is an explicit close signal for the wake breaker too.
    clearTerminalBreaker(ctx);
  }
  // Reason is currently a no-op (kept for future audit log).
  void reason;
}

/**
 * Count a skipped heartbeat consolidation by health mode (called from the
 * heartbeat agent_end gate). Diagnostic counter.
 */
export function recordConsolidationSkip(ctx: ExtensionContext, mode: SessionHealthMode): void {
  const s = getSessionHealth(ctx);
  if (!s.consolidationSkipsByMode) s.consolidationSkipsByMode = {};
  s.consolidationSkipsByMode[mode] = (s.consolidationSkipsByMode[mode] ?? 0) + 1;
}

/**
 * Periodically re-check the balance/auth-mode exit condition.
 * The 5-minute probe window is conservative -- if no error of the latched
 * mode has fired in 5 minutes, the provider has probably recovered. Clearing
 * the error window re-arms the probe: the next LLM call either succeeds
 * (recordLlmSuccess clears the mode) or fails (the same error category
 * re-latches immediately — a genuine 401 burst still latches fast).
 * Hooked from enforcement's session_start LLM listeners (fires per LLM
 * outcome; the success-streak path in recordLlmSuccess covers sessions
 * where errors have simply stopped).
 */
export function tickSessionHealth(ctx: ExtensionContext): void {
  const s = getSessionHealth(ctx);
  if (s.mode !== "balance" && s.mode !== "auth") return;
  if (!s.firstErrorAt) return;
  if (Date.now() - s.firstErrorAt < HEALTH_PROBE_CLEAR_MS) return;
  // Time has passed without another error of this mode. Probe by clearing
  // the error window (mode stays latched until a call proves recovery).
  s.firstErrorAt = undefined;
  s.lastError = undefined;
  s.consecutiveErrors = 0;
  s.consecutiveHealthyTurns = 0;
  s.modeEnteredAt = Date.now();
}

export function resetSessionHealth(
  ctx: ExtensionContext,
  opts: { preserveHistory?: boolean } = {},
): void {
  const s = getSessionHealth(ctx);
  clearTerminalBreaker(ctx);
  if (opts.preserveHistory) {
    // Keep category counts and success count for diagnostics, reset mode.
    s.mode = "healthy";
    s.consecutiveErrors = 0;
    s.consecutiveHealthyTurns = 0;
    s.firstErrorAt = undefined;
    s.lastError = undefined;
    s.modeEnteredAt = Date.now();
  } else {
    s.mode = "healthy";
    s.consecutiveErrors = 0;
    s.consecutiveHealthyTurns = 0;
    s.firstErrorAt = undefined;
    s.lastError = undefined;
    s.modeEnteredAt = Date.now();
    s.providerErrorsByCategory = emptyCategoryCounts();
    s.providerSuccessCount = 0;
    s.consolidationSkipsByMode = {};
  }
}
