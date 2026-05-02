#!/bin/bash
# Phase 3: Run all benchmarks sequentially
# Usage: bash evaluation/run-sprint-benchmarks.sh

set -e

ROOT="/Users/kifir/projects/agents/pi-braid"
RESULTS_DIR="$ROOT/evaluation/results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TOTAL_START=$(date +%s)

echo "=== pi-braid Overnight Sprint Benchmarks ==="
echo "Started: $(date)"
echo "Results: $RESULTS_DIR"
echo ""

# ── BM1: Multi-Turn Debugging ─────────────────────────────────────────────
echo "━━━ BM1: Multi-Turn Debugging (stepfun/step-3.5-flash) ━━━"
BM1_START=$(date +%s)
node "$ROOT/evaluation/bm1-sdk.mjs" \
  --model "stepfun/step-3.5-flash" \
  --timeout 120 \
  --output "$RESULTS_DIR/bm1-stepfun-${TIMESTAMP}.json" \
  2>&1 | tee "$RESULTS_DIR/bm1-stepfun-${TIMESTAMP}.log" || echo "⚠️ BM1 had failures"
BM1_END=$(date +%s)
echo "BM1 duration: $((BM1_END - BM1_START))s"
echo ""

# ── BM2: Code Quality ─────────────────────────────────────────────────────
echo "━━━ BM2: Code Quality (stepfun/step-3.5-flash) ━━━"
BM2_START=$(date +%s)
node "$ROOT/evaluation/bm2-sdk.mjs" \
  --model "step-3.5-flash" \
  --timeout 90 \
  --output "$RESULTS_DIR/bm2-stepfun-${TIMESTAMP}.json" \
  2>&1 | tee "$RESULTS_DIR/bm2-stepfun-${TIMESTAMP}.log" || echo "⚠️ BM2 had failures"
BM2_END=$(date +%s)
echo "BM2 duration: $((BM2_END - BM2_START))s"
echo ""

# ── BR1: Trap Tasks ───────────────────────────────────────────────────────
echo "━━━ BR1: Trap Tasks (stepfun/step-3.5-flash) ━━━"
BR1_START=$(date +%s)
node "$ROOT/evaluation/br1-sdk.mjs" \
  2>&1 | tee "$RESULTS_DIR/br1-stepfun-${TIMESTAMP}.log" || echo "⚠️ BR1 had failures"
BR1_END=$(date +%s)
echo "BR1 duration: $((BR1_END - BR1_START))s"
echo ""

# ── BR4: Latent Activator ─────────────────────────────────────────────────
echo "━━━ BR4: Latent Activator Multi-Turn (stepfun/step-3.5-flash) ━━━"
BR4_START=$(date +%s)
node "$ROOT/evaluation/br4-sdk.mjs" \
  --trials 3 \
  --timeout 90 \
  --output "$RESULTS_DIR/br4-stepfun-${TIMESTAMP}.json" \
  2>&1 | tee "$RESULTS_DIR/br4-stepfun-${TIMESTAMP}.log" || echo "⚠️ BR4 had failures"
BR4_END=$(date +%s)
echo "BR4 duration: $((BR4_END - BR4_START))s"
echo ""

# ── PB4: Compliance Behavior ──────────────────────────────────────────────
echo "━━━ PB4: Compliance Behavior (stepfun/step-3.5-flash) ━━━"
PB4_START=$(date +%s)
node "$ROOT/evaluation/pb4-sdk.mjs" \
  --trials 3 \
  --timeout 90 \
  --output "$RESULTS_DIR/pb4-stepfun-${TIMESTAMP}.json" \
  2>&1 | tee "$RESULTS_DIR/pb4-stepfun-${TIMESTAMP}.log" || echo "⚠️ PB4 had failures"
PB4_END=$(date +%s)
echo "PB4 duration: $((PB4_END - PB4_START))s"
echo ""

# ── Total ─────────────────────────────────────────────────────────────────
TOTAL_END=$(date +%s)
TOTAL_DURATION=$((TOTAL_END - TOTAL_START))
echo "=== All Benchmarks Complete ==="
echo "Total duration: ${TOTAL_DURATION}s ($((TOTAL_DURATION / 60))m)"
echo "Results in: $RESULTS_DIR"
echo "Timestamp: $TIMESTAMP"
