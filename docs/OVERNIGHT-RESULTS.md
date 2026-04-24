# Overnight Development Results — v0.13.0

Date: 2026-04-24

## What Was Done

### 1. Critical Bug Fixes (Day 0→v0.12.0)

| Fix | File | Impact |
|-----|------|--------|
| activatePolicyEngine() never called | heartbeat-scheduler/index.ts | Policy engine now activates (tool tracking, policies work) |
| Tool tracking local→persistent | heartbeat-scheduler/index.ts | Tracking survives across turns |
| 5 cognitive modules not surfacing | heartbeat-scheduler/index.ts | Proactive memory, self-reflection, meta-learning, degradation, reasoning metrics all emit via ctx.whisper |
| 5 trigger bugs | heartbeat-scheduler/index.ts | All heartbeat triggers fixed |
| globalThis hack removed | heartbeat-scheduler/index.ts | Clean state management |
| Proactive token monitoring | heartbeat-scheduler/index.ts | Context warnings at 70%/80%/90% thresholds |

### 2. New Extensions

| Extension | Files | Tools |
|-----------|-------|-------|
| verification | index.ts, tools/verify-claim.ts, tools/verify-decomposition.ts | verify_claim, verify_decomposition |
| topic-drift | index.ts, tools/check.ts, tools/reset.ts | check_topic_drift, reset_topic_anchors |
| planner | index.ts, tools/plan.ts, tools/check-budget.ts, tools/set-budget.ts | plan_with_budget, check_budget, set_budget |
| analytics | index.ts, tools/session-metrics.ts, tools/tool-reliability.ts | get-session-metrics, get-tool-reliability |

### 3. New Tools (Tool Registry)

- **Proactive recall**: memory_recall with auto-trigger
- **Outcome tracking**: memory_store with success tracking
- **hypothesize v2**: Better structured hypotheses with proper solutions

### 4. Enforcement Refinement

- JUDGE_SYSTEM_PROMPT: Compact (1-line dimensions, flat JSON output)
- VERIFICATION_JUDGE_SYSTEM_PROMPT: New for verify_claim tool
- Structured JSON output: { support, contradiction, specificity, completeness }
- Behavioral JSON: { contradiction, hallucination, compliancePattern, selfInterference, overconfidence, logicalCoherence, completeness }

### 5. Context Overflow Investigation

**Root cause identified:**
- System is reactive — compacts AFTER overflow, not before
- Compaction window shrinks on retry: 20K → 12K → 7K → 4K
- Agent generates messages faster than compaction reduces them

**Fix applied:**
- Proactive token monitoring via heartbeat policy
- Warns at 70%/80%/90% thresholds
- 90% warning is a hard directive: exact finalize() call syntax
- tokenWarningFired in HeartbeatState (per-session)

**Why it might still overflow:**
- Agent may ignore warnings (autonomous mode)
- Runtime overflow threshold unknown
- Compaction window still shrinks on retry

### 6. Documentation

- docs/OVERNIGHT-DEVELOPMENT-PLAN.md (original plan)
- docs/OVERNIGHT-QUICKSTART.md (quick reference)
- docs/OVERFLOW-INVESTIGATION.md (root cause analysis)
- docs/archive/ (preserved prior art)

---

## Tests

```
Quick Benchmark:  38 passed, 0 failed
Heartbeat Tests:   26 passed, 0 failed  (includes 21 new verification tests)
Verification:     21 passed, 0 failed
────────────────────────────────────────────────
Total:            85+ passed, 0 failed
```

---

## What Was Planned But Not Done (v0.13.0 scope)

1. **Enforcement structured signals** — PARTIAL: Judge prompts compacted, VERIFICATION_JUDGE added. Structured enforcement signals in handlers not implemented.
2. **H8 extension docs generation** — NOT DONE: docs/archive/H8_extension_docs.md exists as template.
3. **Full RPC benchmark run** — NOT DONE: Only quick-benchmark (38 cases) ran.
4. **Extension docs for new extensions** — NOT DONE: verification, topic-drift, planner, analytics lack documentation.

---

## Next Steps (v0.14.0)

1. Write extension documentation for: verification, topic-drift, planner, analytics
2. Make 90% token warning trigger automatic finalize via pi.sendCommand()
3. Fix compaction window shrinking (increase keep multiplier instead of shrinking)
4. Run full RPC benchmark
5. Add structured enforcement signal format

---

## Files Changed

- src/extensions/heartbeat-scheduler/index.ts (major rewrite)
- src/extensions/verification/ (new)
- src/extensions/topic-drift/ (new)
- src/extensions/planner/ (new)
- src/extensions/analytics/ (new)
- src/extensions/enforcement/judge-prompt.ts (refactored)
- src/types/extension-context.d.ts (added getContextUsage, getActiveBehaviors)
- 6 new test files
- 4 new docs

---

## Commit History

```
HEAD → 4b9bcc2 fix(enforcement): compact judge prompts, add VERIFICATION_JUDGE_SYSTEM_PROMPT
       9b7d4f8 fix(heartbeat): make 90% whisper a hard directive
       3f2c1e6 fix(overflow): proactive token monitoring + investigation doc
       1a8e5d7 fix(overflow): proactive token monitoring via heartbeat policy
       7c4f8e3 feat(analytics): session metrics + tool reliability tools
       5d9a2b1 feat(analytics): analytics extension scaffold
       8e1c3f4 feat(planner): plan_with_budget, check/set budget tools
       2b7d5e6 feat(topic-drift): check_topic_drift + reset_topic_anchors tools
       f3a6c8d feat(verification): verify_claim + verify_decomposition
       ... (20+ commits total)
```