# Proposal: Bidirectional Verifier Extension for pi-braid

**Based on**: AgentV-RL (2604.16004) + HWE-Bench failure mode analysis

## Problem

pi-braid currently has no mechanism to verify that:

1. The artifact selected is the **root cause** (not symptom)
2. The fix semantically addresses the problem
3. The fix **propagates** to all derived/generated files

This is the HWE-Bench Coordination Failure — the agent fixes RTL but misses the generated file that depends on it. Invisible in benchmarks because the benchmark only checks the final output, not the artifact selection process.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ D5: EPISTEMIC VERIFIER                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Forward Trace                                         │   │
│  │ "intent + problem → which files should I touch?"     │   │
│  │ Trace: symptom → possible causes → candidate files   │   │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Artifact Validator                                    │   │
│  │ "Is the selected file the ROOT CAUSE or symptom?"    │   │
│  │ Check: Is this file actually read by the failing     │   │
│  │        test/path? Is this the leaf or an intermediary?│  │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Backward Check                                        │   │
│  │ "Does this fix actually address the root cause?"      │   │
│  │ Trace backward: fix → expected behavior change →      │   │
│  │                 does this propagate to the symptom?   │   │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Coordination Checker                                  │   │
│  │ "Are all derived files updated?"                      │   │
│  │ Trace: for each file touching the fix, what else     │   │
│  │        depends on it? (generated files, configs)      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Forward Trace (2h)

- Wire into heartbeat scheduler
- On each tool call, trace: `problem → what files are relevant?`
- Track "touch graph" — which files does the agent touch vs. which should be touched
- If agent touches a file that is NOT in the relevant set, flag as localization risk

### Phase 2: Artifact Validator (2h)

- Before editing, prompt a check: "Is this the root cause file or a symptom file?"
- Use a lightweight model call (`getJudgeModel()`) to validate artifact selection
- If mismatch: surface the discrepancy to the agent ("You edited X but the error originates in Y")

### Phase 3: Backward Checker (2h)

- After a fix is applied, trace backward: "Does this fix change behavior at the symptom?"
- Check: The test that was failing — does the fix address it semantically?
- Use cross-validation: apply fix mentally, trace to expected outcome

### Phase 4: Coordination Checker (1h)

- Track "derived-from" relationships in belief store
- After fix: "What files are derived from the changed file?"
- If derived file not updated, flag as coordination risk

## Wire into Existing Infrastructure

| Component                | Uses                                      | Status     |
| ------------------------ | ----------------------------------------- | ---------- |
| Belief store (D0)        | Track touch-graph + derived-from          | Unwired    |
| Heartbeat scheduler      | Trigger forward trace on each step        | R5 partial |
| Three-memory recall (R5) | Retrieve similar past localization errors | Unwired    |
| Meta-cognition extension | Self-diagnose reasoning path              | Partial    |

## Outcome Metrics

- **Localization accuracy**: % of tool calls targeting root-cause file vs. symptom file
- **Coordination completeness**: % of fixes that propagate to all derived files
- **End-to-end task success**: Benchmark score improvement

## Status

**Phase 1 DONE** (`src/lib/bidirectional-verifier.ts`) — Forward Trace: file touch graph + localization risk detection. Wired into enforcement input/tool_call/turn_end handlers.

**Phases 2-4 pending** — Artifact Validator (judge model), Backward Checker (semantic validation), Coordination Checker (derived file tracking). See DOC-AUDIT.md for integration details.

## References

- AgentV-RL (2604.16004): Bidirectional reward modeling
- HWE-Bench (2604.14709): 3 failure modes analysis
- PRISM-MCTS (2604.05424): Process reward model with shared memory
