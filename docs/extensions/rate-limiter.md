# Extension: rate-limiter

**Status**: ✅ Working
**Tests**: None
**Version**: v0.6.x

## Purpose

Rate limiting and concurrency control — prevents tool call overload with token bucket per-second limits and global concurrency cap. Ensures the agent doesn't overwhelm APIs or the system.

## Architecture

Two-tier rate limiting:
1. **Per-second token bucket** — `maxTokens` tokens refilled per second. Each tool call consumes tokens (weighted by tool cost).
2. **Global concurrency** — `maxConcurrent` cap on simultaneous tool executions.

## Events Handled

| Event | Handler |
|-------|---------|
| `tool_execution_start` | Acquire rate limit token (blocks if limit exceeded) |
| `tool_execution_end` | Release concurrency slot, return token |

## Key Patterns

- **Token bucket algorithm**: Classic token bucket — tokens accumulate up to `maxTokens`, consumed on each tool call, refilled at `tokensPerSecond` rate.
- **Concurrency slots**: Simple counter-based concurrency limit. Tool execution end decrements and wakes waiters.
- **Weighted cost**: Tool calls can have different token costs (e.g., browser_screenshot costs more than read_file).
- **Non-blocking acquire**: Returns `{ allowed, waitMs }` so the caller can decide whether to wait or skip.
