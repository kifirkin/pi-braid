---
name: subagent
description: "Spawn, monitor, and coordinate pi instances as subagents. Covers: RPC-based task delegation, parallel fan-out/fan-in, result extraction, and error recovery. Activate when a task benefits from isolated context windows, parallel execution, or delegating to a specialized agent configuration."
---

# Subagent Orchestration

Delegate work to separate pi processes. Each subagent gets its own context window, tools, and lifecycle — isolated from your session.

**Path convention**: All commands below use `$BRAID_ROOT` for the pi-braid installation path. Set it once:

```bash
BRAID_ROOT="${BRAID_ROOT:-$HOME/projects/agents/pi-braid}"
```

---

## When to Spawn a Subagent

| Situation                                     | Subagent? | Why                                              |
| --------------------------------------------- | --------- | ------------------------------------------------ |
| Parallel research on 3+ topics                | Yes       | Independent context, concurrent execution        |
| Task needs a clean context (no contamination) | Yes       | Fresh session, no accumulated state              |
| Exploring risky code changes                  | Yes       | Isolation — failure doesn't pollute your session |
| Single straightforward task                   | No        | Overhead exceeds benefit                         |
| Task requires your accumulated context        | No        | Subagent starts from scratch                     |

**Rule of thumb**: If the task is self-contained and benefits from parallelism or isolation, spawn.

---

## Two Modes

### Mode 1: RPC Subprocess (structured, best for programmatic tasks)

Spawn pi in RPC mode as a subprocess. Send JSON commands on stdin, read events from stdout. Best for: extracting structured results, benchmarks, tasks with a clear done condition.

**Quick spawn** (via the existing Python client):

```bash
python3 $BRAID_ROOT/scripts/subagent-rpc.py task.md
```

Write the task prompt to `task.md` first. The client handles RPC protocol, extension UI requests, and output extraction.

**With a specific model**:

```bash
python3 $BRAID_ROOT/scripts/subagent-rpc.py task.md openrouter/qwen/qwen3.5-flash-02-23
```

### Mode 2: tmux Session (interactive, best for long-running tasks)

Spawn pi as a tmux session. Send input via `send-keys`, read output via `capture-pane`. Best for: long tasks, tasks needing monitoring, interactive debugging by a subagent.

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)

# Spawn
tmux -S $SOCKET new-session -d -s "worker-1" \
  "pi -e $BRAID_ROOT --no-session 2>&1 | tee /tmp/worker-1.log"

# Send task
tmux -S $SOCKET send-keys -t "worker-1:0.0" 'Implement the foo module in src/foo.ts' Enter

# Check progress (last 50 lines)
tmux -S $SOCKET capture-pane -p -J -t "worker-1:0.0" -S -50

# Check full log
cat /tmp/worker-1.log

# Kill when done
tmux -S $SOCKET kill-session -t "worker-1"
```

### Choosing

| Need                             | Mode           |
| -------------------------------- | -------------- |
| Structured result extraction     | RPC subprocess |
| Benchmark / automated testing    | RPC subprocess |
| Long task (>5 min)               | tmux session   |
| Want to monitor progress         | tmux session   |
| Parallel fan-out with collection | RPC subprocess |
| Interactive subagent             | tmux session   |

---

## Parallel Fan-Out / Fan-In

Run multiple independent tasks concurrently, then collect results.

```bash
# Write task files
cat > /tmp/task-1.md << 'EOF'
Analyze the authentication module in src/auth/ for security vulnerabilities.
Return a JSON list of findings with severity and file location.
EOF

cat > /tmp/task-2.md << 'EOF'
Review the database migration scripts in migrations/ for data loss risks.
Return a JSON list of risks with severity and migration file.
EOF

cat > /tmp/task-3.md << 'EOF'
Check the API endpoints in src/routes/ for missing input validation.
Return a JSON list of gaps with endpoint and missing validation type.
EOF

# Run in parallel (background)
for i in 1 2 3; do
  python3 $BRAID_ROOT/scripts/subagent-rpc.py \
    /tmp/task-$i.md openrouter/qwen/qwen3.5-flash-02-23 \
    > /tmp/result-$i.txt 2>&1 &
done

# Wait for all
wait

# Collect results
for i in 1 2 3; do
  echo "=== Task $i ==="
  tail -20 /tmp/result-$i.txt
done
```

---

## RPC Protocol (for custom orchestration)

When the Python client doesn't cover your needs, interact with RPC directly.

**Start pi**:

```bash
pi --mode rpc --no-session \
   -e $BRAID_ROOT \
   --provider openrouter --model openrouter/qwen/qwen3.5-flash-02-23
```

**Send a task** (stdin):

```json
{ "type": "prompt", "message": "Your task description here" }
```

**Key events to handle** (stdout):

| Event                              | Action                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `extension_ui_request`             | Respond immediately (cancel or provide value) — pi blocks until you do |
| `message_update` with `text_delta` | Accumulate text output                                                 |
| `agent_end`                        | Task complete — extract final message                                  |

**Respond to UI request** (must respond within 2s):

```json
{ "type": "extension_ui_response", "id": "<id from request>", "cancelled": true }
```

**Abort a running task**:

```json
{ "type": "abort" }
```

**Get the last assistant text** (after task completes):

```json
{ "type": "get_last_assistant_text" }
```

---

## Subagent Configurations

Different tasks benefit from different tool sets and models.

### Lean subagent (fast, cheap, code-focused)

```bash
pi --mode rpc --no-session --no-extensions \
   --tools read,bash,edit,write,find,grep \
   --provider openrouter --model openrouter/qwen/qwen3.5-flash-02-23
```

Use for: simple code tasks, file transformations, grep-heavy analysis.

### Full subagent (with pi-braid extensions)

```bash
pi --mode rpc --no-session \
   -e $BRAID_ROOT \
   --provider openrouter --model openrouter/qwen/qwen3.5-flash-02-23
```

Use for: complex reasoning, multi-step tasks, tasks needing memory/tools from pi-braid.

### Research subagent (web access, no code tools)

```bash
pi --mode rpc --no-session \
   -e $BRAID_ROOT \
   --tools read,bash,write,web_fetch \
   --provider openrouter --model openrouter/qwen/qwen3.5-flash-02-23
```

Use for: literature review, fact-checking, web research.

---

## Task Prompt Guidelines

Subagents start from scratch — your task prompt is their entire context. Write accordingly.

**Good task prompt** — specific, scoped, has clear done condition:

```
Analyze src/auth/login.ts and src/auth/register.ts for security vulnerabilities.
For each finding, report:
1. File and line number
2. Vulnerability type (OWASP category)
3. Severity (critical/high/medium/low)
4. Suggested fix (one sentence)
Format as a markdown table.
```

**Bad task prompt** — vague, unbounded, no clear output:

```
Look at the auth code and tell me if anything is wrong.
```

**Structuring tips**:

- State the exact files/paths to examine
- Define the output format
- Set scope boundaries ("only in src/auth/", "max 10 findings")
- Include any constraints ("do not modify files", "read-only analysis")

---

## Error Recovery

### Subagent hangs (no output for 60s+)

RPC mode: send `{"type": "abort"}`, then retry with a clearer prompt.

tmux mode:

```bash
tmux -S $SOCKET send-keys -t "worker-1:0.0" C-c
# Wait 2s, then kill if still running
tmux -S $SOCKET kill-session -t "worker-1"
```

### Subagent crashes

Check stderr or log file for the error. Common causes:

- Model rate limit → retry with backoff
- Context overflow → use `--no-extensions` or a leaner model
- Missing API key → ensure env vars are set in the spawn command

### Result quality is poor

Re-run with:

1. A more specific task prompt (add constraints, examples)
2. A stronger model
3. Explicit output format ("return valid JSON array")

---

## Cleanup

Always clean up subagent processes. Failed cleanup leaks tmux sessions and orphan processes.

```bash
# Kill all braid worker sessions
tmux -S $SOCKET list-sessions 2>/dev/null | grep "^braid-" | cut -d: -f1 | while read s; do
  tmux -S $SOCKET kill-session -t "$s"
done

# Kill orphan pi processes (older than 10 min)
ps aux | grep "pi --mode rpc" | grep -v grep | awk '{print $2}' | while read pid; do
  if [ "$(ps -o etimes= -p $pid 2>/dev/null | tr -d ' ')" -gt 600 ]; then
    kill $pid 2>/dev/null
  fi
done
```

---

## Existing Infrastructure

| Component           | Path                       | Purpose                             |
| ------------------- | -------------------------- | ----------------------------------- |
| Python RPC client   | `scripts/subagent-rpc.py`  | Full RPC client with event handling |
| DaemonOrchestrator  | `braid-os/daemon/index.ts` | TypeScript tmux worker manager      |
| Daemon shell script | `braid-os/braid-daemon.sh` | CLI wrapper for daemon lifecycle    |
| RPC protocol docs   | pi `docs/rpc.md`           | Full RPC command/event reference    |
