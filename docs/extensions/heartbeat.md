# Extension Group: heartbeat

Proactive cognitive scheduling extensions. Research: paper 2604.14178.

## Extensions

| Extension              | Files | Purpose                                                                               |
| ---------------------- | ----- | ------------------------------------------------------------------------------------- |
| `heartbeat-scheduler/` | 1     | Proactive scheduling tick, belief-policy-engine integration, MARS calibration.        |
| `analytics/`           | 1     | Tool use tracking, rolling 50-window analysis, addiction detection, tool reliability. |
| `behavioral-drift/`    | 1     | Tool pattern drift detection via Jensen-Shannon divergence against session baseline.  |

Total: 3 sub-extensions.

## Key Architecture

**Heartbeat density:** Context density tracked as heartbeat metric → affects scheduling decisions.

**Tool addiction detection:** Rolling 50-window, `tool_use/overuse` signal emitted to belief-policy-engine. Analytics is the **single source of truth** (enforcement and feedback removed from duplicate detection).

**Context density → compression:** `updateContextDensity()` from semanticCompress stats feeds into heartbeat analytics.

**Auto-compaction:** When context density stays below 40% for 3+ consecutive ticks, auto-triggers `ctx.compact()` (20-turn cooldown to prevent oscillation).

**Behavioral drift:** Tracks tool category distribution during first 10 turns as baseline. Compares recent window against baseline using Jensen-Shannon divergence. Flags when divergence > 0.25 (max 3 warnings per session).

## See Also

- [heartbeat-scheduler.md](heartbeat-scheduler.md) — scheduling
- [analytics.md](analytics.md) — tool use tracking
- [docs/lib/belief-policy-engine.md](../lib/belief-policy-engine.md) — policy engine
