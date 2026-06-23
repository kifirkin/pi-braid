/**
 * Session Health State - one source of truth for "is the session healthy?".
 *
 * Owned by the enforcement layer. Heartbeat informs, context-manager
 * executes, the recovery handler (Layer 3, deferred) decides what to do.
 *
 * State machine:
 *   healthy
 *     ├── (1+ transient) → healthy        (auto-cleared after N healthy turns)
 *     ├── (1 balance)     → balance       (no auto-clear; user must act)
 *     ├── (3+ transient)  → degraded      (cleared after 10 healthy turns)
 *     ├── (context_window)→ context_overflow  (cleared after compaction)
 *     ├── (auth)          → auth          (no auto-clear; user must act)
 *     └── (abort)         → aborted       (cleared on next turn_start)
 *
 * The state is per-session via getExtensionState. Consumers read it via
 * getSessionHealth(ctx); updates happen via recordLlmError / recordLlmSuccess
 * or explicit setSessionHealthMode.
 *
 * Layer 2 of the session-recovery proposal (2026-06-23). Skips the
 * recovery handler (Layer 3) — the state is populated, but the consumer
 * of the state is downstream code (consolidation gate in heartbeat,
 * the L1 environment hook, the session_health tool).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../lib/state/extension-state.js";
import type { ClassifiedLlmError, LlmErrorCategory } from "../../lib/errors/llm-error.js";

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
};

const DEGRADED_THRESHOLD = 3; // N consecutive transient errors → degraded
const HEALTHY_CLEAR_TURNS = 10; // N healthy turns to leave degraded
const BALANCE_CLEAR_MS = 5 * 60 * 1000; // 5 min without balance error → try healthy

export function getSessionHealth(ctx: ExtensionContext): SessionHealthState {
  return getExtensionState<SessionHealthState>(ctx, "session-health", () => ({
    ...DEFAULT_STATE,
    providerErrorsByCategory: emptyCategoryCounts(),
  }));
}

export function recordLlmError(ctx: ExtensionContext, err: ClassifiedLlmError): void {
  const s = getSessionHealth(ctx);
  s.lastError = err;
  s.providerErrorsByCategory[err.category]++;
  s.consecutiveErrors++;
  s.consecutiveHealthyTurns = 0;
  s.modeEnteredAt = s.modeEnteredAt ?? Date.now();
  if (s.firstErrorAt == null) s.firstErrorAt = Date.now();

  // Mode transitions driven by error category. Terminal categories
  // (balance, auth, context_window) jump immediately. Transient errors
  // accumulate. Abort is informational — does not change mode.
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

  // Recover from degraded/aborted after enough healthy turns.
  if (s.mode === "degraded" || s.mode === "aborted" || s.mode === "context_overflow") {
    if (s.consecutiveHealthyTurns >= HEALTHY_CLEAR_TURNS) {
      s.mode = "healthy";
      s.modeEnteredAt = Date.now();
      s.firstErrorAt = undefined;
      s.lastError = undefined;
    }
  }
  // Balance and auth do NOT auto-clear on success — the user must act
  // (top up, fix key). The next successful LLM call proves the provider
  // is back, but a single success after a long outage is not enough
  // evidence to leave balance mode. The session_health tool exposes
  // explicit mode reset for these.
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
  }
  // Reason is currently a no-op (kept for future audit log).
  void reason;
}

/**
 * Periodically re-check the balance-mode exit condition. The 5-minute
 * cooldown is conservative — if no balance error has fired in 5 minutes,
 * the provider probably has credit again. Hooked from enforcement's
 * session_start handler.
 */
export function tickSessionHealth(ctx: ExtensionContext): void {
  const s = getSessionHealth(ctx);
  if (s.mode !== "balance") return;
  if (!s.firstErrorAt) return;
  if (Date.now() - s.firstErrorAt < BALANCE_CLEAR_MS) return;
  // Time has passed without another balance error. Probe by clearing
  // the error window — the next LLM call will either succeed (moving
  // to healthy via recordLlmSuccess) or fail (re-entering balance).
  s.firstErrorAt = undefined;
  s.lastError = undefined;
  s.consecutiveErrors = 0;
  s.consecutiveHealthyTurns = 0;
  s.modeEnteredAt = Date.now();
}

export function resetSessionHealth(ctx: ExtensionContext, opts: { preserveHistory?: boolean } = {}): void {
  const s = getSessionHealth(ctx);
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
  }
}
