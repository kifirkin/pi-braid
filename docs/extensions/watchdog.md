# Extension: watchdog

**Status**: ✅ Working
**Tests**: None
**Version**: v0.4.x

## Purpose

Extension health monitoring — tracks tool success rates per extension, detects hung or degraded extensions, and provides `/extension-health` command for diagnostics.

## Architecture

Passive monitoring — observes tool execution events and tracks per-extension success/failure counts. No active probing. Degradation thresholds:

- Error spike: >3 consecutive errors from same extension
- Total failure: 100% failure rate over last 5 calls

## Events Handled

| Event                | Handler                                                    |
| -------------------- | ---------------------------------------------------------- |
| `tool_execution_end` | Track per-tool success/failure, update per-extension stats |
| `turn_end`           | Check for degraded extensions, emit warnings               |

## Key Patterns

- **Per-extension tracking**: Maps extension source → success/failure counts. Sliding window of last 10 calls per extension.
- **Warnings**: Emitted as `[auto]` whispers when degradation detected — e.g., "Watchdog: extension x has 3 consecutive errors."
- **No action**: Watchdog warns but doesn't intervene. Extension disabling is left to the agent.
