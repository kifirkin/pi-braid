# Retry Extension

**Purpose:** Captures tool call failures and user messages across sessions, enabling `/retry` and `/retry-status` commands that resend the last user message after an error.

## How It Works

### Turn Lifecycle

Every user turn follows: `input → agent_end`. The extension hooks both:

1. **`input` event** — captures the user's text + images into an in-memory `lastUserMessage` and persists it as a session custom entry (`__retry_state`).

2. **`agent_end` event** — inspects tool results and assistant messages for errors (HTTP 4xx/5xx, `context_overflow`, `ECONNRESET`, etc.). On error, categorizes and records it alongside the turn metadata. A fallback capture of `lastUserMessage` runs only if the `input` event was missed (e.g. after reload).

3. **Persist dedup** — `persistState` computes a content hash of the meaningful state fields and skips appending an entry if nothing changed since the last persist. This prevents accumulating hundreds of `__retry_state` custom entries per session.

### State Recovery on Session Start

When a session starts (new, resume, fork), `recoverState` runs:

1. **Priority 1 — Custom entry:** Scans ALL `__retry_state` custom entries (not just the last in iteration order, because `getEntries()` tree-traversal order may not be chronological in branched sessions). Picks the entry with the **highest timestamp** that is younger than 5 minutes. If found, uses its `lastUserMessage` and `lastError` to reconstruct state.

2. **Priority 2 — User message fallback:** If no valid custom entry is found (pre-extension sessions, very old entries), scans session messages for the **most recent user message by timestamp**, not by array position. This avoids picking up messages from stale branches.

### State Machine

```
  idle ──(user sends message)──→ active
  active ──(error)──→ waiting (records error, increments failureCount)
  waiting ──(/retry command)──→ active (resends lastUserMessage)
  active ──(tool success)──→ idle (resets failureCount)
  idle ──(session ends)──→ (state persisted for recovery)
```

### Retry Commands

| Command | Effect |
|---------|--------|
| `/retry` | Resends the last captured user message. Shows message preview and error context before retrying. |
| `/retry-status` | Displays current state: last message, last error (with age + category), failure count. |

## Error Categories

| Category | Detection | Hint |
|----------|-----------|------|
| `context_overflow` | Response text contains "context_length" or "context_overflow" | Compaction may help |
| `quota_exceeded` | HTTP 429, 402, 507, or message contains "quota" | Add API keys / switch providers |
| `auth_error` | HTTP 401, 403, or message contains "auth" or "unauthorized" | Check API keys |
| `transient` | HTTP 5xx, 429, `ECONNRESET`, `ETIMEDOUT` | Should work on retry |
| `bad_request` | HTTP 400, 404, 415, or message contains "bad request" | Likely won't work on retry |

## API

- `getState()` — returns the current `RetryState`
- `captureUserInput(pi, text, images, entryId)` — records user message, persists
- `recordAgentEnd(pi, entryId, hadError, errorMessage, httpStatus)` — records error state, persists
- `recoverState(sessionManager)` — recover state from session entries on startup
- `persistState(pi)` — persist state as custom entry (deduped by content hash)
- `continueRetry(pi, ctx)` — resend last user message via `pi.sendUserMessage`

## Types

- **`RetryState`**: `lastUserMessage`, `lastUserEntryId`, `lastError`, `lastTurn`, `failureCount`, `version`
- **`ErrorRecord`**: `message`, `category`, `timestamp`, `httpStatus`, `toolName?`
- **`TurnRecord`**: `entryId`, `timestamp`, `hadError`
- **`RetryConfig`**: `maxRetries`, `baseDelay`, `maxDelay`, `backoff`, `retryableErrors`
