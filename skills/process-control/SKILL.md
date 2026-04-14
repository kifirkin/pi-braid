---
name: process-control
description: "Run and interact with long-running subprocesses: background tasks, interactive CLIs, dev servers, subagents, parallel workers. Use when: task needs >30s, must monitor output over time, interactive input required, parallel execution needed, dev server to start/stop, debugger to drive, or REPL to control. Covers tmux, bash backgrounding, and nohup."
---

# Process Control

Run long-running subprocesses and interact with them over time. The core problem: `bash` tool calls are synchronous — once they return, the process is gone. This skill covers mechanisms that let processes persist across multiple tool calls so you can monitor, interact with, and control them.

## Choosing a Mechanism

| Mechanism | Best For | Persistence | Interactive |
|-----------|----------|-------------|-------------|
| **tmux** | Anything >30s, interactive CLIs, subagents, parallel work | Full (survives disconnect) | Full (send keys, capture output) |
| **bash `&`** | Fire-and-forget <30s where you don't need output | Process only | None |
| **`nohup ... &`** | Long tasks where you only need final output, not interaction | Survives shell exit | None (output to file) |

**Default choice**: tmux. It gives you create → send → capture → kill as discrete operations.

## tmux: Primary Mechanism

### Session Lifecycle

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)

tmux -S $SOCKET new -d -s <name>                          # Spawn session
tmux -S $SOCKET send-keys -t <name>:0.0 'cmd' Enter       # Send input
tmux -S $SOCKET capture-pane -p -J -t <name>:0.0 -S -50   # Read output
tmux -S $SOCKET send-keys -t <name>:0.0 C-c               # Interrupt
tmux -S $SOCKET kill-session -t <name>                     # Terminate
```

**Socket**: `${TMPDIR:-/tmp}/pi-tmux-sockets` · **Target**: `session:window.pane` (default `:0.0`)

### Pattern: Supervisor-Worker

One agent supervises a subprocess over multiple turns:

```bash
SESSION=worker-1
tmux -S $SOCKET new -d -s $SESSION
tmux -S $SOCKET send-keys -t $SESSION:0.0 'pi --task "implement feature X"' Enter

# Later: check progress
tmux -S $SOCKET capture-pane -p -J -t $SESSION:0.0 -S -100

# Later: send follow-up based on output
OUTPUT=$(tmux -S $SOCKET capture-pane -p -t $SESSION:0.0)
if echo "$OUTPUT" | grep -q "waiting for input"; then
  tmux -S $SOCKET send-keys -t $SESSION:0.0 'proceed' Enter
fi

# Done: cleanup
tmux -S $SOCKET kill-session -t $SESSION
```

### Pattern: Parallel Workers

```bash
for i in 1 2 3; do
  tmux -S $SOCKET new -d -s "worker-$i"
  tmux -S $SOCKET send-keys -t "worker-$i":0.0 "pi --task 'task-$i'" Enter
done

# Monitor all
for i in 1 2 3; do
  tmux -S $SOCKET capture-pane -p -t "worker-$i":0.0 -S -20
done

# Collect and cleanup
for i in 1 2 3; do
  tmux -S $SOCKET capture-pane -p -t "worker-$i":0.0 | tail -5
  tmux -S $SOCKET kill-session -t "worker-$i"
done
```

### Pattern: Dev Server Loop

```bash
tmux -S $SOCKET new -d -s dev
tmux -S $SOCKET send-keys -t dev:0.0 'npm run dev' Enter
sleep 10
tmux -S $SOCKET send-keys -t dev:0.0 'curl localhost:3000/api/test' Enter
tmux -S $SOCKET capture-pane -p -t dev:0.0
# Iterate: send fix commands, re-capture
tmux -S $SOCKET kill-session -t dev
```

### Pattern: Interactive REPL / Debugger

| CLI | Spawn Command |
|-----|---------------|
| Python REPL | `PYTHON_BASIC_REPL=1 python3 -q` |
| Node REPL | `node` |
| GDB | `gdb --quiet ./binary` then `set pagination off` |
| LLDB | `lldb ./binary` |

Send input: `send-keys -t $SESSION:0.0 'command' Enter`  
Interrupt: `send-keys -t $SESSION:0.0 C-c`  
Literal text (no Enter): `send-keys -l 'text'`  
Manual attach: `tmux -S $SOCKET attach -t <session>`  
Keybindings: `Ctrl+b d` detach · `Ctrl+b [` scroll · `Ctrl+b c` new window

## nohup: Non-Interactive Long Tasks

When you need a process to run long but don't need to interact:

```bash
nohup ./long-benchmark.sh > /tmp/benchmark.log 2>&1 &
echo $!  # Save PID

# Later: check output
cat /tmp/benchmark.log

# Later: check if still running
kill -0 $PID 2>/dev/null && echo "running" || echo "finished"

# Kill if needed
kill $PID
```

## Cleanup

```bash
# Kill specific tmux session
tmux -S $SOCKET kill-session -t <name>

# Kill all tmux sessions
for s in $(tmux -S $SOCKET list-sessions 2>/dev/null | cut -d: -f1); do
  tmux -S $SOCKET kill-session -t "$s"
done

# Kill tmux server entirely
tmux -S $SOCKET kill-server
```
