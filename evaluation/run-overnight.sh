#!/bin/bash
# Overnight Benchmark Runner — pi-braid full performance measurement
# Runs all SDK benchmarks sequentially with stepfun model.
# Results saved to evaluation/results/ with timestamps.

set -e

cd "$(dirname "$0")/.."
RESULTS_DIR="evaluation/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SUMMARY_FILE="${RESULTS_DIR}/overnight_${TIMESTAMP}.md"

export PI_MODEL="step-3.5-flash"
export PI_PROVIDER="stepfun"

echo "=== pi-braid Overnight Benchmark Run ===" > "$SUMMARY_FILE"
echo "Started: $(date)" >> "$SUMMARY_FILE"
echo "Model: stepfun/step-3.5-flash" >> "$SUMMARY_FILE"
echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

run_bench() {
    local name="$1"
    local cmd="$2"
    local timeout="$3"
    local logfile="${RESULTS_DIR}/${name}_${TIMESTAMP}.log"
    
    echo ""
    echo "=== Running $name ==="
    echo "Log: $logfile"
    
    # Run with timeout via background + sleep
    eval "$cmd" > "$logfile" 2>&1 &
    PID=$!
    
    # Wait with timeout
    slept=0
    while kill -0 $PID 2>/dev/null; do
        sleep 5
        slept=$((slept + 5))
        if [ $slept -ge $timeout ]; then
            echo "TIMEOUT after ${timeout}s" >> "$logfile"
            kill $PID 2>/dev/null || true
            break
        fi
    done
    wait $PID 2>/dev/null
    local ec=$?
    
    # Extract results
    local summary_line=$(grep -E "Overall|PASSED|FAILED|Results|Score" "$logfile" | tail -5)
    echo "Exit code: $ec"
    echo "$summary_line"
    
    echo "### $name" >> "$SUMMARY_FILE"
    echo '```' >> "$SUMMARY_FILE"
    cat "$logfile" >> "$SUMMARY_FILE"
    echo '```' >> "$SUMMARY_FILE"
    echo "" >> "$SUMMARY_FILE"
}

# 1. Quick functional test
run_bench "quick-test" "node evaluation/quick-test.js" 90

# 2. BM1: Multi-Turn Debugging (5 tasks, 120s each)
run_bench "bm1" "node evaluation/bm1-sdk.mjs --timeout 120 --trials 1" 600

# 3. BR1: Trap Tasks (compliance/self-reflection)
run_bench "br1" "node evaluation/br1-sdk.mjs" 300

# 4. BM2: Code Quality
run_bench "bm2" "node evaluation/bm2-sdk.mjs --timeout 90" 300

# 5. BM3: Real-World Tasks
run_bench "bm3" "node evaluation/bm3-sdk.mjs --timeout 120" 600

# 6. BR4: Latent Activator Comparison
run_bench "br4" "node evaluation/br4-sdk.mjs --task 'List the files in /Users/kifir/projects/agents/pi-braid/src/lib/ and explain what each module does, then fix any bugs you find' --timeout 90 --trials 1" 300

echo ""
echo "=== FINISHED ===" >> "$SUMMARY_FILE"
echo "Completed: $(date)" >> "$SUMMARY_FILE"

# Print summary
echo ""
echo "=== Overnight Summary ==="
echo "Started at the beginning of this log"
echo "Results saved to: $SUMMARY_FILE"
echo "Individual logs in: $RESULTS_DIR/"
grep -E "^(### |Overall|quick-test|bm[0-9]|br[0-9])" "$SUMMARY_FILE" 2>/dev/null || true
