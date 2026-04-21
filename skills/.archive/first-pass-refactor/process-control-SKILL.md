---
name: process-control
description: "Run and interact with long-running subprocesses: background tasks, interactive CLIs, dev servers, subagents, parallel workers. Use when: task needs >30s, must monitor output over time, interactive input required, parallel execution needed, dev server to start/stop, debugger to drive, or REPL to control. Covers tmux, bash backgrounding, and nohup."
---

# Process Control

Run long-running subprocesses and interact with them over time. The core problem: `bash` tool calls are synchronous - once they return, the process is gone. This skill covers mechanisms that let processes persist across multiple tool calls so you can monitor, interact with, and control them.

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

## Agent Subprocess Control (pi, claude, etc.)

Run agent CLI as a supervised subprocess for long tasks or testing.

### Pattern: Pipe Input to Agent

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)

# Start agent with pipe input
tmux -S $SOCKET new -d -s agent-test
tmux -S $SOCKET send-keys -t agent-test:0.0 'echo "your command" | pi --continue' Enter

sleep 30
tmux -S $SOCKET capture-pane -p -J -t agent-test:0.0 -S -100
```

### Pattern: Agent with Session

```bash
# Resume specific session
tmux -S $SOCKET new -d -s agent-session
tmux -S $SOCKET send-keys -t agent-session:0.0 'pi --session /path/to/session.jsonl' Enter

# Wait for agent to be ready
sleep 10

# Send command
tmux -S $SOCKET send-keys -t agent-session:0.0 'use context_prune to analyze' Enter

# Capture response
tmux -S $SOCKET capture-pane -p -J -t agent-session:0.0 -S -200
```

### Pattern: Agent Testing Loop

```bash
# Test that context pruning works
SESSION=pi-test
tmux -S $SOCKET new -d -s $SESSION

# Send command that triggers pruning
tmux -S $SOCKET send-keys -t $SESSION:0.0 'pi --continue "use context_prune"' Enter

sleep 40

# Check output - look for prune logs
OUTPUT=$(tmux -S $SOCKET capture-pane -p -t $SESSION:0.0)

# Parse logs (pi outputs to stderr)
echo "$OUTPUT" | grep -E "(Pruned|context-manager|error)"

# Cleanup
tmux -S $SOCKET kill-session -t $SESSION
```

### Pattern: Multi-Agent Coordination

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock

# Start worker agents
for i in 1 2 3; do
  tmux -S $SOCKET new -d -s "agent-$i"
  tmux -S $SOCKET send-keys -t "agent-$i":0.0 "pi --continue 'implement task-$i'" Enter
done

# Poll each agent
for i in 1 2 3; do
  echo "=== Agent $i ==="
  tmux -S $SOCKET capture-pane -p -t "agent-$i":0.0 | tail -20
done

# Halt if one is stuck
for i in 1 2 3; do
  if tmux -S $SOCKET capture-pane -p -t "agent-$i":0.0 | grep -q "waiting"; then
    tmux -S $SOCKET send-keys -t "agent-$i":0.0 'proceed' Enter
  fi
done
```

### Pattern: Verify Agent Behavior

```bash
# Test that extension/features work correctly
tmux -S $SOCKET new -d -s verify-test

# Run agent with nohup to track output
tmux -S $SOCKET send-keys -t verify-test:0.0 '{ echo "check context status"; sleep 20; } | pi --continue 2>&1' Enter

sleep 45

# Capture full output including stderr (where extensions log)
tmux -S $SOCKET capture-pane -p -J -t verify-test:0.0 -S -300

# Look for specific extension outputs
tmux -S $SOCKET capture-pane -p -t verify-test:0.0 | grep -E "\[extension-name\]"

tmux -S $SOCKET kill-session -t verify-test
```

### Pattern: Ephemeral Agent with Log Capture

```bash
# Test agent behavior without session persistence
tmux -S $SOCKET new -d -s test-ephemeral

tmux -S $SOCKET send-keys -t test-ephemeral:0.0 'echo "test command" | pi --no-session 2>&1' Enter

sleep 30

# Capture all output (stdout + stderr)
tmux -S $SOCKET capture-pane -p -J -t test-ephemeral:0.0 -S -200

# Parse for specific patterns
if tmux -S $SOCKET capture-pane -p -t test-ephemeral:0.0 | grep -q "error"; then
  echo "Agent encountered error - investigate"
fi

tmux -S $SOCKET kill-session -t test-ephemeral
```

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

## Session File Locations

Common agent session directories:
- **pi**: `~/.pi/agent/sessions/`
- **claude**: `~/.claude/projects/`
- **other**: Check `--session-dir` flag

List recent sessions:
```bash
find ~/.pi/agent/sessions -name "*.jsonl" -mtime -7d | head -10
```

Resume specific session:
```bash
SESSION=$(find ~/.pi/agent/sessions -name "*.jsonl" -mtime -1d | head -1)
pi --session "$SESSION"
```

## Common Patterns Summary

| Use Case | Command |
|----------|---------|
| Test agent with command | `echo "command" \| pi --continue` |
| Resume session | `pi --continue` or `pi --session <path>` |
| Agent with logging | `pi --continue 2>&1 \| tee /tmp/pi.log` |
| Long agent task | `nohup pi --continue > /tmp/out.log 2>&1 &` |
| Debug agent output | `tmux` + capture-pane |
| Fork session | `pi --fork <session>` |
| No session | `pi --no-session` |
