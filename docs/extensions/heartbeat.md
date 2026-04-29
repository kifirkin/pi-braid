# Extension Group: heartbeat

Proactive cognitive scheduling extensions. Research: paper 2604.14178.

## Extensions

| Extension | Files | Purpose |
|---|---|---|
| `heartbeat-scheduler/` | 1 | Proactive scheduling tick, belief-policy-engine integration, MARS calibration. |
| `analytics/` | 1 | Tool use tracking, rolling 50-window analysis, addiction detection, tool reliability. |

Total: 2 sub-extensions.

## Key Architecture

**Heartbeat density:** Context density tracked as heartbeat metric → affects scheduling decisions.

**Tool addiction detection:** Rolling 50-window, `tool_use/overuse` signal emitted to belief-policy-engine. Analytics is the **single source of truth** (enforcement and feedback removed from duplicate detection).

**Context density → compression:** `updateContextDensity()` from semanticCompress stats feeds into heartbeat analytics.

## See Also

- [heartbeat-scheduler.md](heartbeat-scheduler.md) — scheduling
- [analytics.md](analytics.md) — tool use tracking
- [docs/lib/belief-policy-engine.md](../lib/belief-policy-engine.md) — policy engine
