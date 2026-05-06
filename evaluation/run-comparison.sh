#!/bin/bash
# pi-braid vs Naked pi Comparison Runner (macOS compat)
#
# Runs each SDK benchmark twice:
#   braid — with pi-braid extensions
#   naked — only stepfun provider (using PI_CODING_AGENT_DIR isolation)
#
# For naked mode, creates a temp ~/.pi/agent replacement with settings.json
# that excludes the braid extension path.

set -e

cd "$(dirname "$0")/.."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="evaluation/results"
SUMMARY_MD="${RESULTS_DIR}/comparison_${TIMESTAMP}.md"
mkdir -p "$RESULTS_DIR"

# Clean agent directory for naked runs
NAKED_DIR="/tmp/pi-agent-naked"
rm -rf "$NAKED_DIR"
mkdir -p "$NAKED_DIR/extensions" "$NAKED_DIR/sessions" \
         "$NAKED_DIR/scratchpads" "$NAKED_DIR/checkpoints" \
         "$NAKED_DIR/skills" "$NAKED_DIR/memory" "$NAKED_DIR/errors"

cp ~/.pi/agent/auth.json "$NAKED_DIR/auth.json"

cat > "$NAKED_DIR/settings.json" << JSONEOF
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
  "extensions": [
    "/Users/kifir/projects/agents/pi-poorman-providers"
  ],
  "packages": []
}
JSONEOF

echo "Clean agent dir ready at $NAKED_DIR"

run_benchmark() {
    local name="$1"
    local file="$2"
    local timeout="$3"
    
    for mode in braid naked; do
        echo "=== ${name} [${mode}] ==="
        local log="${RESULTS_DIR}/${name}_${mode}_${TIMESTAMP}.log"
        
        if [ "$mode" = "naked" ]; then
            export PI_CODING_AGENT_DIR="$NAKED_DIR"
        else
            unset PI_CODING_AGENT_DIR
        fi
        
        export PI_MODEL="step-3.5-flash"
        export PI_PROVIDER="stepfun"
        
        # Wait for clean state between runs
        sleep 3
        
        # Run with 5min overall timeout
        timeout 300 node "evaluation/${file}" --timeout "${timeout}" > "$log" 2>&1
        local rc=$?
        
        # Extract overall score
        local score="N/A"
        if grep -q 'Overall:' "$log" 2>/dev/null; then
            score=$(grep 'Overall:' "$log" | sed 's/.*Overall:[[:space:]]*\([0-9.]*\)\/100.*/\1/' | tail -1)
        fi
        
        # Extract per-task lines
        local details=$(grep -E 'score=[0-9.]+/100' "$log" | head -5 || true)
        
        echo "  score=${score}"
        echo "$details" | sed 's/^/    /'
        
        # Store for summary
        eval "${name}_${mode}_score=\"$score\""
        eval "${name}_${mode}_details=\"$details\""
    done
}

# Run benchmarks sequentially
run_benchmark "bm1-sdk" "bm1-sdk.mjs" 90
run_benchmark "bm2-sdk" "bm2-sdk.mjs" 60
run_benchmark "br1-sdk" "br1-sdk.mjs" 60

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "========================"
echo " COMPARISON RESULTS"
echo "========================"

for name in bm1-sdk bm2-sdk br1-sdk; do
    eval b_score="\${${name}_braid_score}"
    eval n_score="\${${name}_naked_score}"
    b_score="${b_score:-N/A}"
    n_score="${n_score:-N/A}"
    
    echo ""
    echo "${name}:"
    echo "  braid: ${b_score}/100"
    echo "  naked: ${n_score}/100"
    if [ "$b_score" != "N/A" ] && [ "$n_score" != "N/A" ]; then
        delta=$(python3 -c "print(${b_score} - ${n_score})" 2>/dev/null || echo "?")
        echo "  delta: ${delta}"
    fi
    echo "  braid details:"
    eval details="\${${name}_braid_details}"
    echo "$details" | sed 's/^/    /'
    echo "  naked details:"
    eval details="\${${name}_naked_details}"
    echo "$details" | sed 's/^/    /'
done

# ── Write Markdown ──────────────────────────────────────────────────────────
{
    echo "# pi-braid vs Naked pi — Comparison Results"
    echo ""
    echo "**Generated**: $(date)"
    echo "**Model**: stepfun/step-3.5-flash"
    echo ""
    echo "| Benchmark | Config | Score | Details |"
    echo "|-----------|--------|-------|---------|"
    
    for name in bm1-sdk bm2-sdk br1-sdk; do
        eval b_score="\${${name}_braid_score}"
        eval n_score="\${${name}_naked_score}"
        eval b_det="\${${name}_braid_details}"
        eval n_det="\${${name}_naked_details}"
        b_score="${b_score:-N/A}"
        n_score="${n_score:-N/A}"
        b_det=$(echo "$b_det" | head -1 | sed 's/|//g' | xargs)
        n_det=$(echo "$n_det" | head -1 | sed 's/|//g' | xargs)
        
        echo "| ${name} | braid | ${b_score} | ${b_det} |"
        echo "| | naked | ${n_score} | ${n_det} |"
        if [ "$b_score" != "N/A" ] && [ "$n_score" != "N/A" ]; then
            delta=$(python3 -c "print('+' if ${b_score} > ${n_score} else '', ${b_score} - ${n_score})" 2>/dev/null || echo "?")
            echo "| | **Delta** | **${delta}** | — |"
        fi
    done
    
} > "$SUMMARY_MD"

echo ""
echo "Results: $SUMMARY_MD"
cat "$SUMMARY_MD"
