#!/usr/bin/env bash
# braid-daemon — tmux-based pi-braid daemon orchestrator
set -euo pipefail

BRAID_ROOT="${BRAID_ROOT:-$HOME/projects/agents/pi-braid}"
SESSION="braid-daemon"
LOGDIR="$HOME/.pi-braid/logs"
PIDFILE="$HOME/.pi-braid/daemon.pid"

cmd_start() {
	mkdir -p "$LOGDIR"
	if tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "Daemon already running (tmux session: $SESSION)"
		exit 0
	fi
	tmux new-session -d -s "$SESSION" -n "braid" "cd $BRAID_ROOT && pi -e src/index.ts 2>&1 | tee -a $LOGDIR/daemon.log"
	echo "$$" > "$PIDFILE"
	echo "Daemon started (tmux: $SESSION, pid: $$)"
}

cmd_stop() {
	if ! tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "Daemon not running"
		rm -f "$PIDFILE"
		exit 0
	fi
	tmux send-keys -t "$SESSION" C-c
	sleep 2
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	rm -f "$PIDFILE"
	echo "Daemon stopped"
}

cmd_status() {
	if tmux has-session -t "$SESSION" 2>/dev/null; then
		local uptime
		uptime=$(tmux list-windows -t "$SESSION" -F "#{window_name}" 2>/dev/null | head -1)
		echo "Daemon: RUNNING"
		echo "Session: $SESSION"
		echo "Log: $LOGDIR/daemon.log"
		[ -f "$PIDFILE" ] && echo "PID: $(cat "$PIDFILE")"
	else
		echo "Daemon: STOPPED"
		return 1
	fi
}

cmd_logs() {
	tail -f "$LOGDIR/daemon.log" 2>/dev/null || echo "No logs yet"
}

cmd_help() {
	cat <<EOF
Braid-OS Daemon Orchestrator
Usage: braid-daemon.sh <command>

Commands:
  start    Start the daemon (tmux session: $SESSION)
  stop     Stop the daemon
  status   Check daemon status
  logs     Follow daemon logs
  help     Show this help
EOF
}

case "${1:-help}" in
	start)   cmd_start ;;
	stop)    cmd_stop ;;
	status)  cmd_status ;;
	logs)    cmd_logs ;;
	restart) cmd_stop; sleep 1; cmd_start ;;
	help|*)  cmd_help ;;
esac
