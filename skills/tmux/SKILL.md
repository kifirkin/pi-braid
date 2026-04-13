---
name: tmux
description: Use tmux for interactive CLIs, dev environments, and agent orchestration. Spawn Pi workers, capture output, send commands.
---

# tmux

Three use cases:
1. Interactive CLI work (Python, gdb, etc.)
2. Dev environments with split panes
3. Agent orchestration (supervisor-worker pattern)

## Quickstart

```bash
mkdir -p /tmp/pi-tmux-sockets
SOCKET=/tmp/pi-tmux-sockets/pi.sock
tmux -S $SOCKET new -d -s mysession
tmux -S $SOCKET send-keys -t mysession:0.0 'python3 -q' Enter
tmux -S $SOCKET capture-pane -p -t mysession:0.0
tmux -S $SOCKET kill-session -t mysession
```

## Interactive CLI

### Start session
```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
SESSION=pi-python
tmux -S $SOCKET new -d -s $SESSION
tmux -S $SOCKET send-keys -t $SESSION:0.0 -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
```

### Send commands
```bash
tmux -S $SOCKET send-keys -t $SESSION:0.0 -l 'print(1+1)'
tmux -S $SOCKET send-keys -t $SESSION:0.0 Enter
tmux -S $SOCKET send-keys -t $SESSION:0.0 C-c
```

### Capture output
```bash
tmux -S $SOCKET capture-pane -p -J -t $SESSION:0.0 -S -50
```

### Common patterns

| Task | Command |
|------|---------|
| Python | `PYTHON_BASIC_REPL=1 python3 -q` |
| gdb | `gdb --quiet ./binary` then `set pagination off` |
| lldb | `lldb ./binary` |
| Interrupt | `send-keys C-c` |
| Send literal | `send-keys -l 'text'` |

## Dev Environments

Use the run-in-tmux script:

```bash
uv run scripts/run-in-tmux -c "npm run dev" -c "npm test" --json
```

## Agent Orchestration

One Pi agent supervises another via tmux.

### Spawn worker
```bash
tmux-coding-agent --name worker --folder ./project
```

### Send work / Monitor / Cleanup
```bash
tmux-send worker "implement feature X"
tmux-capture worker | tail -20
# Pattern response check:
OUTPUT=$(tmux-capture worker)
if echo "$OUTPUT" | grep -q "waiting for input"; then
  tmux-send worker "continue with Y"
fi
tmux-kill worker
```

### Tools reference

| Tool | Purpose |
|------|---------|
| tmux-bash | Long running processes |
| tmux-capture | Get pane output, optionally wait for pattern |
| tmux-send | Send text or keys to pane |
| tmux-kill | Destroy pane/session |
| tmux-coding-agent | Spawn Pi agent in new pane |

### Human intervention
```bash
tmux -S $SOCKET attach -t agents
Ctrl+b 0  # switch window
Ctrl+b d  # detach
```

## Socket conventions

- Directory: `${TMPDIR:-/tmp}/pi-tmux-sockets`
- Always use `-S $SOCKET` flag
- Target format: `session:window.pane` (default `:0.0`)

## Long-running tasks

For simple background tasks, use bash with `&` — no tmux needed:
```bash
npm run dev &
```

## Cleanup

```bash
tmux -S $SOCKET kill-session -t $SESSION
tmux -S $SOCKET kill-server
```
