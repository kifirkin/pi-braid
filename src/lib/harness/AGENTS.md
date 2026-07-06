<!-- status: current -->

# Self-Harness Loop (LP-1) — src/lib/harness/

## Purpose

Phase 1 of the Self-Harness Loop: automated failure collection and weakness
mining. Inspired by the Self-Harness paper (2606.09498, 53-60% relative
improvement on held-out tasks) and Opik's trace→test-suite pipeline.

## Modules

| File | Role |
|------|------|
| `types.ts` | Shared types: `FailureSignature`, `WeaknessCluster`, `HarnessState` |
| `failure-trace-collector.ts` | Passive observer: reads failure signatures from existing detectors |
| `weakness-miner.ts` | Pure clustering: groups similar signatures, outputs actionable clusters |
| `index.ts` | Public API — Phase 1-2 |
| `harness-proposer.ts` | Phase 2: generates candidate edits from weakness clusters using utility model |

## Data Flow

```
Event Sources (tool-loop-detector, error-tracking, turn-outcome)
    │
    ▼ (via heartbeat module, turn-end handler)
FailureTraceCollector (reads existing state, produces FailureSignature[])
    │
    ▼ (every ~30 turns, via heartbeat cognitive module)
WeaknessMiner (pure function, produces WeaknessCluster[])
    │
    ├──► Whisper (agent-visible summary via summarizeClusters)
    │
    ├──► Harness Proposer (Phase 2): generates K=3 candidate edits per actionable cluster
    │     via utility model in proposer role. Stored in HarnessState.proposals[].
    │     Runs in evolver heartbeat, 1 cluster per tick (latency bounded).
    │
    └──► Stored in HarnessState for Proposal Validation (Phase 3)
```

## Failure Sources

| Source | Type | How Collected |
|--------|------|---------------|
| `tool-loop-detector` | `tool-loop` | Reads `ToolLoopState`, calls `detectToolLoop()` |
| `error-tracking-state` | `error-burst` | Reads `enforcement` extension state, checks `consecutiveErrorTurns >= 3` |
| `error-tracking-state` | `validation-failure` | Reads `validationFailures` count |
| (future) turn-outcome | `turn-failure` | Reads turn-outcome classification |
| (future) degradation-detector | `degradation` | Reads degradation state |

## Clustering Strategy

1. Group by `type` (tool-loop, error-burst, etc.)
2. Within same type, group by `toolName` or `errorPrefix`
3. Minimum cluster size: 3 signatures
4. Severity computed from: frequency (0.4) + avg count (0.3) + recency (0.3)
5. Clusters sorted by severity descending

## Wire Points

- **Heartbeat evolver module**: calls `collectAllFailureSignatures()` then
  `mineWeaknesses()` on activation, surfaces via `whisper()`. For actionable
  clusters without proposals, calls `generateAllPendingProposals()` (max 1 per
  tick to keep latency bounded).
- **Future**: Turn-end handler can trigger on-demand collection or proposal
  generation for higher-priority clusters.

## Verification

- `npm run typecheck` passes
- `npm test` passes
- Unit tests in `test/` (TBD) verify clustering logic with fixture data
- Unit tests for proposer (TBD) verify response parsing with fixture LLM output