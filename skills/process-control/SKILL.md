---
name: process-control
description: "Use whenever a task needs a process to outlive a single tool call — dev servers, long benchmarks, interactive CLIs, subagents, parallel workers, or anything >30s. Covers: tmux for persistent interactive processes, nohup for fire-and-forget long tasks, and session lifecycle. Activate when starting something that needs monitoring, interaction, or multi-turn control."
---

# Process Control

Bash calls are synchronous — when they return, the process is gone. This skill covers mechanisms that let processes persist across tool calls so you can monitor, interact with, and control them.

---

## tmux: Interactive Persistence

tmux gives you discrete operations: create session, send input, capture output, kill. Use it when you need to monitor progress over time, interact with an interactive CLI, or supervise subagents.

**Core commands** (use these verbatim):

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)

# Create
tmux -S $SOCKET new -d -s <name>

# Send input
tmux -S $SOCKET send-keys -t <name>:0.0 'command' Enter

# Read output (last 50 lines, full width)
tmux -S $SOCKET capture-pane -p -J -t <name>:0.0 -S -50

# Interrupt
tmux -S $SOCKET send-keys -t <name>:0.0 C-c

# Kill
tmux -S $SOCKET kill-session -t <name>
```

**Socket**: `${TMPDIR:-/tmp}/pi-tmux-sockets` · **Target**: `session:window.pane` (defaults to `:0.0`)

**Lifecycle pattern**:

```
1. Create session
2. Send startup command
3. Loop: sleep → capture → parse → respond
4. Kill session (even on error)
```

**Keybindings** (for manual attach): `Ctrl+b d` detach · `Ctrl+b [` scroll · `Ctrl+b c` new window

---

## nohup: Fire-and-Forget

When you need a process to run long but don't need to interact with it:

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

Use nohup when you only need the final result and don't need to monitor intermediate output.

---

## Choosing a Mechanism

| Need                               | Mechanism          |
| ---------------------------------- | ------------------ |
| Monitor output over time           | tmux               |
| Interactive input (REPL, debugger) | tmux               |
| Supervise subagents                | tmux               |
| Dev server start/stop/verify       | tmux               |
| Long task, final output only       | nohup              |
| Quick command <30s                 | bash `&` or direct |

**Default**: tmux. It costs slightly more setup but gives you monitoring and control that nohup can't.

---

## Common Patterns

### Supervisor-Worker

```bash
SESSION=worker-1
tmux -S $SOCKET new -d -s $SESSION
tmux -S $SOCKET send-keys -t $SESSION:0.0 'pi --task "task description"' Enter
# Later: capture and check
tmux -S $SOCKET capture-pane -p -J -t $SESSION:0.0 -S -100
# Done: kill
tmux -S $SOCKET kill-session -t $SESSION
```

### Parallel Workers

```bash
for i in 1 2 3; do
  tmux -S $SOCKET new -d -s "worker-$i"
  tmux -S $SOCKET send-keys -t "worker-$i":0.0 "pi --task 'task-$i'" Enter
done
# Monitor all
for i in 1 2 3; do
  tmux -S $SOCKET capture-pane -p -t "worker-$i":0.0 | tail -20
done
# Collect and kill
for i in 1 2 3; do
  tmux -S $SOCKET kill-session -t "worker-$i"
done
```

### Interactive REPL

| CLI    | Spawn                                            |
| ------ | ------------------------------------------------ |
| Python | `PYTHON_BASIC_REPL=1 python3 -q`                 |
| Node   | `node`                                           |
| GDB    | `gdb --quiet ./binary` then `set pagination off` |
| LLDB   | `lldb ./binary`                                  |

Send input: `tmux send-keys -t $SESSION:0.0 'cmd' Enter`
Interrupt: `tmux send-keys -t $SESSION:0.0 C-c`
Literal (no Enter): `tmux send-keys -l 'text'`

---

## Session Locations

pi sessions: `~/.pi/agent/sessions/` · List recent: `find ~/.pi/agent/sessions -name "*.jsonl" -mtime -7d`
