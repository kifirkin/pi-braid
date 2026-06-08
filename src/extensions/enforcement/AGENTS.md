# src/extensions/enforcement/ — Enforcement Layer

The enforcement layer. Translates signals from detectors/heartbeat/agents
into whispers. Implements the per-turn whisper cap, the dedup logic, and
the wake-up policy.

## Files at this level

| File | Purpose |
|---|---|
| `state.ts` | Composed session-scoped state. Re-exports `ENFORCEMENT_PARAMS` and `EnforcementState` from `enforcement-types.ts`. |
| `enforcement-types.ts` | The shared `ENFORCEMENT_PARAMS` and `EnforcementState` definitions. **Lives outside `state.ts` to break the circular dep** that would otherwise form between `state.ts ↔ session-state.ts ↔ verification-judge-state.ts`. |
| `session-state.ts` | Per-turn tracking, config, topic-drift detector. |
| `whisper.ts` | The `sendTrackedMessage` wrapper with the whisper cap and metadata. |
| `judge-utils.ts` | Helpers for the verification judge. |
| `signals.ts` | The signal taxonomy (severity, source, priority). |
| `validation.ts` | Validation of whisper payloads. |
| `similarity.ts` | Cosine similarity for dedup. |
| `nudge-manager.ts` | Manages nudge cooldowns and dedup. |
| `verification-judge.ts` | The verification judge — runs in background. |
| `verification-judge-state.ts` | Judge/calibration helpers. |
| `handler-registry.ts` | Thin orchestrator that wires all handlers. |
| `event-types.ts` | Types for events that flow through the enforcement layer. |
| `*-state.ts` | Sub-state files (tool-tracking, error-tracking, memory-hygiene, context-hygiene, scratchpad, thought-chain). Each owns its slice of the composed state. |

## Sub-directories

| Path | Purpose |
|---|---|
| `handlers/` | Event handlers — register-session-*, turn-*, message-*, tool-*. |

## State architecture (CRITICAL)

The state is **composed from focused sub-state files**, not defined in
`state.ts` directly. This is to avoid the file getting unwieldy and to
allow sub-state modules to be tested in isolation.

**Import contract:**
- `state.ts` imports sub-state factories/resets from sub-state files.
- Sub-state files do **NOT** import from `state.ts`.
- `enforcement-types.ts` is the only file imported by both `state.ts` and
  the sub-state files that need `EnforcementState` or `ENFORCEMENT_PARAMS`.
- The structural test in `test/runtime/lib/test-enforcement-deps.mjs`
  enforces this contract.

## Wake-up policy

- **`triggerTurn: true`**: enforcement-critical, tool-safety, turn-outcome,
  reasoning, metacognition, auto-singleton, auto-recovery, analytics-degrade,
  threshold-exhausted, emergency-rotation, navigation-checkout, context-80%+,
  three-memory-reliability, compaction-retry errors.
- **`triggerTurn: false`**: SOP suggestions, session-recall, memory hints,
  analysis handlers (BPE/MARS/Dreamer/Drift), insights/hints, transient-retry.

See individual handler files in `handlers/` for the per-source policy.
