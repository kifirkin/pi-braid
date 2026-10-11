<!-- status: current -->

# Analytics Extension

Self-contained tool usage analytics. Tracks tool call counts, durations,
success/failure rates, tool sequences and patterns, session-level metrics,
and emits alerts on degradation/anomaly.

## Architecture

| File            | Purpose                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `index.ts`      | Extension entry point; registers event listeners and tool result hooks |
| `types.ts`      | Type definitions for metrics, alerts, A/B variants                     |
| `core.ts`       | Core metrics collection (counters, histograms)                         |
| `format.ts`     | Human-readable output formatting for `get_session_metrics`             |
| `shared.ts`     | Shared utilities (alert emission, persistence helpers)                 |
| `ab-variant.ts` | A/B experiment variant tracking (BR3)                                  |

## What it tracks

- **Per-tool metrics**: call count, success/failure rate, p50/p95 duration
- **Tool sequences**: which tools tend to be called together (used by SOP suggestion)
- **Session metrics**: turn count, total tokens, error rate
- **A/B variants**: which experimental branch a session is on (set via
  `set_ab_variant` - note: that tool was removed in the 0.3.0 audit; A/B
  state is now set via `behavior` action=activate)

## Tools exposed

_(None - both `get_session_metrics` and `get_tool_reliability` removed in
2026-06 tool-inventory audit. They were passive observability with no
internal consumers. Background tracking and the `analytics:all` slash
command remain.)_

## Event-bus contract

| Emits                                                         | Listens to                  |
| ------------------------------------------------------------- | --------------------------- |
| `analytics_alert` (degradation, addiction, recovery, anomaly) | `self/watchdog/index.ts:51` |

## Persistence

Metrics are written to `METRICS_FILE` (under `BRAID_DATA_DIR/`) on
session_shutdown. The file is JSON; safe to read with `jq` for
post-hoc analysis.

## Local Contracts

- **Session-scoped state** via `getExtensionState(ctx, key, factory)`.
  No cross-session contamination.
- **No whisper emission**: analytics is purely passive observation.
  When it detects degradation, it emits `analytics_alert` to the bus
  and the watchdog decides what to do.
- **Reset**: `resetCriticStats()` is called on session_start to clear
  the critic-gate counters (not analytics; analytics resets on
  session_shutdown).
