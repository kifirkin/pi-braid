/**
 * Shared LLM Call Utility
 *
 * Wraps pi-ai's completeSimple with a two-tier retry strategy:
 *
 * Tier 1 - Provider SDK: Handles fast transient blips (quick network drops)
 *           via completeSimple's maxRetries (default: 1 SDK-level retry).
 * Tier 2 - This module: Handles sustained rate limits with longer backoff
 *           (5s → 15s → 30s → 60s) so the provider gets real cooldown time.
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
import { completeSimple } from "@earendil-works/pi-ai";
import { createLogger } from "../core/logger.js";

const log = createLogger("llm-call");

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
  | { text: string; stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
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
  const timeoutMs = options.timeoutMs ?? 30_000;
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

      try {
        const result = await completeSimple(model as Model<Api>, context, {
          apiKey,
          maxTokens,
          temperature,
          maxRetries: sdkMaxRetries,
          signal: combinedSignal,
        });

        clearTimeout(timeoutId);

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

            await sleep(delay);
            continue;
          }

          // Non-retryable or exhausted - log and return
          if (isRateLimitError(result.errorMessage)) {
            rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            log.warn(
              `LLM rate-limited, giving up (cooldown ${RATE_LIMIT_COOLDOWN_MS}ms): ${result.errorMessage}`,
            );
          } else {
            log.error("LLM error:", result.errorMessage);
          }
          return { error: result.errorMessage };
        }

        // Success - extract text content
        const textContent = result.content.filter(
          (c): c is { type: "text"; text: string } => c.type === "text",
        );
        const text = textContent.length > 0 ? textContent[0].text : "";

        // Surface stopReason and usage so callers can diagnose empty
        // responses (e.g. "stopReason=length" means the model hit the
        // max_tokens ceiling, which is why the response is empty).
        // These are optional so existing {text}/{error} discrimination
        // is unchanged for the 34 call sites that don't inspect them.
        return {
          text,
          stopReason: result.stopReason,
          usage: result.usage,
        };
      } catch (err) {
        clearTimeout(timeoutId);
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
          await sleep(delay);
          continue;
        }
        log.error(
          isTimeout
            ? `LLM call timed out after ${maxRetries + 1} attempts`
            : `LLM call failed: ${message}`,
        );
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
 */
function combineSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
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
 * attempt 1 → 5s, attempt 2 → 15s, attempt 3 → 30s, attempt 4 → 60s
 * With ±20% jitter. Capped at 60s.
 */
function backoffDelay(attempt: number): number {
  const delays = [5_000, 15_000, 30_000, 60_000];
  const base = delays[Math.min(attempt - 1, delays.length - 1)];
  const jitter = Math.round(base * (0.8 + Math.random() * 0.4));
  return Math.min(jitter, 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
