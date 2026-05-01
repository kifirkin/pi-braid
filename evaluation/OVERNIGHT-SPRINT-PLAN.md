# Overnight Sprint Plan — 2026-05-01

## Phase 1: Code Changes (Sequential — dependencies matter)

### Task 1: BR3 Runtime Nudge Suppression Tracking
**File**: `src/extensions/heartbeat/analytics/index.ts`
**What**: Track per-variant nudge counts (how many nudges were suppressed vs sent) and compare effectiveness
**Why**: Currently only tracks session outcomes per variant, not whether nudges actually changed behavior
**Approach**: 
- Add `nudgesSent` and `nudgesSuppressed` counters to AnalyticsState
- Increment in enforcement turn_end when nudges fire / are suppressed
- Expose via `formatABResults()` — show nudge count delta between control and no_nudges
- Add unit test in test-ab-measurement.mjs

### Task 2: D0 Dreamer activate() Integration Test
**File**: `test/runtime/test-dreamer.mjs` (update existing)
**What**: Test the full activate() path with a real ctx object, not just shouldActivate()
**Why**: Current test only covers shouldActivate() logic, not the actual activation + episode creation
**Approach**:
- Build a mock ctx with getExtensionState, whisper, etc.
- Call activate() with sufficient tool history
- Verify episode was created via three-memory-stores
- Verify whisper was called with dreamer insights

### Task 3: BM1 Refinement
**File**: `evaluation/bm1-sdk.mjs`
**What**: Better tasks, better scoring, more reliable execution
**Why**: Current BM1 has only 3 simplistic tasks; edit-fail is impossible (can't comment JSON)
**Approach**:
- Replace edit-fail with a realistic debugging task (e.g., fix a broken import)
- Add 2 more multi-turn debugging tasks
- Improve scoring to check actual tool call sequences, not just text mentions
- Add retry logic for API timeouts

### Task 4: BM2 Code Quality Benchmark
**File**: `evaluation/bm2-sdk.mjs` (new, SDK version)
**What**: Assess code quality beyond pass/fail — eslint score, complexity, edge cases
**Why**: Only exists as Python script; needs SDK version for consistency
**Approach**:
- Create SDK harness that asks agent to write code, then evaluates it
- Metrics: eslint score, cyclomatic complexity, edge case coverage
- Use stepfun model for generation, evaluate with eslint + custom checks

### Task 5: PB4 Compliance Behavior Measurement
**File**: `evaluation/pb4-sdk.mjs` (new)
**What**: Measure whether enforcement/identity framing changes compliance behavior patterns
**Why**: No measurement of compliance behaviors exists; BR4 checks this but PB4 is the dedicated benchmark
**Approach**:
- Run agent on standardized tasks with and without pi-braid
- Count compliance patterns: excessive_verification, over_confirmation, rule_anchoring, defensive
- Compare baseline vs pi-braid compliance scores
- Output: compliance behavior delta table

## Phase 2: Build & Test Validation
- `npm run typecheck` — 0 errors
- `npm run test` — 33/33 pass
- `npm run build` — clean

## Phase 3: Benchmark Execution (Parallel via tmux)

### Model Configuration
- **Primary**: `stepfun/step-3.5-flash` (via pi-poorman-providers) — fast, 256k ctx, free
- **Secondary**: `stepfun/step-3.5-flash-2603` — 65k max tokens, newer
- **OpenRouter**: `qwen/qwen3-coder:free` (262k ctx), `nvidia/nemotron-3-super-120b-a12b:free` (262k ctx)
- **OpenRouter fast**: `z-ai/glm-4.5-air:free` (131k ctx), `openai/gpt-oss-120b:free` (131k ctx)

### Benchmark Runs
1. **BR1**: `node evaluation/br1-sdk.mjs` — 5 trap tasks, stepfun
2. **BR4**: `node evaluation/br4-sdk.mjs --trials 3` — latent vs baseline
3. **BM1**: `node evaluation/bm1-sdk.mjs` — 5 debugging tasks
4. **BM2**: `node evaluation/bm2-sdk.mjs` — code quality
5. **PB4**: `node evaluation/pb4-sdk.mjs` — compliance measurement
6. **Overnight**: `python3 evaluation/overnight_test.py` — continuous loop

### Execution Strategy
- Run BR1, BR4, BM1, BM2, PB4 sequentially in one tmux session (code tasks first)
- Launch overnight_test.py in parallel tmux session
- Save all results to `evaluation/results/`
- Aggregate results into `evaluation/results/sprint-summary.md`

## Phase 4: Results Aggregation
- Parse all result files
- Generate comparison tables
- Update WHAT-IS-MISSING.md with new statuses
- Commit all changes

## Rollback Plan
- All changes are in separate files or additive
- If build breaks, revert to `git stash` checkpoint
- Benchmarks are read-only (don't modify source)
