#!/usr/bin/env bash
# braid-daemon — tmux-based pi-braid daemon orchestrator
# Manages: main pi agent + observatory (monitoring WebSocket server)
set -euo pipefail

BRAID_ROOT="${BRAID_ROOT:-$HOME/projects/agents/pi-braid}"
SESSION="braid-daemon"
LOGDIR="$HOME/.pi-braid/logs"
PIDFILE="$HOME/.pi-braid/daemon.pid"
OBSERVATORY_PORT="${OBSERVATORY_PORT:-4199}"
OBSERVATORY_PIDFILE="$HOME/.pi-braid/observatory.pid"
OBSERVATORY_HEALTHFILE="$HOME/.pi-braid/observatory.health"

ensure_dirs() {
	mkdir -p "$LOGDIR" "$HOME/.pi-braid"
}

# ── Main daemon commands ────────────────────────────────────────────────

cmd_start() {
	ensure_dirs
	# Start observatory daemon (singleton WebSocket server for monitoring)
	observatory_start
	# Start main pi agent session
	if tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "Daemon already running (tmux session: $SESSION)"
		exit 0
	fi
	tmux new-session -d -s "$SESSION" -n "braid" \
		"cd $BRAID_ROOT && pi -e src/index.ts 2>&1 | tee -a $LOGDIR/daemon.log"
	echo "Daemon started (tmux: $SESSION)"
}

cmd_stop() {
	observatory_stop
	if ! tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "Daemon not running"
		rm -f "$PIDFILE" "$OBSERVATORY_PIDFILE" "$OBSERVATORY_HEALTHFILE"
		exit 0
	fi
	tmux send-keys -t "$SESSION" C-c
	sleep 2
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	rm -f "$PIDFILE" "$OBSERVATORY_PIDFILE" "$OBSERVATORY_HEALTHFILE"
	echo "Daemon stopped"
}

cmd_status() {
	echo "=== Observatory ==="
	observatory_status
	echo ""
	echo "=== Agent Daemon ==="
	if tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "Daemon: RUNNING"
		echo "Session: $SESSION"
		echo "Log: $LOGDIR/daemon.log"
		[ -f "$PIDFILE" ] && echo "PID: $(cat "$PIDFILE")"
	else
		echo "Daemon: STOPPED"
	fi
}

cmd_logs() {
	tail -f "$LOGDIR/daemon.log" 2>/dev/null || echo "No logs yet"
}

# ── Observatory sub-commands ────────────────────────────────────────────

observatory_start() {
	# Check if already running
	if [ -f "$OBSERVATORY_PIDFILE" ]; then
		local old_pid
		old_pid=$(cat "$OBSERVATORY_PIDFILE")
		if kill -0 "$old_pid" 2>/dev/null; then
			echo "Observatory already running (pid: $old_pid)"
			return 0
		fi
		rm -f "$OBSERVATORY_PIDFILE"
	fi

	# Compile the daemon script first
	(cd "$BRAID_ROOT" && npx tsc braid-os/observatory-daemon.ts --outDir braid-os/dist --module nodenext --target esnext --moduleResolution nodenext 2>/dev/null) || true

	# Start observatory daemon as background Node process
	OBSERVATORY_PORT="$OBSERVATORY_PORT" nohup node "$BRAID_ROOT/braid-os/dist/observatory-daemon.js" \
		>> "$LOGDIR/observatory.log" 2>&1 &
	local pid=$!
	echo "$pid" > "$OBSERVATORY_PIDFILE"
	echo "Observatory daemon started (pid: $pid, port: $OBSERVATORY_PORT)"
	sleep 1

	# Quick health check
	if kill -0 "$pid" 2>/dev/null; then
		echo "Observatory: RUNNING (ws://localhost:$OBSERVATORY_PORT)"
	else
		echo "Observatory: FAILED — check $LOGDIR/observatory.log"
		rm -f "$OBSERVATORY_PIDFILE"
	fi
}

observatory_stop() {
	if [ ! -f "$OBSERVATORY_PIDFILE" ]; then
		echo "Observatory not running"
		return 0
	fi
	local pid
	pid=$(cat "$OBSERVATORY_PIDFILE")
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		sleep 1
		# Force kill if still running
		kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
	fi
	rm -f "$OBSERVATORY_PIDFILE" "$OBSERVATORY_HEALTHFILE"
	echo "Observatory daemon stopped"
}

observatory_status() {
	if [ -f "$OBSERVATORY_PIDFILE" ]; then
		local pid
		pid=$(cat "$OBSERVATORY_PIDFILE")
		if kill -0 "$pid" 2>/dev/null; then
			echo "Observatory: RUNNING (pid: $pid, port: $OBSERVATORY_PORT)"
			echo "Dashboard: open $BRAID_ROOT/observatory/index.html"
			return 0
		fi
		rm -f "$OBSERVATORY_PIDFILE"
	fi
	echo "Observatory: STOPPED"
	return 1
}

observatory_logs() {
	tail -f "$LOGDIR/observatory.log" 2>/dev/null || echo "No observatory logs yet"
}

# ── Top-level dispatch ──────────────────────────────────────────────────

case "${1:-help}" in
	start)   cmd_start ;;
	stop)    cmd_stop ;;
	status)  cmd_status ;;
	logs)    cmd_logs ;;
	restart) cmd_stop; sleep 1; cmd_start ;;
	observatory)
		case "${2:-help}" in
			start)  observatory_start ;;
			stop)   observatory_stop ;;
			status) observatory_status ;;
			logs)   observatory_logs ;;
			*)      echo "Usage: braid-daemon.sh observatory <start|stop|status|logs>" ;;
		esac
		;;
	help|*)  cmd_help ;;
esac
