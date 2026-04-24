# Extension: enforcement

**Status**: ✅ Working
**Tests**: 17 enforcement tests (v0.13.0)
**Version**: v0.13.0

## Purpose

Smart nudge delivery with semantic interrupts. Delivers hints/warnings/feedback to the agent without flooding it. Three-tier signal architecture.

## Signal Architecture (L1-L3)

| Tier | Type | Delivery | Example |
|------|------|----------|---------|
| L1 | Internal | State only (no message) | Tool usage tracking, context hygiene |
| L2 | Structured hints | Session Signals nudge/turn | Redundancy, verification hints |
| L3 | Critical | Individual semantic message | Overflow failures, infrastructure errors |

**Key rule**: Agent gets ONE [auto] message per turn max for non-critical signals. Critical signals (L3) get individual messages.

## Modules

| Module | Purpose |
|--------|---------|
| `detection/malformed.ts` | Detect malformed tool calls |
| `detection/verification.ts` | Detect missing verification |
| `handlers/blocking.ts` | Block dangerous commands |
| `handlers/tool-tracker.ts` | Track bash commands, tool inputs |
| `handlers/message-analysis.ts` | Analyze message structure |
| `handlers/turn-analysis.ts` | Detect redundancy, critical signals, orphan chains |
| `handlers/orphan-chains.ts` | Detect orphan tool call chains |
| `handlers/routing-handler.ts` | Detect intent, routing mismatches |
| `judge.ts` | Core judge analysis logic |
| `nudge-manager.ts` | Nudge frequency management |
| `verification-judge.ts` | Verification-focused judge |
| `whisper.ts` | Whisper queue and delivery |
| `validation.ts` | Turn and tool validation |
| `state.ts` | Extension state |
| `types.ts` | Shared types |

## Events Handled (11)

| Event | Handler |
|-------|---------|
| `tool_execution_start` | Tool input tracking |
| `tool_execution_end` | Result analysis, blocking check |
| `before_agent_start` | Belief store init |
| `agent_end` | Turn analysis, evidence processing |
| `context_compact_start` | Pre-compaction evidence flush |
| `context_compact_end` | Post-compaction re-registration |
| `context_prune` | Pruning evidence flush |
| `before_tool_execution` | Blocking check, malformed detection |
| `before_tree` | Before-tree belief update |
| `message_end` | Redundancy detection |
| `session_shutdown` | Cleanup |

## Key Features

- **Evidence pool integration**: Conflicts from code/command changes tracked via `addEvidence`
- **Conflict QA**: Uses `conflict-qa` lib for structured conflict resolution questions
- **Belief policy engine**: Emits structured enforcement signals via `emitSignal`
- **MARS reflector**: Uses `mars-reflector` for multi-anchor reflection signals
- **Error classification**: Uses `error-classifier` lib for error categorization
- **Nudge manager**: Prevents nudge fatigue by tracking nudge frequency per category
- **Verification judge**: Specialized judge for missing verification detection
- **Language hints**: Supports multilingual agents with `language-hint.ts` lib

## State

`enforcement` state (`getState()`):
```typescript
{
  signalsThisTurn: number,
  lastRedundancyWarning: number | null,
  pendingBlockAction: BlockAction | null,
  pendingWhispers: Whisper[],
  blockedTurn: boolean,
  // ... see state.ts
}
```

## Tools

No tools registered directly — enforces via events and signal emission.
