/**
 * Error Classifier - Structured error classification for API/compaction failures
 *
 * Replaces fragile regex-based error detection with structured classification.
 * Extracts HTTP status codes and provider-specific error codes from error messages,
 * then maps them to retryability decisions.
 *
 * Error categories:
 * - TRANSIENT: Server-side issues that may succeed on retry (5xx, 429, overload)
 * - CLIENT_ERROR: Request format/auth issues that won't change (4xx, auth)
 * - CONTEXT_OVERFLOW: Token limit exceeded - needs compaction, not retry
 * - UNKNOWN: Unclassified - conservative retry
 */

export type ErrorCategory = "TRANSIENT" | "CLIENT_ERROR" | "CONTEXT_OVERFLOW" | "UNKNOWN";

export interface ErrorClassification {
  category: ErrorCategory;
  httpStatus: number | null;
  providerCode: string | null;
  retryable: boolean;
  reason: string;
}

// HTTP status code ranges
const HTTP_TRANSIENT_RETRYABLE = new Set([429, 500, 502, 503, 504]);
const HTTP_CLIENT_ERROR_NON_RETRYABLE = new Set([
  400, 401, 403, 404, 405, 408, 410, 413, 415, 422, 429,
]); // 429 is debatable

// Provider-specific error codes (extracted from error messages)
const CEREBRAS_OVERLOAD_CODES = new Set(["529", "OVERLOADED", "RATE_LIMITED"]);
const ANTHROPIC_OVERLOAD_CODES = new Set(["overloaded_error", "rate_limited_error"]);
const OPENAI_OVERLOAD_CODES = new Set(["rate_limit_exceeded", "503_service_unavailable"]);

// Context overflow markers (provider-specific)
const CONTEXT_OVERFLOW_MARKERS = [
  "context.?window.?exceeded",
  "token.?limit.?exceeded",
  "maximum.?context",
  "too.?many.?tokens",
  "input.?too.?long",
  "max.?tokens",
  "context.?length",
  "exceeds.?limit",
  "token.?exceeded",
].map((m) => new RegExp(m, "i"));

// Auth error markers (non-retryable)
const AUTH_ERROR_MARKERS = [
  "invalid.*api.?key",
  "authentication.*failed",
  "unauthorized",
  "forbidden",
  "api.?key.?invalid",
  "api.?key.?missing",
  "api.?key.?required",
  "bearer.?token",
  "401",
  "403",
].map((m) => new RegExp(m, "i"));

// Explicit non-retryable markers
const NON_RETRYABLE_MARKERS = [
  "model.*not.*found",
  "model.*does.*not.*exist",
  "model.*not.*support",
  "400.*status",
  "status.?code.?400",
  "4\\s*0\\s*0\\b",
  "no body",
  "content.?type.*invalid",
  "invalid.*request.*format",
  "malformed.*request",
  "invalid.*json",
].map((m) => new RegExp(m, "i"));

// Explicit retryable markers (when no HTTP code extracted)
const RETRYABLE_MARKERS = [
  "overload",
  "too many requests",
  "server error",
  "service unavailable",
  "connection.?error",
  "connection.?refused",
  "fetch failed",
  "upstream.?connect",
  "reset before headers",
  "timeout",
  "temporary",
  "unavailable",
  "try again",
  "enginecore",
].map((m) => new RegExp(m, "i"));

/**
 * Extract HTTP status code from error message
 * Handles formats: "HTTP 500", "status 500", "500 Internal Server Error", "Error 500", "code: 500"
 */
function extractHttpStatus(errorMessage: string): number | null {
  const patterns = [
    /(?:http[\s_-]?(?:status|code)|status|error|code)[\s:]*(\d{3})/i,
    /\b(\d{3})\s+(?:internal\s+)?(?:server\s+)?error\b/i,
    /\b(5\d{2})\b/,
    /\b(4\d{2})\b/,
  ];

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 100 && code < 600) return code;
    }
  }
  return null;
}

/**
 * Extract provider-specific error codes from error messages
 * Handles: "Error 529: ...", "cerebras: 529", "code: OVERLOADED", etc.
 */
function extractProviderCode(errorMessage: string): string | null {
  // Common provider code patterns
  const patterns = [
    /(?:error\s+)?(?:code|status)[\s:]*([A-Z0-9_]+)/i,
    /(?:cerebras|anthropic|openai|api)[\s:]*(\d{3}|[A-Z_]+)/i,
    /429\b/,
    /529\b/,
    /OVERLOAD/i,
    /RATE_LIMIT/i,
    /OVERFLOW/i,
  ];

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      const code = match[1]?.toUpperCase() || match[0].toUpperCase();
      if (code && code.length <= 20) return code;
    }
  }
  return null;
}

/**
 * Classify error message into structured ErrorClassification
 *
 * Decision hierarchy:
 * 1. HTTP status codes take precedence (5xx = retry, 4xx = no retry)
 * 2. Provider codes (529 overload, auth failures) override text matching
 * 3. Explicit overflow markers → CONTEXT_OVERFLOW (no retry, needs compaction)
 * 4. Explicit non-retryable markers → CLIENT_ERROR
 * 5. Explicit retryable markers → TRANSIENT
 * 6. Unknown → UNKNOWN (retry by default, conservative)
 */
export function classifyError(errorMessage: string): ErrorClassification {
  const message = errorMessage || "";

  // 1. Extract structured codes
  const httpStatus = extractHttpStatus(message);
  const providerCode = extractProviderCode(message);

  // 2. HTTP status-based classification
  if (httpStatus !== null) {
    if (HTTP_TRANSIENT_RETRYABLE.has(httpStatus)) {
      return {
        category: "TRANSIENT",
        httpStatus,
        providerCode,
        retryable: true,
        reason: `HTTP ${httpStatus}: Server-side error, may succeed on retry`,
      };
    }
    if (HTTP_CLIENT_ERROR_NON_RETRYABLE.has(httpStatus)) {
      // 429 is ambiguous - could be rate limit (retry) or quota exceeded (no retry)
      if (httpStatus === 429) {
        if (providerCode && CEREBRAS_OVERLOAD_CODES.has(providerCode)) {
          return {
            category: "TRANSIENT",
            httpStatus,
            providerCode,
            retryable: true,
            reason: `HTTP 429 + ${providerCode}: Rate limit with overload code, retry with backoff`,
          };
        }
      }
      return {
        category: "CLIENT_ERROR",
        httpStatus,
        providerCode,
        retryable: false,
        reason: `HTTP ${httpStatus}: Client error, request will not succeed on retry`,
      };
    }
  }

  // 3. Provider code-based classification
  if (providerCode) {
    if (CEREBRAS_OVERLOAD_CODES.has(providerCode)) {
      return {
        category: "TRANSIENT",
        httpStatus,
        providerCode,
        retryable: true,
        reason: `Cerebras ${providerCode}: Server overloaded, retry with backoff`,
      };
    }
    if (ANTHROPIC_OVERLOAD_CODES.has(providerCode)) {
      return {
        category: "TRANSIENT",
        httpStatus,
        providerCode,
        retryable: true,
        reason: `Anthropic ${providerCode}: Rate limited, retry with backoff`,
      };
    }
    if (OPENAI_OVERLOAD_CODES.has(providerCode)) {
      return {
        category: "TRANSIENT",
        httpStatus,
        providerCode,
        retryable: true,
        reason: `OpenAI ${providerCode}: Rate limit, retry with backoff`,
      };
    }
  }

  // 4. Context overflow check (needs compaction, not retry)
  for (const pattern of CONTEXT_OVERFLOW_MARKERS) {
    if (pattern.test(message)) {
      return {
        category: "CONTEXT_OVERFLOW",
        httpStatus,
        providerCode,
        retryable: false,
        reason: "Context/token limit exceeded: Needs compaction before retry",
      };
    }
  }

  // 5. Explicit non-retryable markers
  for (const pattern of NON_RETRYABLE_MARKERS) {
    if (pattern.test(message)) {
      return {
        category: "CLIENT_ERROR",
        httpStatus,
        providerCode,
        retryable: false,
        reason: "Permanent client error: Request format rejected or auth failed",
      };
    }
  }

  // 6. Explicit auth errors
  for (const pattern of AUTH_ERROR_MARKERS) {
    if (pattern.test(message)) {
      return {
        category: "CLIENT_ERROR",
        httpStatus,
        providerCode,
        retryable: false,
        reason: "Authentication/authorization failed: Check API key and permissions",
      };
    }
  }

  // 7. Explicit retryable markers
  for (const pattern of RETRYABLE_MARKERS) {
    if (pattern.test(message)) {
      return {
        category: "TRANSIENT",
        httpStatus,
        providerCode,
        retryable: true,
        reason: "Transient error: Network/server issue, retry likely to succeed",
      };
    }
  }

  // 8. Unknown - conservative retry (better to retry and fail than not retry when we should)
  return {
    category: "UNKNOWN",
    httpStatus,
    providerCode,
    retryable: true,
    reason: "Unknown error type: Conservative retry enabled",
  };
}

/**
 * Check if error is retryable - simplified boolean wrapper
 */
export function isRetryable(errorMessage: string): boolean {
  return classifyError(errorMessage).retryable;
}

/**
 * Get error category - for logging/debugging
 */
export function getErrorCategory(errorMessage: string): ErrorCategory {
  return classifyError(errorMessage).category;
}

/**
 * Check if an error qualifies for compaction retry.
 * Returns true for transient errors that may succeed on retry.
 */
export function isCompactionRetryable(errorMessage: string): boolean {
  return classifyError(errorMessage).retryable;
}
