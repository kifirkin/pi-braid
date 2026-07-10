/**
 * [stakes-invariant] - 2026-06-23: STAKES_AWARENESS was removed from the
 * agent's prompt (was in behavioral-guardrails.ts, deleted 2026-06-29
 * along with the entire value-statement layer) because it was a meta-
 * directive about the evaluation pipeline, not about agent behavior.
 * The invariant it encoded is preserved HERE: this module and the rest
 * of lib/ai/ must never include downstream-stakes signals in the LLM
 * call context. The judge (whether human, LLM-as-judge, or programmatic)
 * evaluates pure correctness; the agent being judged sees no signal
 * about what the judgment is for. The test-arxiv-citations.mjs and
 * test-prompt-builder-directive.mjs suites verify the agent-side invariant.
 *
 * Wraps pi-ai's completeSimple with a two-tier retry strategy:
 *
 * Tier 1 - Provider SDK: Handles fast transient blips (quick network drops)
 *           via completeSimple's maxRetries (default: 1 SDK-level retry).
 * Tier 2 - This module: Handles sustained rate limits with longer backoff
 *           (5s -> 15s -> 30s -> 60s) so the provider gets real cooldown time.
 *
 * A rate-limit circuit breaker skips calls for 60s after a 429 to avoid
 * cascading failures during provider congestion.
 *
 * Usage:
 *   callLlm(model, apiKey, systemPrompt, userPrompt, options)
 *   Returns { text } on success or { error } on failure (discriminated union).
 *   const text = result.text;
 */

import type { Api, Context, Model } from "@earendil-works/pi-ai";
// pi-ai v0.80 moved `completeSimple` out of the top-level export.
// It's still available at the `/compat` subpath (compat.d.ts:64) as a
// "Temporary compatibility entrypoint". The forward-looking path is
// `Models.completeSimple()` on a `createModels()` instance (models.d.ts:82).
//
// We REMAIN on the compat import because custom providers (a0venice,
// openrouter-custom) are registered via pi.registerProvider() which goes
// through pi-core's modelRegistry, not the Models instance. The compat
// path uses the same modelRegistry so it finds them. The Models instance
// (created by initModels() in models-init.ts) has its own providers Map
// and only contains built-in providers from pi-ai/providers/all.js.
//
// The Models instance DOES have a setProvider() method (models.d.ts:86)
// and pi-ai exports createProvider() to build Provider objects. The
// correct migration path is:
//   1. Update pi-braid-providers to also call models.setProvider() with
//      the same provider configs, using createProvider() from pi-ai.
//   2. Once pi-braid-providers registers on the Models instance, delete
//      the compat import and switch to getModels() exclusively.
// See: src/lib/ai/AGENTS.md, docs/ROADMAP.md (P1 compat cleanup).
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createLogger } from "../core/logger.js";

const log = createLogger("llm-call");

// ── Test-only injection point ────────────────────────────────────────────────
//
// Production code calls `completeSimple` directly from pi-ai (via the
// /compat subpath on v0.80+). For behavioral tests (timeout, signal abort,
// retry behavior), we need to stub completeSimple without going through a
// real LLM provider. The injection is opt-in: production behavior is
// identical unless
// `__setCompleteSimpleForTest` is called. The setter is intentionally
// a module-private mutation (not a parameter on callLlm) because
// adding test-only parameters to the public API would pollute the
// surface and invite callers to "configure" test hooks by accident.
//
// Usage in tests:
//   import { __setCompleteSimpleForTest, __resetCompleteSimpleForTest } from "...";
//   __setCompleteSimpleForTest(async (model, ctx, opts) => {
//     // hang until aborted, then return error
//     return new Promise((resolve) => {
//       opts.signal.addEventListener("abort", () => resolve({ ... }));
//     });
//   });
//   // ... run test ...
//   __resetCompleteSimpleForTest();
//
// The setter only takes effect for the current process. There is no
// global state mutation across test files unless they import the
// module in the same process - which is fine for the test runner we
// use (one process per .mjs file via spawnSync).

// The _completeSimple override slot is for test injection only.
// Production code always uses the compat import (see the module-level
// comment for why we stay on compat).
let _completeSimpleOverride: typeof completeSimple | null = null;

function _resolveCompleteSimple(): typeof completeSimple {
  return _completeSimpleOverride ?? completeSimple;
}

/**
 * @internal Test-only: override completeSimple for behavioral testing.
 * Pass `null` to reset to the production implementation. NOT for use
 * in production code paths.
 */
export function __setCompleteSimpleForTest(
  fn: typeof completeSimple | null,
): void {
  _completeSimpleOverride = fn ?? null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default outer retry attempts (each may trigger SDK inner retries). */
const DEFAULT_MAX_RETRIES = 5;

/** SDK-level retries per attempt. */
const DEFAULT_SDK_RETRIES = 3;

/** Cooldown after a rate-limit hit before attempting calls again. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Track the cooldown expiration deadline. */
let rateLimitCooldownUntil = 0;

// ── Per-model concurrency limiter ────────────────────────────────────────────

/** Max concurrent in-flight LLM calls per model. Provider-side rate
 *  limits are typically expressed as requests-per-second or concurrent-
 *  connections; serializing bursts through a small pool prevents 4
 *  parallel classify() calls (e.g., input-critic's 4-way Promise.allSettled)
 *  from triggering rate-limits. The default of 2 means at most 2 calls
 *  to a given model are in-flight at any time; the rest queue. */
const MAX_CONCURRENT_PER_MODEL = 2;

/** Per-model semaphore: active count + waiters. */
type ModelLock = { active: number; waiters: Array<() => void> };
const _modelLocks = new Map<string, ModelLock>();

// ── LLM call listeners (Layer 2 wiring) ─────────────────────────────────────
//
// The session-recovery proposal (2026-06-23) routes every LLM call outcome
// through SessionHealthState. To avoid forcing every call site to pass a
// callback, we expose a process-wide listener registration. The enforcement
// extension registers listeners at session_start with a closure over the
// current ctx; calls go to whichever listener is currently registered.
//
// Single-listener design: only one consumer is expected (the enforcement
// extension). Multi-session / multi-consumer scenarios are a future concern.
//
// Listener slots live in `lib/state/global-state.ts` to satisfy the
// no-module-level-let contract; this file uses getter/setter wrappers.
import {
  setLlmCallListeners,
  getLlmErrorListener,
  getLlmSuccessListener,
  type LlmErrorListener,
  type LlmSuccessListener,
} from "../state/global-state.js";

// Re-export the setter so existing callers (enforcement extension) keep
// working without changes.
export { setLlmCallListeners };
export type { LlmErrorListener, LlmSuccessListener };

async function acquireModelSlot(modelId: string): Promise<void> {
  let lock = _modelLocks.get(modelId);
  if (!lock) {
    lock = { active: 0, waiters: [] };
    _modelLocks.set(modelId, lock);
  }
  if (lock.active < MAX_CONCURRENT_PER_MODEL) {
    lock.active++;
    return;
  }
  return new Promise<void>((resolve) => {
    lock!.waiters.push(() => {
      lock!.active++;
      resolve();
    });
  });
}

function releaseModelSlot(modelId: string): void {
  const lock = _modelLocks.get(modelId);
  if (!lock) return;
  lock.active = Math.max(0, lock.active - 1);
  const next = lock.waiters.shift();
  if (next) next();
}

// ── Options ────────────────────────────────────────────────────────────────────

export interface LlmCallOptions {
  /** Temperature for generation. Default: 0.1 */
  temperature?: number;
  /** Max output tokens. Default: auto from prompt length (500-2000) */
  maxTokens?: number;
  /**
   * Reasoning effort level. Pass "off" to disable thinking entirely
   * for short mechanical tasks (yes/no classification, polishing).
   * Pass "high" / "xhigh" for tasks that benefit from extended
   * thinking (e.g. the think tool's review pass).
   *
   * Reasoning tokens count against max_tokens for most providers,
   * so a yes/no classifier with default reasoning enabled will
   * burn its entire budget on thinking and produce 0 output tokens
   * (the empty-string symptom).
   *
   * pi-ai's clampThinkingLevel accepts "off" at runtime and
   * gracefully maps it:
   *   - Models with "off" in their thinkingLevelMap: thinking
   *     disabled entirely (most efficient)
   *   - Models without "off" support: clamped to the lowest
   *     available level (e.g. "minimal")
   *
   * The function signature accepts "off" at runtime even though
   * the public ThinkingLevel type is stricter - we cast at the
   * call site.
   *
   * Default: undefined (provider default).
   */
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Per-attempt timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Outer retry attempts. Default: 3 */
  maxRetries?: number;
  /** Inner SDK retries per attempt. Default: 2 */
  sdkRetries?: number;
  /** Optional AbortSignal for cancellation */
  signal?: AbortSignal;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Make an LLM call with two-tier retry, backoff, and rate-limit circuit breaker.
 *
 * Uses AbortSignal for timeout to avoid orphaned Promise.race timeouts.
 *
 * @param model        - pi-ai Model to call
 * @param apiKey       - API key for the provider
 * @param systemPrompt - System prompt text
 * @param userPrompt   - User message text
 * @param options      - Optional configuration
 * @returns `{ text }` on success or `{ error }` on failure
 */
export async function callLlm(
  model: Model<Api>,
  apiKey: string | undefined,
  systemPrompt: string,
  userPrompt: string,
  options: LlmCallOptions = {},
): Promise<
  | { text: string; stopReason?: string; usage?: { input?: number; output?: number; totalTokens?: number } }
  | { error: string }
> {
  // ── circuit breaker: skip if we recently hit a rate limit ─────────
  const now = Date.now();
  if (rateLimitCooldownUntil > 0 && now < rateLimitCooldownUntil) {
    const remaining = rateLimitCooldownUntil - now;
    log.debug(`Skipping LLM call - rate-limit cooldown ${remaining}ms remaining`);
    return { error: "Rate-limit cooldown active" };
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const maxTokens =
    options.maxTokens ?? Math.min(Math.max(1000, Math.floor(userPrompt.length / 8)), 4000);
  // 10-minute default (was 30s). Aborts should be signal-driven (ESC,
  // session shutdown), not timeout-driven. A timeout here is a fallback
  // for orphaned calls (caller crashed, signal never fired) -- not the
  // normal cancellation path. Callers can still pass a tighter
  // timeoutMs if they want a hard ceiling.
  const timeoutMs = options.timeoutMs ?? 600_000;
  const temperature = options.temperature ?? 0.1;
  const sdkMaxRetries = options.sdkRetries ?? DEFAULT_SDK_RETRIES;
  const signal = options.signal;

  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };

  // ── per-model concurrency limiter: acquire ONCE at function entry, release in finally ──
  // (One slot per callLlm invocation, not per retry - otherwise retries could
  // pile up beyond MAX_CONCURRENT_PER_MODEL.)
  await acquireModelSlot(model.id);

  try {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      // ── circuit breaker re-check inside retry loop ──
      if (rateLimitCooldownUntil > 0 && Date.now() < rateLimitCooldownUntil) {
        log.warn(`Skipping retry ${attempt} - rate-limit cooldown active`);
        return { error: "Rate-limit cooldown active" };
      }

      // ── ESC check: if the external signal already fired (e.g. during
      // backoff sleep), don't attempt another call. Without this, the
      // retry loop continues after abortable sleep resolves early, but
      // combineSignals returns only the timeout signal (s1 already
      // aborted -> returns s2), so the next attempt hangs until timeout.
      if (signal?.aborted) {
        log.debug("LLM call aborted (signal fired before retry attempt)");
        return { error: "Request was aborted" };
      }

      // Use AbortSignal for timeout instead of Promise.race - avoids orphaned timer
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(
        () => timeoutController.abort(new Error("LLM call timeout")),
        timeoutMs,
      );

      // Combine external signal with timeout signal
      const combinedSignal = signal
        ? combineSignals(signal, timeoutController.signal)
        : timeoutController.signal;

      // Helper: clean up timeout + combined signal listeners after
      // each attempt. Aborting timeoutController triggers combineSignals'
      // built-in listener removal (onAbort removes itself from both
      // parent signals). Without this, stale listeners accumulate on
      // the external signal across retries -- a listener leak.
      const cleanupAttempt = (): void => {
        clearTimeout(timeoutId);
        // Abort the timeout controller to trigger combineSignals cleanup.
        // The combined controller is already abandoned (we have the result),
        // so aborting it is harmless.
        if (!timeoutController.signal.aborted) {
          timeoutController.abort();
        }
      };

      try {
        // Build options object first so we can cast 'reasoning'
        // (which accepts "off" at runtime) to the public
        // ThinkingLevel type. The spread pattern would infer the
        // wider union and fail the type check.
        //
        // We always pass the reasoning value when set, including
        // "off" - pi-ai's clampThinkingLevel accepts "off" and
        // gracefully maps it (off if supported, else lowest
        // available level like "minimal").
        const simpleOptions: {
          apiKey: string | undefined;
          maxTokens: number;
          temperature: number;
          maxRetries: number;
          reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "off";
          signal: AbortSignal;
        } = {
          apiKey,
          maxTokens,
          temperature,
          maxRetries: sdkMaxRetries,
          signal: combinedSignal,
        };
        if (options.reasoning !== undefined) {
          simpleOptions.reasoning = options.reasoning;
        }
        const result = await _resolveCompleteSimple()(
          model as Model<Api>,
          context,
          toCompleteSimpleOptions(simpleOptions),
        );

        cleanupAttempt();

        if (result.errorMessage) {
          if (attempt <= maxRetries && isTransientError(result.errorMessage)) {
            const delay = backoffDelay(attempt);
            log.warn(
              `LLM transient error (attempt ${attempt}/${maxRetries + 1}), ` +
                `retrying in ${delay}ms: ${result.errorMessage}`,
            );

            if (isRateLimitError(result.errorMessage)) {
              rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            }

            // Pass signal so ESC during backoff aborts the retry
            // instead of letting it fire after the delay.
            await sleep(delay, signal);
            continue;
          }

          // Non-retryable or exhausted - log and return
          if (isRateLimitError(result.errorMessage)) {
            rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            log.warn(
              `LLM rate-limited, giving up (cooldown ${RATE_LIMIT_COOLDOWN_MS}ms): ${result.errorMessage}`,
            );
          } else if (
            // Demote "Request was aborted" to debug when caused by the
            // caller's external signal (ESC, session shutdown). These
            // are expected cancellations, not real errors. Without
            // this gate, the user sees an ERROR line every time they
            // press ESC during a turn that had braid LLM calls in
            // flight (consolidation, classify, sop-extract, etc.).
            //
            // The distinguishing signal is `signal.aborted` - it becomes
            // true when EITHER the timeout fires OR the external signal
            // fires. We can't tell them apart from `result.errorMessage`
            // alone (pi-ai returns "Request was aborted" for both), so
            // we check the original external signal: if it was set and
            // is now aborted, this is a user-driven cancellation.
            //
            // Universal fallback: if the error message contains
            // "abort" (any case) we also demote to debug. This covers
            // post-loop callers (heartbeat, context-hygiene) where
            // ctx.signal is undefined and the only abort source is
            // the timeout itself firing under session-end load - the
            // user didn't ask for that to be logged at ERROR.
            signal?.aborted === true ||
            /abort/i.test(result.errorMessage)
          ) {
            log.debug(
              `LLM call aborted (signal=${signal ? "set" : "unset"}, message=${result.errorMessage})`,
            );
          } else {
            log.error("LLM error:", result.errorMessage);
          }
          // Notify listener (Layer 2 wiring) - non-fatal if it throws.
          try {
            getLlmErrorListener()?.(result.errorMessage);
          } catch {
            // non-fatal
          }
          return { error: result.errorMessage };
        }

        // Success - extract text content
        const textContent = result.content.filter(
          (c): c is { type: "text"; text: string } => c.type === "text",
        );
        const text = textContent.length > 0 ? textContent[0].text : "";

        // Notify listener (Layer 2 wiring) - non-fatal if the listener throws.
        try {
          getLlmSuccessListener()?.();
        } catch {
          // non-fatal
        }

        // Surface stopReason and usage so callers can diagnose empty
        // responses (e.g. "stopReason=length" means the model hit the
        // max_tokens ceiling, which is why the response is empty).
        // pi-ai's Usage has fields { input, output, totalTokens, ... }
        // (not { inputTokens, outputTokens }) - the field names below
        // mirror the upstream type.
        return {
          text,
          stopReason: result.stopReason,
          usage: result.usage
            ? {
                input: result.usage.input,
                output: result.usage.output,
                totalTokens: result.usage.totalTokens,
              }
            : undefined,
        };
      } catch (err) {
        cleanupAttempt();
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout =
          message.includes("timeout") ||
          message.includes("Timed") ||
          (err instanceof Error && err.name === "AbortError");
        if (attempt <= maxRetries && (isTimeout || isTransientError(message))) {
          const delay = backoffDelay(attempt);
          log.warn(
            `LLM error (attempt ${attempt}/${maxRetries + 1}), ` +
              `retrying in ${delay}ms: ${message}`,
          );
          // Pass signal so ESC during backoff aborts the retry.
          await sleep(delay, signal);
          continue;
        }
        // Demote to debug when an external signal (ESC / session shutdown)
        // caused the abort, OR when the message is itself an abort
        // (covered by the universal /abort/i fallback in the
        // result.errorMessage branch above). This matches the
        // demotion there. Without this, the catch path still emits
        // ERROR lines for expected cancellations and post-loop
        // timeouts fired under session-end load.
        if (signal?.aborted === true || /abort/i.test(message)) {
          log.debug(
            `LLM call aborted (signal=${signal ? "set" : "unset"}, message=${message})`,
          );
        } else {
          log.error(
            isTimeout
              ? `LLM call timed out after ${maxRetries + 1} attempts`
              : `LLM call failed: ${message}`,
          );
        }
        // Notify listener (Layer 2 wiring) - non-fatal if it throws.
        try {
          getLlmErrorListener()?.(message);
        } catch {
          // non-fatal
        }
        return { error: message };
      }
    }

    return { error: `LLM call failed after ${maxRetries + 1} attempts` };
  } finally {
    releaseModelSlot(model.id);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Combine two AbortSignals into one. When either signal aborts, the combined signal aborts.
 *
 * If either parent signal is already aborted, returns just the *other* signal unmodified
 * rather than creating an immediately-aborted controller. This prevents stale external
 * signals (e.g. from timed-out tool executions) from instant-killing the combined signal
 * on retry.
 *
 * Cleans up event listeners after the combined signal fires to prevent memory leaks
 * across repeated calls (e.g. retry loops creating new combined signals).
 *
 * @internal Exported for behavioral testing (test-call-llm-behavior.mjs).
 * Production code should not call this directly.
 */
export function combineSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
  // If either signal is already dead, just return the other - combining into an
  // already-aborted signal is a no-op that would only propagate the stale abort.
  if (s1.aborted) return s2;
  if (s2.aborted) return s1;

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    s1.removeEventListener("abort", onAbort);
    s2.removeEventListener("abort", onAbort);
  };
  s1.addEventListener("abort", onAbort);
  s2.addEventListener("abort", onAbort);
  return controller.signal;
}

/** Detect errors that are worth retrying. */
function isTransientError(message: string): boolean {
  return isRateLimitError(message) || matchesTransientOnly(message);
}

/** Patterns that indicate HTTP rate-limit (429/throttle). */
const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "too many requests",
  "throttled",
] as const;

/** Check if an error message indicates a rate-limit condition specifically. */
function isRateLimitError(message: string): boolean {
  if (message.startsWith("429")) return true;
  const lower = message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

/** Patterns that indicate transient failure but not rate-limit. */
const TRANSIENT_ONLY_PATTERNS = [
  "overloaded",
  "service unavailable",
  "temporarily",
  "try again later",
  "please retry",
  "network connection lost",
  "upstream connect",
  "connection refused",
] as const;
const TRANSIENT_ONLY_CODES = ["529", "502", "503", "504"] as const;

function matchesTransientOnly(message: string): boolean {
  if (TRANSIENT_ONLY_CODES.some((code) => message.startsWith(code))) return true;
  const lower = message.toLowerCase();
  return TRANSIENT_ONLY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Compute exponential backoff delay.
 * attempt 1 -> 5s, attempt 2 -> 15s, attempt 3 -> 30s, attempt 4 -> 60s
 * With +/-20% jitter. Capped at 60s.
 */
/**
 * Cast our locally-typed `simpleOptions` (which permits
 * `reasoning: "off"`) to the public `SimpleStreamOptions` shape that
 * `completeSimple` expects.
 *
 * Why this exists: pi-ai's runtime accepts "off" as a reasoning value
 * and gracefully maps it (off if the model supports it, else the
 * lowest available level like "minimal"). The public type union doesn't
 * list "off" yet, so a direct assignment would fail to typecheck. We
 * centralize the cast in this one helper so the boundary is explicit
 * and findable. If pi-ai later adds "off" to its public type, this
 * helper becomes a no-op identity cast and can be deleted.
 */
function toCompleteSimpleOptions(
  opts: {
    apiKey: string | undefined;
    maxTokens: number;
    temperature: number;
    maxRetries: number;
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "off";
    signal: AbortSignal;
  },
): Parameters<typeof completeSimple>[2] {
  return opts as unknown as Parameters<typeof completeSimple>[2];
}

function backoffDelay(attempt: number): number {
  const delays = [5_000, 15_000, 30_000, 60_000];
  const base = delays[Math.min(attempt - 1, delays.length - 1)];
  const jitter = Math.round(base * (0.8 + Math.random() * 0.4));
  return Math.min(jitter, 60_000);
}

/**
 * Abortable sleep. Resolves immediately if signal fires during the wait.
 *
 * Without this, pressing ESC during a retry backoff (5-60s) would
 * leave the sleep running -- the retry would fire after the backoff,
 * then hang until the new timeout fires. The signal was only checked
 * at the next combineSignals call, not during the backoff itself.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
