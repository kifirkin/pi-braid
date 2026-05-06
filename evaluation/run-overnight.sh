#!/usr/bin/env bash
# pi-braid Autonomous Overnight Runner v2
#
# Runs in background (nohup) or foreground.
# Sequence:
#   1. Compaction stress test (verifies the fix)
#   2. Full benchmark suite (BM1 braid+naked, BM2 braid+naked, BR1 braid)
#   3. Consolidation test (long session with SOP suggestion)
#   4. Generate report
#
# Usage:
#   bash evaluation/run-overnight.sh              # foreground
#   nohup bash evaluation/run-overnight.sh &      # background
#
# Environment:
#   PI_MODEL=step-3.5-flash PI_PROVIDER=stepfun

set -e

ROOT="/Users/kifir/projects/agents/pi-braid"
RESULTS="$ROOT/evaluation/results"
TS=$(date +%Y%m%d_%H%M%S)
LOG="$RESULTS/overnight-v2_$TS.log"

mkdir -p "$RESULTS"

echo "=== pi-braid Autonomous Overnight Runner v2 ===" | tee -a "$LOG"
echo "Started: $(date)" | tee -a "$LOG"
echo "Model: ${PI_MODEL:-step-3.5-flash}" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# Fresh build
echo "--- Build ---" | tee -a "$LOG"
cd "$ROOT"
npm run build 2>&1 | tail -2 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# ── Phase 1: Compaction Stress Test ─────────────────────────────────────────
echo "=== Phase 1/3: Compaction Stress Test ===" | tee -a "$LOG"
echo "Started: $(date)" | tee -a "$LOG"

cd "$ROOT"
export PI_MODEL=${PI_MODEL:-step-3.5-flash}
export PI_PROVIDER=${PI_PROVIDER:-stepfun}

START=$SECONDS
node evaluation/stress-test.mjs 2>&1 | tee -a "$LOG"
STRESS_EXIT=${PIPESTATUS[0]}
STRESS_TIME=$((SECONDS - START))

if [ $STRESS_EXIT -eq 0 ]; then
  echo "✓ Stress test PASSED (${STRESS_TIME}s)" | tee -a "$LOG"
else
  echo "✗ Stress test FAILED (${STRESS_TIME}s)" | tee -a "$LOG"
fi
echo "" | tee -a "$LOG"

# ── Phase 2: Full Benchmark Suite ───────────────────────────────────────────
echo "=== Phase 2/3: Benchmark Suite ===" | tee -a "$LOG"
echo "Started: $(date)" | tee -a "$LOG"

# BM1 braid
echo "--- BM1 braid ---" | tee -a "$LOG"
START=$SECONDS
node evaluation/bm1-sdk.mjs --timeout 90 2>&1 | tee -a "$RESULTS/bm1_braid_$TS.log"
BM1_BRAID=$?
echo "BM1 braid: exit=$BM1_BRAID time=$((SECONDS - START))s" | tee -a "$LOG"

# BM2 braid
echo "--- BM2 braid ---" | tee -a "$LOG"
START=$SECONDS
node evaluation/bm2-sdk.mjs --timeout 60 2>&1 | tee -a "$RESULTS/bm2_braid_$TS.log"
BM2_BRAID=$?
echo "BM2 braid: exit=$BM2_BRAID time=$((SECONDS - START))s" | tee -a "$LOG"

# BR1 braid
echo "--- BR1 braid ---" | tee -a "$LOG"
START=$SECONDS
node evaluation/br1-sdk.mjs 2>&1 | tee -a "$RESULTS/br1_braid_$TS.log"
BR1_BRAID=$?
echo "BR1 braid: exit=$BR1_BRAID time=$((SECONDS - START))s" | tee -a "$LOG"

# BM1 naked
echo "--- BM1 naked ---" | tee -a "$LOG"
START=$SECONDS
PI_CODING_AGENT_DIR=/tmp/pi-braid-naked-${TS} \
  node evaluation/bm1-sdk.mjs --timeout 90 2>&1 | tee -a "$RESULTS/bm1_naked_$TS.log"
BM1_NAKED=$?
echo "BM1 naked: exit=$BM1_NAKED time=$((SECONDS - START))s" | tee -a "$LOG"

# BM2 naked
echo "--- BM2 naked ---" | tee -a "$LOG"
START=$SECONDS
PI_CODING_AGENT_DIR=/tmp/pi-braid-naked-${TS} \
  node evaluation/bm2-sdk.mjs --timeout 60 2>&1 | tee -a "$RESULTS/bm2_naked_$TS.log"
BM2_NAKED=$?
echo "BM2 naked: exit=$BM2_NAKED time=$((SECONDS - START))s" | tee -a "$LOG"

echo "" | tee -a "$LOG"

# ── Phase 3: Consolidation Test ─────────────────────────────────────────────
echo "=== Phase 3/3: Consolidation + SOP Suggestion Test ===" | tee -a "$LOG"
echo "Started: $(date)" | tee -a "$LOG"

cd "$ROOT"
START=$SECONDS
node -e "
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';

const model = { ...stepfunModels.find(m => m.id === 'step-3.5-flash'), provider: 'stepfun', api: 'openai-completions', baseUrl: 'https://api.stepfun.ai/step_plan/v1' };

const loader = new DefaultResourceLoader({ cwd: '/tmp', agentDir: getAgentDir(), extensionFactories: [(pi) => { pi.registerProvider('stepfun', { baseUrl: 'https://api.stepfun.ai/step_plan/v1', apiKey: 'STEP_API_KEY', api: 'openai-completions', models: stepfunModels }); }] });
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader, model, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) });

let sopCount = 0;
session.subscribe((evt) => {
  if (evt.type === 'tool_execution_start') {
    if (evt.toolName === 'scratchpad') sopCount++;
  }
});

await session.prompt('Write a debounce function to /tmp/cons-test/debounce.js. Use module.exports.');
await session.prompt('Now write a throttle function to /tmp/cons-test/throttle.js. Use module.exports.');

console.log('SOP interactions:', sopCount);
" 2>&1 | tee -a "$RESULTS/consolidation_$TS.log"
CONSOL=$?
CONSOL_TIME=$((SECONDS - START))
echo "Consolidation test: exit=$CONSOL time=${CONSOL_TIME}s" | tee -a "$LOG"

echo "" | tee -a "$LOG"

# ── Report ──────────────────────────────────────────────────────────────────
echo "=== Report ===" | tee -a "$LOG"
echo "Finished: $(date)" | tee -a "$LOG"

# Extract scores from logs
BM1_BRAID_SCORE=$(grep -oP 'Overall: \K[\d.]+(?=/100)' "$RESULTS/bm1_braid_$TS.log" 2>/dev/null || echo "?")
BM2_BRAID_SCORE=$(grep -oP 'Overall: \K[\d.]+(?=/100)' "$RESULTS/bm2_braid_$TS.log" 2>/dev/null || echo "?")
BR1_BRAID_SCORE=$(grep -oP 'Average score: \K[\d.]+(?=/100)' "$RESULTS/br1_braid_$TS.log" 2>/dev/null || echo "?")
BM1_NAKED_SCORE=$(grep -oP 'Overall: \K[\d.]+(?=/100)' "$RESULTS/bm1_naked_$TS.log" 2>/dev/null || echo "?")
BM2_NAKED_SCORE=$(grep -oP 'Overall: \K[\d.]+(?=/100)' "$RESULTS/bm2_naked_$TS.log" 2>/dev/null || echo "?")

REPORT="$RESULTS/autonomous-report_$TS.md"
cat > "$REPORT" << EOF
# pi-braid Autonomous Test Report

**Generated**: $(date)
**Model**: stepfun/step-3.5-flash

---

## Phase 1: Compaction Stress Test
- **Result**: $([ $STRESS_EXIT -eq 0 ] && echo "PASSED" || echo "FAILED")
- **Duration**: ${STRESS_TIME}s

## Phase 2: Benchmarks

| Benchmark | braid | naked | Delta |
|-----------|-------|-------|-------|
| BM1 (debugging) | **${BM1_BRAID_SCORE}/100** | **${BM1_NAKED_SCORE}/100** | $(echo "$BM1_BRAID_SCORE - $BM1_NAKED_SCORE" | bc 2>/dev/null || echo "?") |
| BM2 (code quality) | **${BM2_BRAID_SCORE}/100** | **${BM2_NAKED_SCORE}/100** | $(echo "$BM2_BRAID_SCORE - $BM2_NAKED_SCORE" | bc 2>/dev/null || echo "?") |
| BR1 (trap tasks) | **${BR1_BRAID_SCORE}/100** | — | — |

## Phase 3: Consolidation Test
- **Result**: $([ $CONSOL -eq 0 ] && echo "PASSED" || echo "FAILED")
- **Duration**: ${CONSOL_TIME}s

---

## Log Files
$(ls -lh "$RESULTS"/*_${TS}.* 2>/dev/null | sed 's/.*/  - &/')
EOF

echo "Report: $REPORT" | tee -a "$LOG"
echo "" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
