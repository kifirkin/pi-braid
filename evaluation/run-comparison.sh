#!/bin/bash
# pi-braid vs Naked pi Comparison Runner (v3 — minimal)
#
# For naked mode: creates clean ~/.pi/agent with only stepfun provider.
# Runs benchmarks via node subprocess with brief timeout per task.
# No complex watchdog — trusts benchmark's internal --timeout.

set -euo pipefail

cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="evaluation/results"
SUMMARY_MD="${RESULTS_DIR}/comparison_${TS}.md"
mkdir -p "$RESULTS_DIR"

# Clean agent dir for naked runs
NAKED_DIR="/tmp/pi-naked-${TS}"
rm -rf "$NAKED_DIR"
mkdir -p "$NAKED_DIR"/{extensions,sessions,scratchpads,checkpoints,skills,memory,errors}
cp ~/.pi/agent/auth.json "$NAKED_DIR/auth.json"

cat > "$NAKED_DIR/settings.json" << EOF
{
  "defaultProvider": "stepfun",
  "defaultModel": "step-3.5-flash",
  "thinking": "high",
  "compaction": { "enabled": false },
  "hideThinkingBlock": true,
  "quietStartup": true,
  "enableSkillCommands": false,
  "retry": { "enabled": false },
  "disableConfirmations": true,
  "extensions": ["/Users/kifir/projects/agents/pi-poorman-providers"],
  "packages": []
}
EOF

# ── Run one benchmark in one mode ──────────────────────────────────────
run_bench() {
    local name="$1" file="$2" ttimeout="$3" mode="$4"
    local label="${name}_${mode}"
    local log="${RESULTS_DIR}/${label}_${TS}.log"
    
    echo "  [${label}] task_timeout=${ttimeout}s …"
    
    if [ "$mode" = "naked" ]; then
        export PI_CODING_AGENT_DIR="$NAKED_DIR"
    else
        unset PI_CODING_AGENT_DIR
    fi
    export PI_MODEL="step-3.5-flash"
    export PI_PROVIDER="stepfun"
    
    # Run with overall timeout via background kill
    node "evaluation/${file}" --timeout "${ttimeout}" > "$log" 2>&1 &
    local PID=$!
    
    # Kill after 20 min wall clock (BM1 takes ~8min alone)
    ( sleep 1200; kill $PID 2>/dev/null ) &
    local KILLER=$!
    
    wait $PID 2>/dev/null
    kill $KILLER 2>/dev/null || true
    
    local score=$(grep 'Overall:' "$log" | sed 's/.*Overall:[[:space:]]*\([0-9.]*\)\/100.*/\1/' | tail -1)
    echo "${score:-N/A}"
}

echo "=== pi-braid vs Naked pi ==="
echo "Model: stepfun/step-3.5-flash"
echo ""

# BM1: 5 tasks × 90s = up to 7.5min each
echo "--- bm1-sdk ---"
B1=$(run_bench "bm1-sdk" "bm1-sdk.mjs" 90 "braid")
N1=$(run_bench "bm1-sdk" "bm1-sdk.mjs" 90 "naked")

# BM2: 3 tasks × 60s = up to 3min each  
echo "--- bm2-sdk ---"
B2=$(run_bench "bm2-sdk" "bm2-sdk.mjs" 60 "braid")
N2=$(run_bench "bm2-sdk" "bm2-sdk.mjs" 60 "naked")

# BR1: 5 tasks × 60s = up to 5min each
echo "--- br1-sdk ---"
B3=$(run_bench "br1-sdk" "br1-sdk.mjs" 60 "braid")
N3=$(run_bench "br1-sdk" "br1-sdk.mjs" 60 "naked")

# ── Output ─────────────────────────────────────────────────────────────
echo ""
echo "=============================="
echo " RESULTS"
echo "=============================="

{
    echo "# pi-braid vs Naked pi — Comparison Results"
    echo ""; echo "**Generated**: $(date)"; echo "**Model**: stepfun/step-3.5-flash"; echo ""
    echo "| Benchmark | braid | naked | Delta |"
    echo "|-----------|-------|-------|-------|"
    
    for row in "bm1-sdk $B1 $N1" "bm2-sdk $B2 $N2" "br1-sdk $B3 $N3"; do
        set -- $row; n=$1; b=$2; nk=$3
        b="${b:-?}"; nk="${nk:-?}"
        if [ "$b" != "N/A" ] && [ "$nk" != "N/A" ] 2>/dev/null; then
            d=$(python3 -c "d=$b-$nk; print(f'+{d}' if d>0 else d)" 2>/dev/null)
        else
            d="N/A"
        fi
        echo "| ${n} | ${b}/100 | ${nk}/100 | ${d} |"
    done
} > "$SUMMARY_MD"

# Console
for row in "bm1-sdk $B1 $N1" "bm2-sdk $B2 $N2" "br1-sdk $B3 $N3"; do
    set -- $row; echo "$1: braid=$2  naked=$3"
done

echo ""
echo "Results: $SUMMARY_MD"
cat "$SUMMARY_MD"
