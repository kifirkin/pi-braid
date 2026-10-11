<!-- status: current -->

# src/lib/telemetry/ - Telemetry accumulators

Bounded, zero-cost telemetry singletons for the degradation-detection loop
(COMPACTION-LOSS-INVESTIGATION item 4). No per-turn work beyond integer
increments; consumers read from `context_inspect` and heartbeat analytics.

| File                   | Owns                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `drift-signals.ts`     | Per-process drift counters (re-reads, goal shifts, stale paths, repeated failures) + a small bounded ring.                                                                                                                                                                                                                           |
| `context-heartbeat.ts` | Context/RSS/session-size heartbeat: one append-only JSONL line per tick at `~/.pi/agent/braid/telemetry/context-heartbeat.jsonl` . Two hooks: heartbeat-scheduler tick (Hook 1, ctx available) + watchdog engine check via injected `telemetryEmit` dep (Hook 2, idle-inclusive). Scalar-only entries enforced at the sink boundary. |

## Rules

- **Integer increments only.** Detection/gating lives at call sites, never here.
- **No per-turn overhead** beyond a counter bump and a bounded ring append.
- **Use `const` objects mutated in place** (like `compactionHealth` in
  context-manager/handlers/shared.ts), never module-level `let`, and expose a
  `reset*()` for session start and tests.
- `lib/` may not import from `extensions/` (layer boundary); this module is
  dependency-free.
- **Exception (context-heartbeat.ts):** the JSONL sink does an
  fs append + a bounded entries walk per heartbeat tick (not just integer
  bumps) - that is its purpose (HYGIENE-INVESTIGATION §4). It stays
  dependency-light (state/detection imports only), takes `healthMode` as a
  parameter (never imports enforcement), and keeps every failure non-fatal.
  Per-tick state lives in `getExtensionState`, not module scope.
