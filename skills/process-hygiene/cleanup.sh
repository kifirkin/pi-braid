#!/bin/bash
# Process Hygiene - Cleanup stale pi instances
#
# Usage:
#   cleanup.sh [--pi-only] [--dry-run] [--list] [--force] [age_minutes]
#
# Options:
#   --pi-only    Only kill pi-cli processes, not all children
#   --dry-run    Show what would be killed without killing
#   --list       Just list stale processes
#   --force      Also kill recent processes (within threshold)
#   age_minutes  Age threshold in minutes (default: 5)

# Arrays to store findings
declare -a STALE_PIDS=()
declare -a STALE_TMUX=()
declare -a STALE_DIRS=()

# Parse arguments
PI_ONLY=false
DRY_RUN=false
LIST_ONLY=false
FORCE=false
STALE_THRESHOLD=5

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pi-only)
            PI_ONLY=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --list)
            LIST_ONLY=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            if [[ "$1" =~ ^[0-9]+$ ]]; then
                STALE_THRESHOLD="$1"
            fi
            shift
            ;;
    esac
done

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== Process Hygiene ==="
echo "Stale threshold: ${STALE_THRESHOLD} minutes"
[[ "$DRY_RUN" == true ]] && echo "Mode: DRY RUN (no changes will be made)"
[[ "$PI_ONLY" == true ]] && echo "Scope: pi-cli only"
echo ""

# Calculate cutoff time (epoch seconds)
CUTOFF=$(($(date +%s) - (STALE_THRESHOLD * 60)))

echo "Finding stale processes..."

# Find stale pi/node processes
for pid in $(pgrep -f "pi.*cli.js" 2>/dev/null || true); do
    START_TIME=$(ps -p "$pid" -o lstart= 2>/dev/null || true)
    [[ -z "$START_TIME" ]] && continue

    # Convert start time to epoch
    PROC_EPOCH=$(date -j -f "%a %b %d %T %Y" "$START_TIME" +%s 2>/dev/null || echo 0)

    if [[ "$PROC_EPOCH" -lt "$CUTOFF" ]] || [[ "$FORCE" == true ]]; then
        STALE_PIDS+=("$pid")
        CMD=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
        ELAPSED=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || echo "?")
        echo -e "  ${YELLOW}Found${NC}: PID $pid ($CMD, elapsed: $ELAPSED)"
    fi
done

# Find bash processes running pi
for pid in $(pgrep -f "bash.*-c.*pi" 2>/dev/null || true); do
    # Skip if already in STALE_PIDS
    skip=false
    for existing in "${STALE_PIDS[@]}"; do
        [[ "$existing" == "$pid" ]] && skip=true && break
    done
    [[ "$skip" == true ]] && continue

    CMDLINE=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if echo "$CMDLINE" | grep -q "pi-mono.*cli.js\|coding-agent.*dist/cli"; then
        STALE_PIDS+=("$pid")
        ELAPSED=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || echo "?")
        echo -e "  ${YELLOW}Found${NC}: PID $pid (bash with pi, elapsed: $ELAPSED)"
    fi
done

# Find stale tmux sessions
while IFS= read -r session; do
    [[ -z "$session" ]] && continue
    if tmux list-windows -t "$session" 2>/dev/null | grep -q "pi\|node.*cli"; then
        ELAPSED=$(tmux display-message -t "$session" -p "#{session_activity}" 2>/dev/null || echo "?")
        echo -e "  ${YELLOW}Found${NC}: Tmux session '$session' (idle: $ELAPSED)"
        STALE_TMUX+=("$session")
    fi
done < <(tmux list-sessions 2>/dev/null | cut -d: -f1 || true)

# Find old temp directories
echo ""
echo "Checking for stale temp directories..."

for pattern in "modern-bench-" "pi-" "bench-test"; do
    for dir in /tmp/${pattern}*; do
        [[ -e "$dir" ]] || continue
        [[ ! -d "$dir" ]] && continue

        DIR_EPOCH=$(stat -f "%m" "$dir" 2>/dev/null || echo 0)
        if [[ "$DIR_EPOCH" -lt "$CUTOFF" ]] || [[ "$FORCE" == true ]]; then
            DIR_AGE=$((($(date +%s) - DIR_EPOCH) / 60))
            [[ "$DIR_AGE" -lt 0 ]] && DIR_AGE=0
            echo -e "  ${YELLOW}Found${NC}: Stale temp dir: $dir (${DIR_AGE}m old)"
            STALE_DIRS+=("$dir")
        fi
    done
done

# Summary
echo ""
echo "=== Summary ==="
echo "Stale pi processes: ${#STALE_PIDS[@]}"
echo "Stale tmux sessions: ${#STALE_TMUX[@]}"
echo "Stale temp dirs: ${#STALE_DIRS[@]}"

if [[ "$LIST_ONLY" == true ]]; then
    exit 0
fi

if [[ ${#STALE_PIDS[@]} -eq 0 ]] && [[ ${#STALE_TMUX[@]} -eq 0 ]] && [[ ${#STALE_DIRS[@]} -eq 0 ]]; then
    echo -e "${GREEN}No stale processes found. System is clean!${NC}"
    exit 0
fi

# Action
echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo -e "${YELLOW}DRY RUN: Would kill ${#STALE_PIDS[@]} processes, ${#STALE_TMUX[@]} tmux sessions, ${#STALE_DIRS[@]} temp dirs${NC}"
    exit 0
fi

echo -e "${RED}Cleaning up...${NC}"

# Kill stale processes
for pid in "${STALE_PIDS[@]}"; do
    echo -e "  Killing PID $pid..."
    # Try graceful kill first, then force
    kill "$pid" 2>/dev/null && sleep 0.5 && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "    Done"
done

# Kill stale tmux sessions
for session in "${STALE_TMUX[@]}"; do
    echo -e "  Killing tmux session: $session"
    tmux kill-session -t "$session" 2>/dev/null
    echo "    Done"
done

# Remove stale temp directories
for dir in "${STALE_DIRS[@]}"; do
    echo -e "  Removing temp dir: $dir"
    rm -rf "$dir" 2>/dev/null
    echo "    Done"
done

echo ""
echo -e "${GREEN}Cleanup complete!${NC}"

# Show remaining processes
echo ""
echo "Remaining pi processes:"
remaining=$(pgrep -f "pi.*cli.js" 2>/dev/null || true)
if [[ -z "$remaining" ]]; then
    echo "  None"
else
    for pid in $remaining; do
        ELAPSED=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || echo "?")
        echo "  PID $pid (elapsed: $ELAPSED)"
    done
fi
