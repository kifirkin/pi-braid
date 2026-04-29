# ROADMAP-v0.6 Expert Review

**Reviewer**: Research synthesis  
**Date**: 2026-04-19  
**Roadmap**: `ROADMAP-v0.6.md`  
**Verdict**: **STRUCTURALLY SOUND — 3 CRITICAL GAPS**

---

## Overall Assessment

The roadmap is well-engineered. Clear dependency graph, concrete implementation details, conservative thresholds, incremental migration strategy. This is how roadmaps should be written.

**However**, it has three critical gaps:

1. **Missing: Topic Drift Detection** (our latest research)
2. **Missing: Connection to research threads** (the 23 papers we just catalogued)
3. **Weak: Task 3 is underspecified** (EvidencePool is the hardest part, gets 3-4 hours)

---

## Critical Gap 1: Topic Drift Detection Missing

**Source**: `docs/PROPOSAL_TOPIC_DRIFT_DETECTOR.md` (created today)

The roadmap has no mechanism to detect when the agent drifts off-topic before producing confident wrong output. The "braid paper" failure mode — fluent but completely irrelevant output — is not addressed.

**What Task 3 (Conflict QA) doesn't cover**:  
Conflict QA is about _conflicting evidence from multiple sources_. Topic drift is about _output topic diverging from request topic_. These are orthogonal problems.

**Add Task 8**: Topic Drift Detector

```
Effort: Small (1 hour)
Priority: HIGH — prevents confident wrong output
Depends on: Nothing

Implementation: ~30 lines
- Maintain topic anchors from user request
- Measure token overlap on message_end
- If overlap < 0.5 → signal drift

Whisper format (no stakes):
"Your response seems to cover different ground than the request."
```

---

## Critical Gap 2: Research Threads Not Referenced

The roadmap has no connection to the 23 papers we researched. This is a missed opportunity for:

1. **Citations**: Tasks 2-7 could cite the research
2. **Architectural guidance**: The Heartbeat Scheduler (2604.14178) directly informs Task 6 (MARS)
3. **Metric thresholds**: Cross-Query Contradictions (2604.14525) informs Task 5 calibration

**Recommendation**: Add a "Research Basis" column to each task.

| Task   | Research Thread     | Paper                  | Key Insight                          |
| ------ | ------------------- | ---------------------- | ------------------------------------ |
| Task 2 | cognitive-control   | 2604.14401 Credo       | Belief-based state                   |
| Task 3 | knowledge-conflicts | 2604.11209 XoT         | Source tracking + faithful reasoning |
| Task 5 | measurement         | 2604.14525 Cross-Query | Threshold calibration                |
| Task 6 | cognitive-control   | 2604.14178 Heartbeat   | Proactive scheduling                 |

---

## Critical Gap 3: Task 3 (Conflict QA) is Underestimated

**The problem**: EvidencePool is the most complex task in the roadmap, but it gets 3-4 hours — the same as Task 2 which is purely a refactor.

**Why it's hard**:

1. **Conflict detection requires entity extraction** — "X is true" vs "X is false" needs NLP, not just token overlap
2. **Source attribution is non-trivial** — the agent doesn't naturally label its sources
3. **Resolution is LLM-heavy** — "pick the right source" requires judgment

**Evidence**: Our RESEARCH_CONFLICT_QA.md says the paper found models are "sensitive to prompting choices" — meaning the conflict detection itself may be biased by how we ask.

**Recommendations**:

1. **Split Task 3 into Task 3a + 3b**:

```
Task 3a: Source Tracking (Medium, 2 hours)
- Add source labels to evidence entries
- Track: memory, web, code, docs, parametric
- No conflict detection yet

Task 3b: Conflict Detection (Large, 3+ hours)
- Entity extraction for claim normalization
- Conflict set grouping
- Conservative thresholds (only flag 3+ source conflicts)
```

2. **Reduce Task 3 scope**: Start with "acknowledge uncertainty" whispers, not "resolve conflicts". Don't try to pick the right source — just flag when sources disagree.

3. **Add verification complexity**: Task 3 needs integration tests with real conflicting sources. This is harder to test than unit tests.

---

## What's Missing from Execution Order

The dependency graph shows Tasks 5 and 6 as independent, but:

```
Task 5 (Metrics Calibration) ──▶ Task 6 (MARS)
         │                              │
         │  Metrics provide input        │ Pattern analysis
         │  to reflection                │ uses metrics
         └──────────────────────────────┘
```

**Recommendation**: Run Task 5 before Task 6, or integrate calibration into MARS.

---

## Task-Specific Reviews

### Task 1: Preprocessor Fix ✅

**Verdict**: Well-scoped, trivial implementation, clear verification. Do first.

### Task 2: Session State Refactor ⚠️

**Verdict**: Good strategy. One concern: enforcement/event handlers need `ctx` propagation through ALL tools, not just the enforcement tools.

- **Verification**: Test with `codebase-tree` tool — does it get `ctx`? If not, state migration needs to handle that case.
- **Missing**: The `getExtensionState` pattern assumes `ExtensionContext` is stable. If pi recreates context per turn, state won't persist. Check this.

### Task 3: Conflict QA ❌

**Verdict**: Underestimated, underspecified. See Critical Gap 3 above.

### Task 4: Think v2 ⚠️

**Verdict**: Good incremental additions. One concern:

- **Enforcement nudges in think tool**: Adding nudge logic to think tool couples them. Consider: enforce in enforcement's `turn_end`, not in think tool.
- **Calibration tracking**: "confidence: 0.9, then succeeded" is noisy — confidence is about the REASONING, not the outcome. A high-confidence wrong reasoning can still succeed by accident.

### Task 5: Metrics Calibration ✅

**Verdict**: Right approach. Start conservative, tune from real data.

- **Add**: Track false positive rate, not just threshold accuracy
- **Add**: "Warn-only" mode by default — don't whisper, just log

### Task 6: MARS Reflection ⚠️

**Verdict**: Good concept, underspecified trigger.

- **Every 15 turns is arbitrary**: Use Heartbeat Scheduler concept (2604.14178) — adaptive intervals based on pattern changes
- **Advice generation**: The advice rules are too simple. "Use grep instead of bash" is noise if bash is appropriate for the task.
- **Consider**: Only whisper on _actionable_ patterns, not _statistical_ ones.

### Task 7: Hypothesis Scoring ⚠️

**Verdict**: Simple heuristic is fine for now.

- **Risk**: Heuristic scoring may not correlate with actual likelihood
- **Add**: Track scoring accuracy over time — did higher-scored hypotheses actually turn out to be correct?

---

## Structural Improvements

### 1. Add Success Criteria Column

Each task needs measurable completion criteria:

| Task   | Current Criteria   | Missing                         |
| ------ | ------------------ | ------------------------------- |
| Task 1 | Type check passes  | Runtime verification            |
| Task 2 | Tests pass         | Multi-session isolation test    |
| Task 3 | Unit tests         | Integration with real conflicts |
| Task 4 | Nudge fires        | Verify it changes behavior      |
| Task 5 | No false positives | Track false positive rate       |
| Task 6 | Advice generated   | Verify advice is actionable     |
| Task 7 | Higher scores      | Track accuracy correlation      |

### 2. Add Risk Rating

Current risks are good but need severity ratings:

| Task   | Technical Risk             | Research Risk      | Schedule Risk |
| ------ | -------------------------- | ------------------ | ------------- |
| Task 2 | High (ctx propagation)     | Low                | Medium        |
| Task 3 | Very High (NLP complexity) | High (XoT is hard) | High          |
| Task 6 | Medium (arbitrary trigger) | Medium             | Low           |

### 3. Add Research Thread Column

| Task   | Thread              | Papers                 |
| ------ | ------------------- | ---------------------- |
| Task 2 | cognitive-control   | 2604.14401 Credo       |
| Task 3 | knowledge-conflicts | 2604.11209 XoT         |
| Task 5 | measurement         | 2604.14525 Cross-Query |
| Task 6 | cognitive-control   | 2604.14178 Heartbeat   |

---

## What to Keep (Strengths)

1. **Dependency graph is correct** — tasks build on each other properly
2. **Incremental migration in Task 2** — smart approach, reduces risk
3. **Conservative thresholds** — right default, tune from data
4. **Effort estimates are reasonable** — except Task 3

---

## Summary of Changes

| Priority | Change                                       | Rationale                           |
| -------- | -------------------------------------------- | ----------------------------------- |
| P0       | Add Task 8: Topic Drift Detection            | Addresses braid paper failure mode  |
| P0       | Split Task 3 into 3a + 3b                    | Underestimated complexity           |
| P1       | Add Research Thread column                   | Connects roadmap to research        |
| P1       | Task 2: Verify ctx in ALL tools              | State migration depends on this     |
| P2       | Task 6: Adaptive trigger, not fixed 15 turns | Use heartbeat concept               |
| P2       | Task 5: Track false positive rate            | More useful than threshold accuracy |
| P3       | Task 4: Decouple enforcement from think      | Coupling is fragile                 |

---

## Final Verdict

**Proceed with Tasks 1, 2, 4, 5, 7.**  
**Revise Task 3 before starting.**  
**Add Task 8 (Topic Drift).**  
**Connect all tasks to research threads.**
