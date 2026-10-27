/**
 * [stakes-invariant]: this module and the rest of lib/ai/ must never
 * include downstream-stakes signals in the LLM call context. The judge
 * (whether human, LLM-as-judge, or programmatic) evaluates pure
 * correctness; the agent being judged sees no signal about what the
 * judgment is for, and the prompt carries no stakes-awareness block.
 * The test-arxiv-citations.mjs and test-prompt-builder-directive.mjs
 * suites verify the agent-side invariant.
 *
 * Dispatches auxiliary LLM calls through the session's model registry
 * (ctx.modelRegistry.streamSimple, read from the published extension context)
 * with a two-tier retry strategy:
 *
 * Tier 1 - Provider SDK: Handles fast transient blips (quick network drops)
 *           via the registry call's maxRetries (default: 3 SDK-level retries).
 * Tier 2 - This module: Handles sustained rate limits with longer backoff
 *           (5s -> 15s -> 30s -> 60s) so the provider gets real cooldown time.
 *
 * When no context has been published, the call degrades to pi-ai's compat
 * transport (credential only, no session id or configured headers) so an
 * auxiliary role keeps working; one warning per process announces it. See
 * completeAuxCall.
 *
 * A rate-limit circuit breaker skips calls for 60s after a 429 to avoid
 * cascading failures during provider congestion.
 *
 * Usage:
 *   callLlm(model, apiKey, systemPrompt, userPrompt, options)
 *   Returns { text } on success or { error } on failure (discriminated union).
 *   const text = result.text;
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelThinkingLevel,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Degraded transport only: see completeAuxCall below. Compat resolves the
// credential from the model and the apiKey argument and nothing else, which is
// exactly the case it is reserved for (no published context, so no registry to
// resolve headers or the session id through).
import { completeSimple } from "@earendil-works/pi-ai/compat";
// Auxiliary calls dispatch through the session's model registry (see the
// completion-dispatch block below): pi-ai's compat entrypoint resolves an api
// key from the model and nothing else, so registry-resolved headers, configured
// provider headers, and the session id never reach a compat request. Compat is
// kept only as the degraded fallback for the no-context case. The registry is
// also where braid's own providers are registered (pi.registerProvider), so it
// is the one handle that reaches both built-in and custom providers.
import { createLogger } from "../core/logger.js";
import { isRateLimitText } from "../errors/llm-error.js";
import { isContextWindowErrorText } from "../errors/llm-error.js";
import { sanitizeLlmErrorForLog, sanitizeLlmRequestText } from "./payload-hygiene.js";
import {
  calibrateEstimate,
  estimatePayloadTokens,
  resolveWindow,
} from "../detection/context-usage.js";
import { guardAgainstDoomedSend } from "./presend-budget.js";
import {
  getContextEmergencyOffloadRunner,
  getExtensionCtxProvider,
  hasWarnedAuxDegradedTransport,
  markAuxDegradedTransportWarned,
} from "../state/global-state.js";

const log = createLogger("llm-call");

// ── Completion dispatch ──────────────────────────────────────────────────────
//
// An auxiliary request is dispatched exactly like a session request: through
// ctx.modelRegistry, so pi-core resolves the credential, the configured and
// provider-declared headers, and the transport before the provider object
// sees it. `streamSimple` rather than `complete` because the options built
// below are provider-neutral (`reasoning` among them) and only the simple
// path maps them per API (thinking-level clamping, max-token clamping).
//
// lib/ai has no ctx of its own, so the registry is read from the extension
// context the enforcement session-start handler publishes (global-state.ts),
// per attempt: a retry can outlive the session that started it.

/** The slice of the published extension context this module reads. */
interface AuxCallContext {
  modelRegistry?: {
    streamSimple(
      model: Model<Api>,
      context: Context,
      options: ModelsSimpleStreamOptions,
    ): { result(): Promise<AssistantMessage> };
  };
  sessionManager?: { getSessionId?: () => string };
}

/** Read the published extension context, or null when none was published. */
function readAuxContext(): AuxCallContext | null {
  const provider = getExtensionCtxProvider();
  if (!provider) return null;
  try {
    return (provider() as AuxCallContext | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Session id for the request (per-conversation routing and prompt-cache
 * affinity). Undefined when no session manager is readable, never a sentinel:
 * an invented id would route the request to a conversation that does not
 * exist. Which header the id becomes is the provider's own business.
 */
function resolveSessionId(): string | undefined {
  try {
    const id = readAuxContext()?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Production completion. Primary path: the session's model registry, the same
 * path the session's own requests take, so pi-core resolves the credential,
 * the configured and provider-declared headers, the session id (which a
 * provider may turn into a routing header), and the transport.
 *
 * Degraded path: pi-ai's compat entrypoint, used only when nothing has
 * published a context. Compat resolves the credential from the model and the
 * apiKey argument and carries nothing else: no session id, no configured
 * provider headers. Auxiliary calls must still complete when the publisher
 * never ran (the publisher is the enforcement extension's session-start
 * handler, and enforcement is disableable), but the degradation is announced
 * once per process by warnDegradedTransportOnce so it is never mistaken for
 * the full path.
 */
async function completeAuxCall(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
): Promise<AssistantMessage> {
  const registry = readAuxContext()?.modelRegistry;
  if (registry) {
    return registry.streamSimple(model, context, options).result();
  }
  warnDegradedTransportOnce();
  return completeSimple(model, context, options as unknown as Parameters<typeof completeSimple>[2]);
}

/**
 * Announce the degraded transport exactly once per process, naming the
 * publisher that did not run and what the fallback does not carry. Silence
 * after the first line keeps a degraded session from flooding the log; the
 * latch is process-global (global-state.ts) so it survives session boundaries
 * and module re-evaluation on /reload.
 */
function warnDegradedTransportOnce(): void {
  if (hasWarnedAuxDegradedTransport()) return;
  markAuxDegradedTransportWarned();
  log.warn(
    "No session context published for auxiliary LLM calls (the enforcement " +
      "extension publishes it at session_start; enforcement is disableable). " +
      "Falling back to pi-ai's compat transport: the request carries the " +
      "model's credential only, without the session id or configured provider " +
      "headers. Auxiliary calls are degraded until the publisher runs.",
  );
}

// Test-only injection point: production dispatches through the registry
// (above). Behavioral tests
// (timeout, signal abort, retry behavior) need to stub that call without a
// real provider, and the injection is opt-in: production behavior is
// identical unless `__setCompleteSimpleForTest` is called. The setter is
// intentionally a module-private mutation (not a parameter on callLlm)
// because adding test-only parameters to the public API would pollute the
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

/** One provider-neutral completion call. */
type CompletionFn = (
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

// The override slot is for test injection only; production uses the registry.
let _completionOverride: CompletionFn | null = null;

function _resolveCompletion(): CompletionFn {
  return _completionOverride ?? completeAuxCall;
}

/**
 * @internal Test-only: override the completion call for behavioral testing.
 * Pass `null` to reset to the production implementation. NOT for use
 * in production code paths.
 */
export function __setCompleteSimpleForTest(fn: CompletionFn | null): void {
  _completionOverride = fn ?? null;
}

/** Track the cooldown expiration deadline. */
let rateLimitCooldownUntil = 0;

/**
 * @internal Test-only: clear the rate-limit circuit-breaker cooldown so
 * behavioral tests don't inherit it from a prior rate-limited stub call
 * (the cooldown is process-global and shared across tests in one file).
 * NOT for production use.
 */
export function __resetRateLimitCooldownForTest(): void {
  rateLimitCooldownUntil = 0;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default outer retry attempts (each may trigger SDK inner retries). */
const DEFAULT_MAX_RETRIES = 5;

/** SDK-level retries per attempt. */
const DEFAULT_SDK_RETRIES = 3;

/** Cooldown after a rate-limit hit before attempting calls again. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * Hard ceiling on any single retry backoff. During the network
 * outage a retry ladder was observed live sleeping ~9.2 HOURS on one attempt
 * ("Retrying (14/15) in 33033s") — the agent sat wedged silently with no
 * signal that anything was wrong. Whatever the ladder computes (exponential
 * growth, jitter, or future edits that raise the per-step base), the
 * per-attempt backoff must stay bounded, so both retry sites clamp the
 * computed delay to this ceiling. Attempt counts, SDK retries,
 * circuit-breaker logic, and abort handling are intentionally untouched.
 */
const MAX_RETRY_BACKOFF_MS = 120_000;

// ── Per-model concurrency limiter ────────────────────────────────────────────

/** Max concurrent in-flight LLM calls per model. Provider-side rate
 *  limits are typically expressed as requests-per-second or concurrent-
 *  connections; serializing bursts through a small pool prevents a
 *  4-way Promise.allSettled batch of classify() calls from triggering
 *  rate-limits. The default of 2 means at most 2 calls
 *  to a given model are in-flight at any time; the rest queue. */
const MAX_CONCURRENT_PER_MODEL = 2;

/** Per-model semaphore: active count + waiters. */
type ModelLock = { active: number; waiters: Array<() => void> };
const _modelLocks = new Map<string, ModelLock>();

// ── LLM call listeners (Layer 2 wiring) ─────────────────────────────────────
//
// The session-recovery proposal routes every LLM call outcome
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
  getKeyRingFeedbackHandler,
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
  /** Max output tokens. Default: auto from prompt length (1000-4000) */
  maxTokens?: number;
  /**
   * Reasoning effort level - the SDK's own thinking-level union, so every
   * level pi-ai defines is nameable here: "off" through "max". Pass "off"
   * to disable thinking entirely for short mechanical tasks (yes/no
   * classification, polishing). Pass "high" / "xhigh" / "max" for tasks
   * that benefit from extended thinking (e.g. the think tool's review pass).
   *
   * Reasoning tokens count against max_tokens for most providers, so a
   * yes/no classifier with default reasoning enabled will burn its entire
   * budget on thinking and produce 0 output tokens (the empty-string
   * symptom).
   *
   * "off" is not part of the SDK's stream-options `ThinkingLevel` union;
   * pi-ai's clampThinkingLevel takes it and maps it anyway:
   *   - Models with "off" in their thinkingLevelMap: thinking disabled
   *     entirely (most efficient)
   *   - Models without "off" support: clamped to the lowest available level
   *     (e.g. "minimal")
   * The value therefore crosses the stream-options boundary through the
   * single cast in toSimpleStreamOptions.
   *
   * Default: undefined (provider default).
   */
  reasoning?: ModelThinkingLevel;
  /** Per-attempt timeout in ms. Default: 600000 (10 min) */
  timeoutMs?: number;
  /** Outer retry attempts. Default: 5 */
  maxRetries?: number;
  /** Inner SDK retries per attempt. Default: 3 */
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
  | {
      text: string;
      stopReason?: string;
      usage?: { input?: number; output?: number; totalTokens?: number };
    }
  | { error: string }
> {
  // Circuit breaker: skip while a recent 429 cooldown is active ───────
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

  // Internal-call body hygiene: redact raw edge/WAF page dumps, asset-sized
  // base64 runs, and the edge filter's own request trigger before they are
  // sent — a re-sent page fragment can trigger the same edge block that
  // produced it. No-op for normal prompts (identity).
  const systemSafe = sanitizeLlmRequestText(systemPrompt);
  const userSafe = sanitizeLlmRequestText(userPrompt);
  const requestRedactions = systemSafe.redactions + userSafe.redactions;
  if (requestRedactions > 0) {
    log.warn(
      `LLM request body sanitized before send (${requestRedactions} fragment(s) rewritten; edge/WAF hygiene)`,
    );
  }

  const context: Context = {
    systemPrompt: systemSafe.text,
    messages: [{ role: "user", content: userSafe.text, timestamp: Date.now() }],
  };

  // ── pre-send budget ──
  // A request over the window cannot succeed, and a provider 400 is a late,
  // expensive way to learn it. Measure the payload the provider would receive
  // (system + messages, calibrated against this session's own measured ratio),
  // add the output budget, and compare against the resolved window - a
  // configured cap binding below the model's window counts, because the
  // provider will refuse what the cap already refused.
  const resolvedWindow = resolveWindow((model as { contextWindow?: number }).contextWindow);
  const budget = await guardAgainstDoomedSend({
    measure: () =>
      calibrateEstimate(
        estimatePayloadTokens({ systemPrompt: context.systemPrompt, messages: context.messages }),
      ).tokens,
    outputTokens: maxTokens,
    contextWindow: resolvedWindow.contextWindow,
    // The only compaction available to an auxiliary call is the published
    // offload: it shrinks the session's largest toolResults, which is where an
    // oversized prompt came from. One attempt; nothing freed means still over.
    compact: async () => (await runEmergencyOffloadForCall()) > 0,
    onRefusal: (line) => log.error(line),
    subject: "LLM call",
  });
  if (!budget.allowed) return { error: budget.line };

  // ── per-model concurrency limiter: acquire ONCE at function entry, release in finally ──
  // (One slot per callLlm invocation, not per retry - otherwise retries could
  // pile up beyond MAX_CONCURRENT_PER_MODEL.)
  await acquireModelSlot(model.id);

  // Emergency retry bookkeeping. A context_window (413) error
  // means the payload is too big — retrying the same payload is the quota
  // burn this fixes. On the FIRST such error we run the published emergency
  // offloader (deterministic size-driven shrink of the live session's largest
  // toolResults) and retry EXACTLY ONCE with the shrunk context. Never a
  // second emergency retry in one callLlm invocation: if the shrunk payload
  // still 413s, the error propagates (compaction/rotation owns the next move).
  let emergencyRetryUsed = false;

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
        // Build the options object explicitly: `reasoning` is typed as the
        // SDK's ModelThinkingLevel (which includes "off") and crosses into
        // the registry's streamSimple through the single cast in
        // toSimpleStreamOptions.
        //
        // We always pass the reasoning value when set, including "off" -
        // pi-ai's clampThinkingLevel takes "off" and maps it (off if the
        // model supports it, else the lowest available level like "minimal").
        const simpleOptions: {
          apiKey: string | undefined;
          maxTokens: number;
          temperature: number;
          maxRetries: number;
          reasoning?: ModelThinkingLevel;
          signal: AbortSignal;
          sessionId?: string;
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
        const sessionId = resolveSessionId();
        if (sessionId !== undefined) {
          simpleOptions.sessionId = sessionId;
        }
        const result = await _resolveCompletion()(
          model as Model<Api>,
          context,
          toSimpleStreamOptions(simpleOptions),
        );

        cleanupAttempt();

        if (result.errorMessage) {
          // Raw text drives classification and the key-ring feed-back below;
          // the sanitized copy is what log lines and the caller see, so raw
          // HTTP block pages never reach either. See payload-hygiene.ts.
          const rawError = result.errorMessage;
          const safeError = sanitizeLlmErrorForLog(rawError);
          // ── emergency size-driven offload on 413 ──
          // The error classifier says context_window → the payload is too
          // big and shrinking it is the ONLY useful action. Run the
          // published emergency offloader (bypasses the health-gate by
          // construction: this path never consults SessionHealthState) and
          // retry exactly once. Consumer without the context-manager loaded
          // (runner or ctx provider absent) → fall through to the normal
          // error path, lossy-safe.
          if (!emergencyRetryUsed && isContextWindowErrorText(rawError)) {
            emergencyRetryUsed = true;
            const offloadResult = await runEmergencyOffloadForCall();
            if (offloadResult > 0) {
              log.warn(
                `LLM context-window error (413); emergency offload shrank the ` +
                  `context (${offloadResult} oversized toolResult(s) stubbed) — ` +
                  `retrying once with the shrunken payload`,
              );
              cleanupAttempt();
              attempt--; // do not burn a retry-ladder slot on the shrink
              continue;
            }
            emergencyRetryUsed = false; // nothing shrank — do not block a later retry
          }

          if (attempt <= maxRetries && isTransientError(rawError)) {
            const delay = Math.min(backoffDelay(attempt), MAX_RETRY_BACKOFF_MS);
            log.warn(
              `LLM transient error (attempt ${attempt}/${maxRetries + 1}), ` +
                `retrying in ${delay}ms: ${safeError}`,
            );

            if (isRateLimitError(rawError)) {
              rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            }

            // Pass signal so ESC during backoff aborts the retry
            // instead of letting it fire after the delay.
            await sleep(delay, signal);
            continue;
          }

          // Non-retryable or exhausted - log and return
          if (isRateLimitError(rawError)) {
            rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            log.warn(
              `LLM rate-limited, giving up (cooldown ${RATE_LIMIT_COOLDOWN_MS}ms): ${safeError}`,
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
            /abort/i.test(rawError)
          ) {
            log.debug(
              `LLM call aborted (signal=${signal ? "set" : "unset"}, message=${safeError})`,
            );
          } else {
            log.error("LLM error:", safeError);
          }
          // Notify listener (Layer 2 wiring) - non-fatal if it throws.
          try {
            // The session-health listener classifies the RAW text — a
            // sanitized page would lose its rate-limit/edge category.
            getLlmErrorListener()?.(rawError);
          } catch {
            // non-fatal
          }
          // Feed the failure back into the key ring that owns this model so a
          // direct (non-message_end) 429/403 exhausts + rotates the same way
          // handleMessageEnd does. No-op when providers hasn't
          // published a handler or the model is foreign (lossy-safe).
          // Same for the key ring: its WAF/rotation classifier needs the raw
          // markup markers ("cf-ray", "<html", …) the sanitizer removes.
          reportLlmFailureToKeyRing(model, rawError);
          return { error: safeError };
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
        // Feed the success back so the serving key's backoff is healed.
        reportLlmSuccessToKeyRing(model);

        // Surface stopReason and usage so callers can diagnose empty
        // responses (e.g. "stopReason=length" means the model hit the
        // max_tokens ceiling, which is why the response is empty).
        // pi-ai's Usage has fields { input, output, totalTokens, ... }
        // (not { inputTokens, outputTokens }) - the field names below
        // mirror the upstream type.
        //
        // Telemetry note (investigation): direct calls never pass
        // through pi-core's message pipeline, so this usage is returned
        // to the caller and has NO session-JSONL feed — all-zero usage
        // entries in session files are error-path zero-fills from failed
        // agent-loop requests (stopReason: "error", e.g. "Connection
        // error."), not unparsed direct-call usage. Verified:
        // 94/94 zero-usage entries across 22 sessions were error markers.
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
        const safeMessage = sanitizeLlmErrorForLog(message);
        const isTimeout =
          message.includes("timeout") ||
          message.includes("Timed") ||
          (err instanceof Error && err.name === "AbortError");
        // ── same emergency-offload exception as the
        // result.errorMessage path above — provider SDKs that THROW on 413
        // (instead of returning errorMessage) must get the same one-time
        // shrink + retry, or the quota-burn loop survives in that shape.
        if (!emergencyRetryUsed && isContextWindowErrorText(message)) {
          emergencyRetryUsed = true;
          const offloadResult = await runEmergencyOffloadForCall();
          if (offloadResult > 0) {
            log.warn(
              `LLM context-window error (413); emergency offload shrank the ` +
                `context (${offloadResult} oversized toolResult(s) stubbed) — ` +
                `retrying once with the shrunken payload`,
            );
            attempt--; // do not burn a retry-ladder slot on the shrink
            continue;
          }
          emergencyRetryUsed = false; // nothing shrank — do not block a later retry
        }
        if (attempt <= maxRetries && (isTimeout || isTransientError(message))) {
          const delay = Math.min(backoffDelay(attempt), MAX_RETRY_BACKOFF_MS);
          log.warn(
            `LLM error (attempt ${attempt}/${maxRetries + 1}), ` +
              `retrying in ${delay}ms: ${safeMessage}`,
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
            `LLM call aborted (signal=${signal ? "set" : "unset"}, message=${safeMessage})`,
          );
        } else {
          log.error(
            isTimeout
              ? `LLM call timed out after ${maxRetries + 1} attempts`
              : `LLM call failed: ${safeMessage}`,
          );
        }
        // Notify listener (Layer 2 wiring) - non-fatal if it throws.
        try {
          getLlmErrorListener()?.(message);
        } catch {
          // non-fatal
        }
        // Feed the failure back into the key ring — same seam as the
        // result.errorMessage path above (raw text for the same reason).
        reportLlmFailureToKeyRing(model, message);
        return { error: safeMessage };
      }
    }

    return { error: `LLM call failed after ${maxRetries + 1} attempts` };
  } finally {
    releaseModelSlot(model.id);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Run the published emergency offloader (context-manager's
 * context-emergency.ts) against the current session context. Lossy-safe:
 * when the runner or ctx provider has not been published (extension not
 * loaded), or either throws, this returns 0 — the caller then takes the
 * normal error path. Returns the number of oversized toolResults stubbed
 * (0 = nothing shrank — the caller must NOT retry).
 */
function runEmergencyOffloadForCall(): Promise<number> {
  const runner = getContextEmergencyOffloadRunner();
  const provider = getExtensionCtxProvider();
  if (!runner || !provider) return Promise.resolve(0);
  let ctx: unknown;
  try {
    ctx = provider();
  } catch {
    return Promise.resolve(0);
  }
  if (!ctx) return Promise.resolve(0);
  return Promise.resolve(runner(ctx, "llm-retry")).then(
    (r) => (r && r.offloaded > 0 ? r.offloaded : 0),
    () => 0,
  );
}

/**
 * Feed a failed callLlm back into the key ring that owns this model, so a
 * direct (non-message_end) 429/403 exhausts + rotates instead of leaving no
 * trace in the ring. The providers extension publishes a handler
 * into a process-global slot at load; with no handler registered (e.g. the
 * providers extension isn't loaded) this is a silent no-op — lossy-safe.
 * Attribution is per-call (this model's own id/provider); the handler resolves
 * the owning ring, so two providers' rings can never be confused.
 */
function reportLlmFailureToKeyRing(
  model: { id: string; provider?: string },
  errText: unknown,
): void {
  const handler = getKeyRingFeedbackHandler();
  if (!handler) return;
  try {
    handler.reportFailure(model.id, model.provider, String(errText ?? ""));
  } catch {
    // non-fatal — the ring must never break an LLM call
  }
}

/**
 * Feed a successful callLlm back so the serving key's backoff is healed
 * (mirrors handleMessageEnd's success path). No-op when no handler is
 * published, and the handler itself skips foreign models / healthy keys.
 */
function reportLlmSuccessToKeyRing(model: { id: string; provider?: string }): void {
  const handler = getKeyRingFeedbackHandler();
  if (!handler) return;
  try {
    handler.reportSuccess(model.id, model.provider);
  } catch {
    // non-fatal
  }
}

/**
 * (provider, model) pairs whose unusable answer was already reported this
 * process. Bounded by the route table times the model ids in play, and cleared
 * when the module is re-evaluated (/reload), which is the sense in which the
 * notice is once per process.
 */
const reportedUnusableModels = new Set<string>();

/**
 * The skip notice, once per (provider, model) per process, through the same
 * log channel every other auxiliary-call diagnostic uses. Repeats are silent,
 * so a session that keeps re-resolving an unusable model writes one line.
 */
function reportUnusableModelOnce(model: { id: string; provider?: string }): void {
  const provider = model.provider ?? "unknown";
  const key = `${provider}/${model.id}`;
  if (reportedUnusableModels.has(key)) return;
  reportedUnusableModels.add(key);
  log.info(
    `Skipping auxiliary model ${provider}/${model.id}: the provider reports it ` +
      `unusable right now (no usable key, or a request it just rejected).`,
  );
}

/**
 * The one yes/no question core asks the providers seam before re-using a
 * (provider, model) pair for an auxiliary call: can this pair serve a request
 * right now? The handler owns the answer, so core learns no route vocabulary:
 * it asks and skips, it does not interpret.
 *
 * Fail-open by construction: with nothing published, no query method, or a
 * throwing query, the answer is true, so auxiliary calls behave exactly as they
 * did before the seam existed. A false answer is reported once.
 */
export function isModelRouteUsable(model: { id: string; provider?: string }): boolean {
  const handler = getKeyRingFeedbackHandler();
  const query = handler && (handler as { routeUsable?: unknown }).routeUsable;
  if (typeof query !== "function") return true;
  let usable: boolean;
  try {
    usable =
      (query as (modelId: string, providerId: string | undefined) => boolean).call(
        handler,
        model.id,
        model.provider,
      ) !== false;
  } catch {
    return true; // the seam must never break an auxiliary call
  }
  if (!usable) reportUnusableModelOnce(model);
  return usable;
}

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

/**
 * Check if an error message indicates a rate-limit condition specifically.
 * Delegates to the canonical patterns in lib/errors/llm-error.ts (dedupe:
 * the former local substring list had drifted — no "429"-anywhere, no
 * "rate_limit"/"too_many_requests" underscore forms, no "throttle/-ing").
 */
function isRateLimitError(message: string): boolean {
  return isRateLimitText(message);
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
 * Cast our locally-typed `simpleOptions` to the options shape the registry's
 * `streamSimple` expects.
 *
 * Why this exists: `reasoning` is typed `ModelThinkingLevel`, which includes
 * "off", while the SDK's stream-options `ThinkingLevel` does not list it.
 * pi-ai's runtime takes "off" and maps it (off if the model supports it,
 * else the lowest available level like "minimal"), so the value is sound at
 * runtime. One helper keeps the boundary explicit and findable; when the
 * SDK's stream-options type gains "off", this becomes an identity cast.
 */
function toSimpleStreamOptions(opts: {
  apiKey: string | undefined;
  maxTokens: number;
  temperature: number;
  maxRetries: number;
  reasoning?: ModelThinkingLevel;
  signal: AbortSignal;
  sessionId?: string;
}): ModelsSimpleStreamOptions {
  return opts as unknown as ModelsSimpleStreamOptions;
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
