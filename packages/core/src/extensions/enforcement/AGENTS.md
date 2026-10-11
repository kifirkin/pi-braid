<!-- status: current -->

# src/extensions/enforcement/ - Enforcement Layer

The enforcement layer. Translates signals from detectors/heartbeat/agents
into whispers. Implements the per-turn whisper cap, the dedup logic, and
the wake-up policy.

## Files at this level

| File                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state.ts`                           | Composed session-scoped state. Re-exports `ENFORCEMENT_PARAMS` and `EnforcementState` from `enforcement-types.ts`.                                                                                                                                                                                                                                                       |
| `enforcement-types.ts`               | The shared `ENFORCEMENT_PARAMS` and `EnforcementState` definitions. **Lives outside `state.ts` to break the circular dep** that would otherwise form between `state.ts <-> session-state.ts <-> verification-judge-state.ts`.                                                                                                                                            |
| `session-state.ts`                   | Per-turn tracking, config, topic-drift detector.                                                                                                                                                                                                                                                                                                                         |
| `whisper.ts`                         | The `sendTrackedMessage` wrapper with the whisper cap and metadata.                                                                                                                                                                                                                                                                                                      |
| `judge-utils.ts`                     | Helpers for the verification judge.                                                                                                                                                                                                                                                                                                                                      |
| `signals.ts`                         | The signal taxonomy (severity, source, priority).                                                                                                                                                                                                                                                                                                                        |
| `validation.ts`                      | Validation of whisper payloads.                                                                                                                                                                                                                                                                                                                                          |
| `similarity.ts`                      | Cosine similarity for dedup.                                                                                                                                                                                                                                                                                                                                             |
| `nudge-manager.ts`                   | Manages nudge cooldowns and dedup.                                                                                                                                                                                                                                                                                                                                       |
| `verification-judge.ts`              | The verification judge - runs in background.                                                                                                                                                                                                                                                                                                                             |
| `self-state-claims.ts`               | Deterministic self-state claim detector for the judge: scans the visible response for liveness/delivery/progress claims, suppresses them when the evidence window shows a probe call (session_health, health_maintenance, v2raytun_status, telegram_send); renders the judge's SELF-STATE CLAIMS section only when candidates survive (prompt byte-unchanged otherwise). |
| `task-evidence.ts`                   | Task-wide evidence lines (since last real user message) rebuilt from the pi session store for the judge prompt; survives turn breaks (wake-retry redelivery). Logs over the cap are compacted into LLM chunk summaries (newest chunk raw), with drop-oldest truncation as the fallback.                                                                                  |
| `verification-judge-state.ts`        | Judge/calibration helpers.                                                                                                                                                                                                                                                                                                                                               |
| `handler-registry.ts`                | Thin orchestrator that wires all handlers.                                                                                                                                                                                                                                                                                                                               |
| `register-tool-result-formatting.ts` | MI-3 Structured Output Catalyst - wraps read/grep/find/ls outputs in structured header format (opt-in).                                                                                                                                                                                                                                                                  |
| `event-types.ts`                     | Types for events that flow through the enforcement layer.                                                                                                                                                                                                                                                                                                                |
| `*-state.ts`                         | Sub-state files (tool-tracking, error-tracking, memory-hygiene, context-hygiene, scratchpad, thought-chain). Each owns its slice of the composed state.                                                                                                                                                                                                                  |

## Sub-directories

| Path        | Purpose                                                         |
| ----------- | --------------------------------------------------------------- |
| `handlers/` | Event handlers - register-session-_, turn-_, message-_, tool-_. |

## State architecture (CRITICAL)

The state is **composed from focused sub-state files**, not defined in
`state.ts` directly. This is to avoid the file getting unwieldy and to
allow sub-state modules to be tested in isolation.

**Import contract:**

- `state.ts` imports sub-state factories/resets from sub-state files.
- Sub-state files do **NOT** import from `state.ts`.
- `enforcement-types.ts` is the only file imported by both `state.ts` and
  the sub-state files that need `EnforcementState` or `ENFORCEMENT_PARAMS`.
- No structural test enforces this contract today; it is review-enforced.

## Wake-up policy

- **Wake (`triggerTurn: true`)**: enforcement-critical, turn-outcome,
  reasoning, metacognition, auto-recovery, analytics-degrade,
  threshold-exhausted, emergency-rotation, navigation-checkout, context-80%+,
  three-memory-reliability, compaction-retry errors.
- **No wake**: everything else. The delivery class decides how the message
  reaches the run (see the delivery contract in `lib/utils/injection-tracker.ts`):
  `delivery: "live"` steers a streaming run and appends when idle;
  `delivery: "park"` records for the end-of-turn flush. The whisper wrapper
  (`whisper.ts`) defaults to `live`, so analysis handlers
  (BPE/MARS/Dreamer/Drift), verification/conflict nudges, and reasoning
  advisories reach the running loop. Advisories that must not force a
  continuation turn pass `delivery: "park"`: tool-loop, post-compaction
  re-orientation after a natural stop, cycle hygiene, discoverability, and
  API-error guidance. Memory/hint/SOP channels park - they provide context
  for the agent's natural flow.

See individual handler files in `handlers/` for the per-source policy.
