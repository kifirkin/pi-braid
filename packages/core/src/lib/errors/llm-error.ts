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
 * Classification is status-first: a status the failure carries (on the error
 * object, or framed in its text) names the class, and the wording arms are
 * the fallback for a message that names none. A three-digit run the text does
 * not frame is not a status: a duration, a port and a buffered count are not
 * refusals.
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
  /**
   * Set when the failure is about the SHAPE of the request rather than its
   * timing: the same request will be refused the same way, so the retry path
   * and any wake that would start a fresh turn are both wrong. The ring
   * records the same class as a request-shape death.
   */
  requestShape?: "context_length";
  /** Plain-text hint for the user. Empty for transient/unknown. */
  userMessage?: string;
  /** Hint from Retry-After header or computed backoff (ms). */
  retryAfterMs?: number;
  /** Original error for debugging. */
  raw: unknown;
}

/**
 * Wording that names an exhausted account. Provider error vocabulary, English
 * and not: `Ваш баланс исчерпан` is a localised billing refusal the session
 * store records, and the two Cyrillic words are required together so
 * `балансировка` (load balancing) is not read as an empty account. A refusal
 * outside this table stays `unknown` rather than guessed at.
 */
const BALANCE_PATTERNS = [
  /insufficient[_ ]balance/i,
  /billing/i,
  /payment[_ ]required/i,
  /quota[_ ]exceeded/i,
  /баланс[а-яё]*\s+исчерпан/i,
];

/**
 * Wording that names a throttle: the arms `classifyLlmError` reads for a
 * message that frames no status. The status itself is read separately.
 */
const RATE_LIMIT_WORDING_PATTERNS = [/rate[_ ]limit/i, /too[_ ]many[_ ]requests/i, /throttl/i];

/**
 * Canonical rate-limit patterns for text callers -- single source of truth
 * (dedupe merged the drifted substring-list copy that lived in
 * lib/ai/llm-call.ts). The superset semantics are the predicate's published
 * contract, pinned by test-rate-limit-patterns.mjs:
 *   - /429/ matches anywhere in the text (covers `startsWith("429")` consumers;
 *     "1429" also matches -- the legacy behaviour this predicate keeps)
 *   - /rate[_ ]limit/ and /too[_ ]many[_ ]requests/ match the space and
 *     underscore forms ("rate limit", "rate_limit", …)
 *   - /throttl/i matches "throttle" / "throttled" / "throttling" -- widened
 *     from the llm-call.ts list (which only had "throttled")
 *
 * `classifyLlmError` does not read this list: a numeric arm there has to name
 * a status token rather than a substring, so the classifier takes `429` from
 * the status channel and the wording arms from the list above.
 */
export const RATE_LIMIT_PATTERNS = [/429/, ...RATE_LIMIT_WORDING_PATTERNS];

/** True when the text looks like an HTTP rate-limit condition (RATE_LIMIT_PATTERNS). */
export function isRateLimitText(text: string): boolean {
  return matchesAny(text, RATE_LIMIT_PATTERNS);
}

/**
 * What the text presents as an HTTP status. Keyring failures arrive as plain
 * strings (no error object for extractStatusCode), and unclassified failures
 * must still carry their HTTP code in the health record so root-causing needs
 * no log forensics.
 *
 * A run the text frames is a status; an unframed one is not. The frames are
 * the ones producers print: the code first (`429: {…}`), after an opening
 * bracket or angle (`(429)`, `<503>`), behind `HTTP`, or behind a
 * `status`/`code`/`response` word. A duration (`4012 ms`), a buffered count
 * (`1429`), the fraction of a decimal and a port (`host:443`) are the shapes
 * that sit where a status would, and reading one of them as a status is how a
 * timeout becomes an authentication failure. The earliest framing wins, so a
 * status the text already gave is not outranked by a port printed later.
 */
const STATUS_FRAMES: readonly RegExp[] = [
  /^\s*(4\d{2}|5\d{2})(?![\d.])/,
  /[([{<>]\s*(4\d{2}|5\d{2})(?![\d.])/,
  /\bhttp(?:\/\d(?:\.\d)?)?\s*[:=]?\s*(4\d{2}|5\d{2})(?![\d.])/i,
  /\b(?:status[_ ]?code|status|code|response)\b[^\d\n]{0,8}?(4\d{2}|5\d{2})(?![\d.])/i,
];

export function extractHttpCodeFromText(text: string): number | undefined {
  let framed: { at: number; status: number } | undefined;
  for (const frame of STATUS_FRAMES) {
    const match = frame.exec(text);
    if (!match) continue;
    const at = match.index + (match[0].length - match[1].length);
    if (!framed || at < framed.at) framed = { at, status: Number(match[1]) };
  }
  return framed?.status;
}

/**
 * True when the text looks like a context-window / payload-too-large error
 * (a framed 413, or CONTEXT_WINDOW_PATTERNS: context_length_exceeded…).
 * Canonical helper for text-based consumers: pi-core surfaces agent-loop API
 * failures as plain strings (assistant errorMessage), where classifyLlmError
 * is also usable, but error text arrives in several shapes -- this is the one
 * text predicate so emergency-offload consumers never fork the pattern list.
 */
export function isContextWindowErrorText(text: string): boolean {
  return extractHttpCodeFromText(text) === 413 || matchesAny(text, CONTEXT_WINDOW_PATTERNS);
}

const CONTEXT_WINDOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /context[_ ]window/i,
  /maximum[_ ]context/i,
  /prompt[_ ]is[_ ]too[_ ]long/i,
];

/**
 * Context-length refusals in their 400-shaped wordings. A provider that
 * rejects an oversized body with `400 invalid_request_error` is naming a
 * request-shape problem: the numbers change, the verdict does not. Kept apart
 * from CONTEXT_WINDOW_PATTERNS so the bare `413` arm keeps its meaning and a
 * 5xx body cannot be pulled in by a phrase like "too many tokens".
 */
const REQUEST_SHAPE_CONTEXT_PATTERNS = [
  /maximum[_ ]context[_ ]length/i,
  /context[_ ]length/i,
  /reduce[ _]the[ _]length[ _]of[ _]the/i,
  /(input|prompt|request|messages?)[ _]is[ _]too[ _]long/i,
  /too[ _]many[ _](input[ _])?tokens/i,
  /exceeds?[ _]the[ _](model'?s?[ _])?(maximum|max)/i,
];

/**
 * True when the text names a context-length refusal. Used by consumers that
 * only have text (pi-core surfaces session failures as the assistant's
 * errorMessage string) and must tell "the request must change" apart from
 * "try again later" without re-deriving the pattern list.
 */
export function isContextLengthRequestShape(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : typeof err === "object" && err !== null
        ? String((err as { message?: unknown }).message ?? "")
        : "";
  if (!text) return false;
  // A framed 5xx is the same "try again later" exclusion the transient
  // wording arms provide; the number is read through the framing rule, not as
  // a substring.
  const status = extractHttpCodeFromText(text);
  if (status !== undefined && status >= 500 && status < 600) return false;
  return (
    matchesAny(text, [
      /context[_ ]length[_ ]exceeded/i,
      /context[_ ]window/i,
      /maximum[_ ]context/i,
      /prompt[_ ]is[_ ]too[_ ]long/i,
      ...REQUEST_SHAPE_CONTEXT_PATTERNS,
    ]) && !matchesAny(text, TRANSIENT_PATTERNS)
  );
}

const TRANSIENT_PATTERNS = [
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

/**
 * Status codes whose number alone names the class. 403 is deliberately absent:
 * a 403 is recorded here as a WAF block, a payload refusal, a capacity refusal
 * and a spent quota, so the number cannot tell a credential problem from the
 * route's own answer; its wording decides, as it did before. Codes outside
 * this table fall through to the wording arms, which keeps a 400 that names a
 * context-length refusal `context_window` and a bare 404 `unknown`.
 */
const STATUS_CLASSES: Readonly<Record<number, LlmErrorCategory>> = {
  401: "auth",
  402: "balance",
  408: "transient",
  413: "context_window",
  429: "rate_limit",
  500: "transient",
  502: "transient",
  503: "transient",
  504: "transient",
  529: "transient",
};

const AUTH_PATTERNS = [/invalid[_ ]api[_ ]key/i, /unauthorized/i, /authentication/i];

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

/** The message a failure carries; a non-object is its own text. */
function errorMessageOf(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as any).message === "string"
    ? (err as any).message
    : String(err);
}

/** The extras a numeric class carries: the header for a throttle, the shape for a payload. */
function statusExtras(status: number, err: unknown): Partial<ClassifiedLlmError> {
  if (status === 429) return { retryAfterMs: tryExtractRetryAfter(err) };
  if (status === 413) return { requestShape: "context_length" };
  return {};
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

  const message = errorMessageOf(err);
  // The structured channel decides before any wording: a status the object
  // carries, or one its text frames. A 503 whose body says "authentication"
  // describes the server, not the owner's key, and a 429 whose body says
  // "insufficient balance" is still a throttle.
  const status = extractStatusCode(err) ?? extractHttpCodeFromText(message);
  if (status !== undefined) {
    const numeric = STATUS_CLASSES[status];
    if (numeric !== undefined) {
      return makeError(numeric, err, statusExtras(status, err));
    }
  }

  if (matchesAny(message, BALANCE_PATTERNS)) {
    return makeError("balance", err);
  }
  if (matchesAny(message, RATE_LIMIT_WORDING_PATTERNS)) {
    return makeError("rate_limit", err, { retryAfterMs: tryExtractRetryAfter(err) });
  }
  if (matchesAny(message, AUTH_PATTERNS)) {
    return makeError("auth", err);
  }
  if (matchesAny(message, CONTEXT_WINDOW_PATTERNS)) {
    return makeError("context_window", err, { requestShape: "context_length" });
  }
  // A 400 whose body names a context-length refusal is the same class as a
  // 413: the request shape is wrong, so it must never fall through to
  // `unknown` (which is retryable, and retrying it unchanged cannot work).
  if (status === 400 && matchesAny(message, REQUEST_SHAPE_CONTEXT_PATTERNS)) {
    return makeError("context_window", err, { requestShape: "context_length" });
  }
  if (matchesAny(message, TRANSIENT_PATTERNS)) {
    return makeError("transient", err);
  }
  return makeError("unknown", err);
}
