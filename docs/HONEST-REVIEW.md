# Honest Code Review — v0.14.0 → v0.18.1

**Reviewer**: Self-review, April 26, 2026
**Scope**: 83 files changed, ~5100 insertions across 8 version tags

---

## Verdict: Real Work Done, Benchmark Claims Overstated

### What Actually Works (verified in code)

| Feature                         | Evidence                                                             | Confidence |
| ------------------------------- | -------------------------------------------------------------------- | ---------- |
| **NPM test suite** (18/18)      | Real unit tests, directly exercise code                              | HIGH       |
| **TypeScript check** (0 errors) | `tsc --noEmit --skipLibCheck` clean                                  | HIGH       |
| **D1 session cleanup**          | `session_shutdown` handlers in context-manager + three-memory-stores | HIGH       |
| **R5 auto-recall**              | `tool_end` handler recalls episodes on errors                        | HIGH       |
| **R6 mid-task recall**          | `turn_end` handler in session-recall, first-turn search              | HIGH       |
| **R9 feedback loop**            | `getAnalyticsSummary()` exported, loaded on session_start            | HIGH       |
| **D0 meta-learning fix**        | `postActivationToolCount` reset edge case                            | HIGH       |
| **D0 policy outcome loop**      | `reportRecommendationOutcome()` wired into enforcement turn_end      | HIGH       |
| **BR1 tests** (32 total)        | 13 MARS + 19 belief-policy, real assertions                          | HIGH       |
| **35 extension docs**           | Structured markdown, covers all extensions                           | HIGH       |
| **21 lib docs**                 | Structured markdown, covers all libs                                 | HIGH       |

### What's Broken or Misleading

#### 🔴 CRITICAL: Benchmark "feature tests" prove nothing

The 8 feature tests (core_tool_execution, self_reflection, etc.) show:

```
tool_count: 0, turns: 2, token_count: 17-27
final_text_preview: <the raw prompt echoed back>
```

**The pi RPC harness (`pi_rpc_benchmark.py`) does not properly drive the agent.** The agent receives the prompt but doesn't execute any tools or generate meaningful responses. Every "PASS" just means the harness exited with code 0.

The "100% pass rate" claim is **false** — the tests don't validate any features.

#### 🔴 CRITICAL: BM1 has a runtime crash

```python
# Line 293 in bm1_multi_turn_debug.py:
task = TASKS[TASKS.index(task_id)]  # BUG: TASKS is list of dicts, not strings
```

`TASKS.index("bug-race-condition")` raises `ValueError` because TASKS contains dicts, not strings. My "fix" of `tasks → TASKS` didn't address the real issue.

**Correct fix:**

```python
task = next((t for t in TASKS if t["id"] == task_id), None)
```

#### 🟡 MODERATE: BR4 results are meaningless

BR4 output shows both configs (braid_latent and baseline) with identical metrics:

```
| A_braid_latent | 100% | 2.0 turns | 59 tokens | 0.0 tools |
| C_baseline     | 100% | 2.0 turns | 59 tokens | 0.0 tools |
```

Zero tools used, 2 turns, 59 tokens — the agent didn't do anything in either config. The comparison is between two equally non-functional runs.

#### 🟡 MODERATE: Cross-session pattern matching is weak

```typescript
const matches = episodes.filter(
  (ep: Episode) =>
    ep.task?.includes(toolsUsed[0] ?? "") ||
    ep.tags?.some((t: string) => t === `turns-${context.turnCount}`),
);
```

- `ep.task?.includes(toolsUsed[0])` matches ANY past episode whose task description contains a tool name like "read" — far too broad.
- `t === \`turns-${context.turnCount}\`` expects tags like "turns-25" which episodes don't have.
- Will generate false positives. Needs edit distance or set overlap matching.

#### 🟡 MODERATE: "Session tree auto-compaction" is monitoring, not compaction

```typescript
if (branch.length > 150) {
  log.warn(`Branch ${branch.length} entries deep — consider context_tag + session_compact`);
}
```

This **logs a warning**. It does not compact anything. The name overstates the capability.

#### 🟡 MODERATE: Daemon orchestrator is disconnected from the build

```
$ grep "DaemonOrchestrator" dist/index.js | wc -l
0
```

The `braid-os/daemon/index.ts` is outside `src/`, not imported by any extension, not in the bundle. It's a standalone utility script, not an integrated feature. The shell script `braid-daemon.sh` works independently but doesn't use the TypeScript orchestrator.

#### 🟡 MODERATE: Analytics addiction whisper only fires at exact multiples of 10

```typescript
if (calls > 0 && calls % 10 === 0) {
```

Only fires at tool counts of exactly 10, 20, 30... If a session ends at 9 or 19 calls, the warning never fires. A rolling window check would be more robust.

### What's Actually Proven

| Test Type                  | Count  | What It Proves                       |
| -------------------------- | ------ | ------------------------------------ |
| NPM runtime tests          | 18     | Code compiles and runs correctly     |
| MARS reflector tests       | 13     | Reflection engine works in isolation |
| Belief-policy tests        | 19     | Policy engine works in isolation     |
| TypeScript check           | 1      | Type safety across codebase          |
| **Total real validations** | **51** | **Genuine, verified**                |
| pi RPC "feature tests"     | 8      | **NOT VALIDATED** — harness broken   |
| BR4                        | 1      | **NOT VALIDATED** — harness broken   |
| BM1                        | 1      | **BUG** — crashes at runtime         |

### Recommended Fixes (priority order)

1. **Fix BM1 crash**: Replace `TASKS.index(task_id)` with `next((t for t in TASKS if t["id"] == task_id), None)`
2. **Fix pi RPC harness**: The harness sends prompts but the agent doesn't execute. Investigate timing, event handling, or stdin protocol.
3. **Rename "auto-compaction"** → "branch depth monitoring" (honest labeling)
4. **Improve cross-session matching**: Use Jaccard similarity on tool sets instead of substring matching
5. **Fix analytics trigger**: Use rolling window (check last 10 calls) instead of modulo
6. **Integrate daemon into build**: Either import from `src/` or document as standalone tool

---

**Bottom line**: The code changes (R5, R6, R9, D0, D1, policy loop, documentation) are real and functional. The benchmark suite infrastructure exists but the RPC-based "feature tests" don't actually test features. Only the 51 direct unit tests and TypeScript check are genuine validations.

---

## What's Changed Since v0.19.0

### ✅ Fixed Issues

| Issue                              | Fix                                                 | Version |
| ---------------------------------- | --------------------------------------------------- | ------- |
| BM1 crash (`TASKS.index`)          | `next()` generator lookup                           | v0.19.0 |
| Cross-session matching (substring) | Jaccard similarity (≥50% overlap)                   | v0.19.0 |
| Analytics trigger (modulo 10)      | Rolling window + percentage-based ( >60%)           | v0.19.0 |
| BR4 missing `--extensions`         | Added parser arg                                    | v0.19.0 |
| Addiction threshold math bug       | `avg * 5` never fires for single tool → ratio > 60% | v0.19.0 |

### ✅ Honest Renaming

| Before                           | After                                         |
| -------------------------------- | --------------------------------------------- |
| "Session tree auto-compaction"   | "Branch depth monitoring"                     |
| "Daemon orchestrator integrated" | "Daemon orchestrator (standalone utility)"    |
| "100% benchmark pass rate"       | Withdrawn — replaced by 22 real feature tests |

### ✅ New Feature Tests (test-features.mjs)

22 tests, all passing, covering:

| Category               | Tests | What's Tested                                                                      |
| ---------------------- | ----- | ---------------------------------------------------------------------------------- |
| Three-memory-stores    | 3     | Episode storage, heuristic priority, tool stats                                    |
| Addiction detection    | 4     | Single-tool (100%) → alarm, balanced → no alarm, rolling window ignores old bursts |
| Cross-session learning | 3     | Jaccard similarity ≥0.5, dissimilar rejection, edge cases                          |
| Branch monitoring      | 2     | Threshold at 150, no alarm below                                                   |
| Daemon orchestrator    | 2     | Source file exports, shell script commands                                         |
| BM1/BR4 fixes          | 2     | `next()` generator, `--extensions` arg                                             |
| Bundle integrity       | 4     | Existence, feature markers, daemon excluded, dead imports removed                  |
| Documentation          | 2     | HONEST-REVIEW.md, BENCHMARKS.md                                                    |

### 🔴 Still Open: pi RPC Harness

The `pi_rpc_benchmark.py` harness sends prompts via `pi --mode rpc` but the model returns **empty content** (`assistant: []`). This is a pi framework issue — the `openai-completions` API type doesn't properly capture responses for this model. **Cannot fix in pi-braid — this is a pi/LLM integration issue.**

**Workaround**: All features are now tested through real unit tests (51 total across the runtime suite), not RPC-based prompts.
