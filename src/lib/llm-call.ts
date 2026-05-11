/**
 * Shared LLM Call Utility
 *
 * Wraps pi-ai's completeSimple with a two-tier retry strategy:
 *
 * Tier 1 — Provider SDK: Handles fast transient blips (quick network drops)
 *           via completeSimple's maxRetries (default: 1 SDK-level retry).
 * Tier 2 — This module: Handles sustained rate limits with longer backoff
 *           (2s → 5s → 10s → 20s) so the provider gets real cooldown time.
 *
 * A rate-limit circuit breaker skips calls for 30s after a 429 to avoid
 * cascading failures during provider congestion.
 *
 * Usage
 *
 * Usage:
 *   callLlm(model, apiKey, systemPrompt, userPrompt, options)
 *   Returns { text } on success or { error } on failure (discriminated union).
 *   const text = result.text;
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { createLogger } from "./logger.js";

const log = createLogger("llm-call");

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default outer retry attempts (each may trigger SDK inner retries). */
const DEFAULT_MAX_RETRIES = 3;

/** SDK-level retries per attempt. */
const DEFAULT_SDK_RETRIES = 1;

/** Cooldown after a rate-limit hit before attempting calls again. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/** Timestamp of the last 429 seen, 0 = no rate-limit recently. */
let lastRateLimitAt = 0;

// ── Options ────────────────────────────────────────────────────────────────────

export interface LlmCallOptions {
  /** Temperature for generation. Default: 0.1 */
  temperature?: number;
  /** Max output tokens. Default: auto from prompt length (500–2000) */
  maxTokens?: number;
  /** Per-attempt timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Outer retry attempts. Default: 3 */
  maxRetries?: number;
  /** Inner SDK retries per attempt. Default: 1 */
  sdkRetries?: number;
  /** Optional AbortSignal for cancellation */
  signal?: AbortSignal;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Make an LLM call with two-tier retry, backoff, and rate-limit circuit breaker.
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
): Promise<{ text: string } | { error: string }> {
  // ── circuit breaker: skip if we recently hit a rate limit ─────────
  const now = Date.now();
  if (lastRateLimitAt > 0 && now - lastRateLimitAt < RATE_LIMIT_COOLDOWN_MS) {
    const remaining = RATE_LIMIT_COOLDOWN_MS - (now - lastRateLimitAt);
    log.debug(`Skipping LLM call — rate-limit cooldown ${remaining}ms remaining`);
    return { error: "Rate-limit cooldown active" };
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxTokens =
    options.maxTokens ?? Math.min(Math.max(500, Math.floor(userPrompt.length / 8)), 2000);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const temperature = options.temperature ?? 0.1;
  const sdkMaxRetries = options.sdkRetries ?? DEFAULT_SDK_RETRIES;
  const signal = options.signal;

  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("LLM call timeout")), timeoutMs);
    });

    try {
      const result = await Promise.race([
        completeSimple(model as Model<Api>, context, {
          apiKey,
          maxTokens,
          temperature,
          maxRetries: sdkMaxRetries,
          signal,
        }),
        timeoutPromise,
      ]);

      if (result.errorMessage) {
        if (attempt <= maxRetries && isTransientError(result.errorMessage)) {
          const delay = backoffDelay(attempt);
          log.warn(
            `LLM transient error (attempt ${attempt}/${maxRetries + 1}), ` +
              `retrying in ${delay}ms: ${result.errorMessage}`,
          );

          if (isRateLimitError(result.errorMessage)) {
            lastRateLimitAt = Date.now();
          }

          await sleep(delay);
          continue;
        }

        // Non-retryable or exhausted — log and return
        if (isRateLimitError(result.errorMessage)) {
          lastRateLimitAt = Date.now();
          log.warn(
            `LLM rate-limited, giving up (cooldown ${RATE_LIMIT_COOLDOWN_MS}ms): ${result.errorMessage}`,
          );
        } else {
          log.error("LLM error:", result.errorMessage);
        }
        return { error: result.errorMessage };
      }

      // Success — extract text content
      const textContent = result.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      );
      const text = textContent.length > 0 ? textContent[0].text : "";

      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes("timeout") || message.includes("Timed");
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
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Detect errors that are worth retrying. */
function isTransientError(message: string): boolean {
  const transientCodes = ["429", "529", "502", "503", "504"];
  const transientPatterns = [
    "rate limit",
    "too many requests",
    "overloaded",
    "service unavailable",
    "temporarily",
    "try again later",
    "please retry",
    "throttled",
    "network connection lost",
    "upstream connect",
    "connection refused",
  ];
  const lower = message.toLowerCase();
  return (
    transientCodes.some((code) => message.startsWith(code)) ||
    transientPatterns.some((p) => lower.includes(p))
  );
}

/** Check if an error message indicates a rate-limit condition specifically. */
function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    message.startsWith("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttled")
  );
}

/**
 * Compute exponential backoff delay.
 * attempt 1 → 2s, attempt 2 → 5s, attempt 3 → 10s, attempt 4 → 20s
 * With ±20% jitter. Capped at 30s.
 */
function backoffDelay(attempt: number): number {
  const delays = [2_000, 5_000, 10_000, 20_000];
  const base = delays[Math.min(attempt - 1, delays.length - 1)];
  const jitter = Math.round(base * (0.8 + Math.random() * 0.4));
  return Math.min(jitter, 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}