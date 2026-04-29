# BRAID WORK ITEM TRACKER

**Created**: 2026-04-22 | **Updated**: 2026-04-22 (Session 14) | **Agent**: Braid | **Items**: 24 | **Status**: Active

---

## How to Use

- **Status**: ✅ Done | 🟡 In Progress | ❌ Not Started
- **Effort**: XS (<15min) | S (1h) | M (2-4h) | L (4-8h)
- **Track**: D=Archive Recovery | R=System | H=Health | BR=Behavior | BM=Benchmark

---

## PHASE 1: Critical Path 🔴

| #   | Item                                                                       | Track | Status         | Effort | Depends | Notes                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ----- | -------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | **[D0.1]** Unarchive daemon-orchestrator docs                              | D     | ✅ Done        | XS     | —       |                                                                                                                             |
| 2   | **[D0.2]** Implement belief store (BeliefStore + PolicyEngine)             | D     | ✅ Done        | M      | D0.1    | `src/lib/belief-store.ts`                                                                                                   |
| 3   | **[D0.3]** Wire belief-store into heartbeat-scheduler                      | D     | ✅ Done        | M      | D0.2    | PolicyEngine.evaluate() wired to heartbeat tick                                                                             |
| 4   | **[D0.4]** Implement dreamer module in heartbeat-scheduler                 | D     | ✅ Done        | S      | D0.3    | Generates self-reflection episodes                                                                                          |
| 5   | **[D0.5]** Meta-learning: optimizer adjusts tick interval                  | D     | ❌             | M      | D0.4    | Tracked, not optimized                                                                                                      |
| 6   | **[R5]** Wire three-memory into agent loop                                 | R     | ✅ Done        | M      | —       | Three-memory in recaller; RUMS retrieval                                                                                    |
| 7   | **[D1]** Session isolation: enforcement singletons + session_end cleanup   | D     | ✅ Done        | M      | —       | session_shutdown handler added                                                                                              |
| 8   | **[BR1]** Self-reflection: proactive vs reactive patterns (Mode Awareness) | BR    | 🟡 In Progress | M      | R5      | System prompt updated: MODE_AWARENESS + DELIVERABLE_HYGIENE + SELF_REFLECTION_GUIDANCE + PROACTIVE_CHECKS in prompt-builder |
| 9   | **[BR4]** Latent activator multi-turn test                                 | BR    | ❌             | L      | R5      |                                                                                                                             |
| 10  | **[BM1]** Multi-turn debugging benchmark                                   | BM    | ❌             | L      | R5      |                                                                                                                             |

---

## PHASE 2: High Value 🟡

| #   | Item                                                      | Track | Status | Effort | Depends | Notes                        |
| --- | --------------------------------------------------------- | ----- | ------ | ------ | ------- | ---------------------------- |
| 11  | **[D2]** Async migration: preprocessor, guardian, repl    | D     | ❌     | M      | —       | ~30% sync calls remain       |
| 12  | **[D5]** Evidence pool: source labels + faithful conflict | D     | ❌     | M      | —       |                              |
| 13  | **[R6]** Session recall mid-task                          | R     | ❌     | M      | D0.2    | Rotation-triggered only      |
| 14  | **[R8]** Planner vs metacognition conflict                | R     | ❌     | S      | —       | Two planning systems         |
| 15  | **[R9]** Analytics wiring                                 | R     | ❌     | L      | —       | No metrics export            |
| 16  | **[H6]** Error-capture completeness                       | H     | ❌     | S      | —       | Missing subprocess errors    |
| 17  | **[BR2]** Tool addiction measurement                      | BR    | ❌     | L      | R9      |                              |
| 18  | **[BR3]** Nudge effectiveness experiment                  | BR    | ❌     | M      | R9      |                              |
| 19  | **[BM2]** Code quality benchmark                          | BM    | ❌     | M      | —       | Pass rate ignores robustness |
| 20  | **[BM3]** Real-world task suite                           | BM    | ❌     | L      | BM1     |                              |

---

## PHASE 3: Cleanup 🟢

| #   | Item                                             | Track | Status  | Effort | Notes                                      |
| --- | ------------------------------------------------ | ----- | ------- | ------ | ------------------------------------------ |
| 21  | **[H5]** Polyfill cleanup                        | H     | ❌      | S      | 4 intentional casts, global pollution risk |
| 22  | **[H7]** Verify cognitive-systems integrated     | H     | ✅ Done | XS     | Functional, not stub                       |
| 23  | **[H8]** Document all extensions                 | H     | ❌      | S      |                                            |
| 24  | **[H9]** Update README with architecture diagram | H     | ❌      | S      |                                            |

---

## DEPENDENCY GRAPH

```
D0.1 → D0.2 → D0.3 → D0.4 → D0.5
                          ↓
D0.2 + R5 → R5 → BR1, BR4, BM1
R9 → BR2, BR3
BM1 → BM3
```

---

## PROGRESS LOG

| Date       | Item      | Action        | Result                                                                                               |
| ---------- | --------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| 2026-04-22 | H7        | Verified      | cognitive-systems functional, heartbeat-scheduler functional                                         |
| 2026-04-22 | D0.1-D0.3 | Implemented   | belief-store.ts + heartbeat integration                                                              |
| 2026-04-22 | BR1       | System prompt | MODE_AWARENESS + DELIVERABLE_HYGIENE + SELF_REFLECTION_GUIDANCE + PROACTIVE_CHECKS in prompt-builder |
| 2026-04-22 | R5, D1    | Done          | Three-memory wired, session isolation fixed                                                          |
| 2026-04-22 | D0.4      | Done          | Dreamer module in heartbeat-scheduler                                                                |

---

## KEY INSIGHT FROM BR1 ANALYSIS

The self-reflection failure (4 docs instead of 1) had 3 root causes, all fixed in system prompt:

1. **Wrong mode**: Production vs Analysis not distinguished → `MODE_AWARENESS` section
2. **No real-time check**: No pre-action pause → `PROACTIVE_CHECKS` + `DELIVERABLE_HYGIENE`
3. **Reactive reflection**: Explains but doesn't prevent → `SELF_REFLECTION_GUIDANCE` (prevention > explanation)

---

_Next agent: `npx tsc --noEmit` before starting new item. BR1 system prompt changes are live._
