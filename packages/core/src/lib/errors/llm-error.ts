/**
 * Unified LLM Error Classifier - one taxonomy, one place.
 *
 * Replaces the ad-hoc `isTransientCompactionError` / `isContextWindowError`
 * helpers scattered across `compaction-retry.ts` and the local fallbacks
 * in `llm-call.ts`. Every LLM-call failure routes through this classifier
 * and gets a category. Consumers (SessionHealthState, recovery handlers,
 * detector fallbacks) read the category instead of pattern-matching error
 * strings.
 *
 * Categories:
 *   - balance: 402 / insufficient_balance / billing issues. Retry
 *                     is pointless; user action required.
 *   - rate_limit: 429. Retry with backoff. The provider's `Retry-After`
 *                     header is captured when present.
 *   - context_window: 413 / context_length_exceeded. Compaction must happen
 *                     before any further LLM call. The session is too large.
 *   - transient: 500/502/503/504/529/network. Retry with backoff.
 *   - abort: ctx.signal.aborted. User cancelled, or shutdown.
 *   - auth: 401 / invalid_api_key. Token / credential issue.
 *   - unknown: catch-all. Treated as transient for safety.
 *
 * The classifier is intentionally tolerant -- it inspects both the error
 * message string AND any status code on the error object. This is
 * necessary because different providers (Anthropic, OpenAI, etc.) format
 * their errors differently.
 */

export type LlmErrorCategory =
  | "balance"
  | "rate_limit"
  | "context_window"
  | "transient"
  | "abort"
  | "auth"
  | "unknown";

export interface ClassifiedLlmError {
  category: LlmErrorCategory;
  /** Can we try the same call again with backoff and expect a different result? */
  retryable: boolean;
  /** Should consumers switch to a non-LLM path (hard truncation, heuristic)? */
  fallbackToNonLlm: boolean;
  /** Does the user need to do something (top up balance, fix key)? */
  userActionRequired: boolean;
  /** Plain-text hint for the user. Empty for transient/unknown. */
  userMessage?: string;
  /** Hint from Retry-After header or computed backoff (ms). */
  retryAfterMs?: number;
  /** Original error for debugging. */
  raw: unknown;
}

const BALANCE_PATTERNS = [
  /402/,
  /insufficient[_ ]balance/i,
  /billing/i,
  /payment[_ ]required/i,
  /quota[_ ]exceeded/i,
];

/**
 * Canonical rate-limit patterns — single source of truth (dedupe merged
 * the drifted substring-list copy that lived in lib/ai/llm-call.ts).
 * Superset semantics:
 *   - /429/ matches anywhere in the text (covers `startsWith("429")` consumers;
 *     "1429" also matches — accepted, that was already llm-error's behavior)
 *   - /rate[_ ]limit/ and /too[_ ]many[_ ]requests/ match the space and
 *     underscore forms ("rate limit", "rate_limit", …)
 *   - /throttl/i matches "throttle" / "throttled" / "throttling" — widened
 *     from the llm-call.ts list (which only had "throttled"); for
 *     classifyLlmError this moves such errors from `unknown` to `rate_limit`
 */
export const RATE_LIMIT_PATTERNS = [
  /429/,
  /rate[_ ]limit/i,
  /too[_ ]many[_ ]requests/i,
  /throttl/i,
];

/** True when the text looks like an HTTP rate-limit condition (RATE_LIMIT_PATTERNS). */
export function isRateLimitText(text: string): boolean {
  return matchesAny(text, RATE_LIMIT_PATTERNS);
}

/**
 * Extract the first standalone 3-digit HTTP status code (400-599) from an
 * error TEXT. Keyring failures arrive as plain strings (no error object for
 * extractStatusCode), and unclassified failures must still carry their HTTP
 * code in the health record so root-causing needs no log forensics.
 * Guards: not part of a longer number on either side ("1429" is not 429,
 * "6721" is not 672); only 4xx/5xx (timestamps like "42.123" cannot produce
 * a false 1xx/2xx hit).
 */
export function extractHttpCodeFromText(text: string): number | undefined {
  const m = /(?:^|[^0-9])(4\d{2}|5\d{2})(?![0-9])/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * True when the text looks like a context-window / payload-too-large error
 * (CONTEXT_WINDOW_PATTERNS: 413, context_length_exceeded...). Canonical
 * helper for text-based consumers: pi-core surfaces agent-loop API
 * failures as plain strings (assistant errorMessage), where classifyLlmError
 * is also usable, but error text arrives in several shapes — this is the one
 * text predicate so emergency-offload consumers never fork the pattern list.
 */
export function isContextWindowErrorText(text: string): boolean {
  return matchesAny(text, CONTEXT_WINDOW_PATTERNS);
}

const CONTEXT_WINDOW_PATTERNS = [
  /413/,
  /context[_ ]length[_ ]exceeded/i,
  /context[_ ]window/i,
  /maximum[_ ]context/i,
  /prompt[_ ]is[_ ]too[_ ]long/i,
];

const TRANSIENT_PATTERNS = [
  /500/,
  /502/,
  /503/,
  /504/,
  /529/,
  /overloaded/i,
  /server[_ ]error/i,
  /temporarily[_ ]unavailable/i,
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /network[_ ]error/i,
  // Network idioms (sleep/wake timeouts, dropped sockets): these must land in
  // `transient` rather than `unknown` so consumers (session_health, watchdog
  // quota gating) treat them as retryable noise, never quota/auth problems.
  /fetch failed/i,
  /socket hang up/i,
  /econnaborted/i,
  /epipe/i,
  /eai[_ ]again/i,
  /und[_ ]err/i,
  /other side closed/i,
];

const AUTH_PATTERNS = [/401/, /invalid[_ ]api[_ ]key/i, /unauthorized/i, /authentication/i];

/** Try to extract a numeric status code from the error object. */
function extractStatusCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    // Common shapes: { status: 402 }, { statusCode: 402 }, { code: 402 }
    for (const key of ["status", "statusCode", "code"]) {
      const v = e[key];
      if (typeof v === "number" && v >= 400 && v < 600) return v;
    }
    // pi-ai / anthropic / openai error shapes
    if (typeof e.error === "object" && e.error !== null) {
      const inner = e.error as Record<string, unknown>;
      if (typeof inner.code === "string") {
        // e.g. "insufficient_balance", "rate_limit_exceeded"
        return undefined;
      }
    }
  }
  return undefined;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

function tryExtractRetryAfter(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    // pi-ai / fetch may put headers in `headers` or `response.headers`
    const headers =
      (e.headers as Record<string, string> | undefined) ??
      ((e.response as Record<string, unknown> | undefined)?.headers as
        | Record<string, string>
        | undefined);
    if (headers) {
      const ra = headers["retry-after"] ?? headers["Retry-After"];
      if (typeof ra === "string") {
        const seconds = parseInt(ra, 10);
        if (!isNaN(seconds)) return seconds * 1000;
      }
    }
  }
  return undefined;
}

function makeError(
  category: LlmErrorCategory,
  raw: unknown,
  extras: Partial<ClassifiedLlmError> = {},
): ClassifiedLlmError {
  const defaults: Record<
    LlmErrorCategory,
    Omit<ClassifiedLlmError, "category" | "raw" | "userMessage" | "retryAfterMs">
  > = {
    balance: {
      retryable: false,
      fallbackToNonLlm: true,
      userActionRequired: true,
    },
    rate_limit: {
      retryable: true,
      fallbackToNonLlm: false,
      userActionRequired: false,
    },
    context_window: {
      retryable: false,
      fallbackToNonLlm: true,
      userActionRequired: false,
    },
    transient: {
      retryable: true,
      fallbackToNonLlm: false,
      userActionRequired: false,
    },
    abort: {
      retryable: false,
      fallbackToNonLlm: false,
      userActionRequired: false,
    },
    auth: {
      retryable: false,
      fallbackToNonLlm: true,
      userActionRequired: true,
    },
    unknown: {
      retryable: true,
      fallbackToNonLlm: false,
      userActionRequired: false,
    },
  };
  const base: ClassifiedLlmError = {
    category,
    raw,
    ...defaults[category],
  };
  return { ...base, ...extras };
}

export function classifyLlmError(err: unknown): ClassifiedLlmError {
  if (err == null) return makeError("unknown", err);

  // Abort detection first -- the user cancelled or the session shut down.
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.name === "AbortError" || e.aborted === true) {
      return makeError("abort", err);
    }
    if (e.code === "ABORT_ERR" || (typeof e.message === "string" && /aborted/i.test(e.message))) {
      return makeError("abort", err);
    }
  }

  const status = extractStatusCode(err);
  const message =
    typeof err === "object" && err !== null && typeof (err as any).message === "string"
      ? (err as any).message
      : String(err);
  const text = `${status ?? ""} ${message}`.trim();

  if (status === 402 || matchesAny(text, BALANCE_PATTERNS)) {
    return makeError("balance", err);
  }
  if (status === 429 || matchesAny(text, RATE_LIMIT_PATTERNS)) {
    return makeError("rate_limit", err, { retryAfterMs: tryExtractRetryAfter(err) });
  }
  if (status === 401 || matchesAny(text, AUTH_PATTERNS)) {
    return makeError("auth", err);
  }
  if (status === 413 || matchesAny(text, CONTEXT_WINDOW_PATTERNS)) {
    return makeError("context_window", err);
  }
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
    return makeError("transient", err);
  }
  if (matchesAny(text, TRANSIENT_PATTERNS)) {
    return makeError("transient", err);
  }
  return makeError("unknown", err);
}
