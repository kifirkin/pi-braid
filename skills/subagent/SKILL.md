---
name: subagent
description: "Spawn, monitor, and coordinate pi instances as subagents. Covers: RPC-based task delegation, parallel fan-out/fan-in, result extraction, and error recovery. Activate when a task benefits from isolated context windows, parallel execution, or delegating to a specialized agent configuration."
---

# Subagent Orchestration

Delegate work to separate pi processes. Each subagent gets its own context window, tools, and lifecycle — isolated from your session.

**Path convention**: All commands below use `$PI_EXTENSION_PATH` for your extension installation path. Set it once:

```bash
PI_EXTENSION_PATH="${PI_EXTENSION_PATH:-/path/to/your-extension}"
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

### Mode 1: RPC Subprocess (structured, recommended)

Spawn pi in RPC mode as a subprocess. Send JSON commands on stdin, read events from stdout. Best for: extracting structured results, benchmarks, tasks with a clear done condition.

**Quick spawn** (via the Python RPC client):

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md
```

Write the task prompt to `task.md` first. The client handles the RPC protocol, extension UI requests, and output extraction.

**With a specific model** (discover available models first with `pi --list-models`):

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md --provider <provider> --model <model>
```

**Without extensions** (lean, uses pi-core built-in providers only):

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md \
  --no-extensions --provider openrouter --model "google/gemini-flash-latest"
```

### Mode 2: tmux Session (interactive, for long-running tasks)

Spawn pi as a tmux session. Send input via `send-keys`, read output via `capture-pane`. Best for: long tasks, tasks needing monitoring, interactive debugging by a subagent.

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)

# Spawn — MUST use temp PI_CODING_AGENT_DIR with preprocessorEnabled=false
# to prevent input-polisher from blocking in non-interactive contexts.
TEMP_PI_DIR=$(mktemp -d)
cat ~/.pi/agent/settings.json | python3 -c \
  "import json,sys; d=json.load(sys.stdin); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"

tmux -S $SOCKET new-session -d -s "worker-1" \
  "cd $PI_EXTENSION_PATH && PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi -e $PI_EXTENSION_PATH --no-session 2>&1 | tee /tmp/worker-1.log"

# Send task
tmux -S $SOCKET send-keys -t "worker-1:0.0" 'Implement the foo module in src/foo.ts' Enter

# Check progress (last 50 lines)
tmux -S $SOCKET capture-pane -p -J -t "worker-1:0.0" -S -50

# Check full log
cat /tmp/worker-1.log

# Kill when done
tmux -S $SOCKET kill-session -t "worker-1"
rm -rf $TEMP_PI_DIR
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

## Critical: Input Polisher Workaround

Extensions like `input-polisher` intercept user prompts in RPC mode. It classifies the input, then returns `{ action: "handled" }` and waits for a second Enter press — which never comes in headless mode. This causes the prompt to silently never reach the model.

**Solution**: The Python RPC client (`subagent-rpc.py`) automatically creates a temp `PI_CODING_AGENT_DIR` with `preprocessorEnabled: false` in settings.json. This disables the input polisher for the subagent session.

If you're writing your own RPC client or using tmux, you must do this manually:

```bash
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"
export PI_CODING_AGENT_DIR="$TEMP_PI_DIR"
# ... spawn pi ...
# Clean up: rm -rf $TEMP_PI_DIR
```

**Note**: The input-polisher reads settings from `PI_CODING_AGENT_DIR` (fixed in v3.10+, previously hardcoded to `~/.pi/agent/settings.json`). If running an older version, you must temporarily edit `~/.pi/agent/settings.json` directly.

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
# Use --provider/--model matching your setup (check `pi --list-models`)
for i in 1 2 3; do
  python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py \
    /tmp/task-$i.md \
    > /tmp/result-$i.txt 2>&1 &
done

# Wait for all
wait

# Collect results
for i in 1 2 3; do
  echo "=== Task $i ==="
  cat /tmp/result-$i.txt
done
```

---

## RPC Protocol (for custom orchestration)

When the Python client doesn't cover your needs, interact with RPC directly.

**Start pi** (always use temp settings with preprocessorEnabled=false):

```bash
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"

PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi --mode rpc --no-session \
  -e $PI_EXTENSION_PATH \
  --provider <provider> --model <model>  # see `pi --list-models`
```

**Send a task** (stdin):

```json
{ "type": "prompt", "message": "Your task description here" }
```

**Key events to handle** (stdout):

| Event                              | Action                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `extension_ui_request` (dialog)    | Respond with `cancelled: true` — pi blocks until you do                |
| `extension_ui_request` (notify etc)| Ignore — fire-and-forget, no response needed                           |
| `message_update` with `text_delta` | Accumulate text output                                                 |
| `agent_end`                        | Task complete — extract final message                                  |

**Respond to UI request** (must respond within 2s for dialog methods):

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

**Full protocol reference**: See pi's `docs/rpc.md` for all commands, events, and types.

---

## Subagent Configurations

Different tasks benefit from different tool sets and models.

### Lean subagent (fast, cheap, no extensions)

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md \
  --no-extensions --provider openrouter --model "google/gemini-flash-latest" \
  --tools read,bash,edit,write,find,grep
```

Use for: simple code tasks, file transformations, grep-heavy analysis.

**Note**: Without extensions (`--no-extensions`), only pi-core built-in providers work (anthropic, openai, google, openrouter). Custom providers registered by extension packages require those extensions to be loaded.

### Full subagent (with extensions)

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md \
  --provider <provider> --model <model>  # see `pi --list-models`
```

Use for: complex reasoning, multi-step tasks, tasks needing memory/tools from extensions.

### Research subagent (web access)

```bash
python3 $PI_EXTENSION_PATH/scripts/subagent-rpc.py task.md \
  --provider <provider> --model <model> \
  --tools read,bash,write,web_fetch
```

Use for: literature review, fact-checking, web research.

---

## Discovering Available Models

Before spawning a subagent, check which models are available:

```bash
pi --list-models 2>/dev/null | grep -v "Warning\|INFO"
```

Pick a cheap/fast model for trivial tasks, a stronger model for complex reasoning. The `--provider` and `--model` flags control which LLM the subagent uses.

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
- For file modification tasks: include exact search/replace strings
- Include verification commands the subagent should run

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

### Subagent produces no output

Most common cause: input-polisher blocking the prompt. Verify the temp settings dir has `preprocessorEnabled: false`. Check:

```bash
cat $PI_CODING_AGENT_DIR/settings.json | grep preprocessorEnabled
# Should show: "preprocessorEnabled": false
```

### Subagent crashes

Check stderr or log file for the error. Common causes:

- Model rate limit → retry with backoff
- Context overflow → use `--no-extensions` or a leaner model
- Missing API key → ensure env vars are set in the spawn command
- Provider not found → without extensions, only built-in providers work

### Result quality is poor

Re-run with:

1. A more specific task prompt (add constraints, examples)
2. A stronger model
3. Explicit output format ("return valid JSON array")

---

## Cleanup

Always clean up subagent processes. Failed cleanup leaks tmux sessions and orphan processes.

```bash
# Kill all worker sessions
tmux -S $SOCKET list-sessions 2>/dev/null | grep "^worker-" | cut -d: -f1 | while read s; do
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

| Component           | Path                        | Purpose                                        |
| ------------------- | --------------------------- | ---------------------------------------------- |
| Python RPC client   | `scripts/subagent-rpc.py`   | Full RPC client with UI handling + temp settings |
| RPC protocol docs   | pi `docs/rpc.md`            | Full RPC command/event reference               |

---

## Known Issues (2026-06-30)

- **`--print` / `-p` mode**: Does not work with extension packages loaded. The process exits immediately without calling the model. Use `--mode rpc` instead.
- **Model patterns**: Model names with `~` prefix (e.g. `~google/gemini-flash-latest`) require the model registry from extensions. Without extensions, use the bare model ID.
- **Custom providers**: Provider extension packages register custom providers (e.g. Venice, OpenRouter-compatible proxies, etc.). Without the relevant extension loaded, only pi-core built-in providers (anthropic, openai, google, openrouter) are available. Use `pi --list-models` to see what's available in your setup.