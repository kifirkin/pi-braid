# lib/error-classifier.ts

**Purpose**: Structured error classification that replaces fragile regex-based error detection with HTTP status-code-first logic.

## Error Categories

| Category           | Retryable?               | Examples                                                             |
| ------------------ | ------------------------ | -------------------------------------------------------------------- |
| `TRANSIENT`        | ✅ Yes (wait + retry)    | 429 (rate limit), 5xx (server error), 529 (overloaded), "overloaded" |
| `CLIENT_ERROR`     | ❌ No (will repeat)      | 4xx (auth, not found, bad request), invalid API key                  |
| `CONTEXT_OVERFLOW` | ❌ No (needs compaction) | 400 context overflow, token limit exceeded                           |
| `UNKNOWN`          | ⚠️ Conservative retry    | Unrecognized error format                                            |

## Key Functions

| Function                     | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `classifyError(error)`       | Full classification from error object → `ErrorClassification`     |
| `extractHttpStatus(error)`   | Extract HTTP status from Axios/Fetch error or message string      |
| `extractProviderCode(error)` | Extract provider-specific error code (e.g., "insufficient_quota") |

## ErrorClassification

```typescript
{
  category: ErrorCategory,
  httpStatus: number | null,
  providerCode: string | null,
  retryable: boolean,
  reason: string,
}
```

## Classification Hierarchy

1. Extract HTTP status code from error object → `HTTP_TRANSIENT_RETRYABLE(429,5xx)` or non-retryable `4xx`
2. Extract provider code → `"overloaded"`, `"rate_limit"` → TRANSIENT
3. Check for explicit context overflow markers → CONTEXT_OVERFLOW
4. Fallback: UNKNOWN → conservative retry (retryable: true)

## Key Patterns

- **Status-code-first**: HTTP status codes are the most reliable signal. Text matching is a fallback.
- **Conservative for unknown**: UNKNOWN defaults to `retryable: true` to avoid missing recoverable errors.
- **Context overflow special case**: Detected separately from CLIENT_ERROR because the fix is compaction, not retry.
