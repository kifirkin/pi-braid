---
name: subagent
description: "Spawn, monitor, and coordinate pi instances as subagents. Covers: RPC-based task delegation, parallel fan-out/fan-in, result extraction, session resumption, and error recovery. Activate when a task benefits from isolated context windows, parallel execution, or delegating to a specialized agent configuration."
---

# Subagent Orchestration

Delegate work to separate pi processes. Each subagent gets its own context window, tools, and lifecycle — isolated from your session.

**Finding bundled scripts**: This skill ships with `subagent-rpc.py` in the same directory. The skill's location is available in the prompt context as `<location>`. Resolve the script path relative to `<skill_dir>` (the directory containing SKILL.md):

```bash
# If skill is installed at ~/.pi/agent/skills/subagent/SKILL.md:
SKILL_DIR=~/.pi/agent/skills/subagent
python3 "$SKILL_DIR/subagent-rpc.py" "Your task here"
```

If you're in the Braid project, the skill is at `skills/subagent/`:

```bash
python3 skills/subagent/subagent-rpc.py "Your task here"
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

**Quick spawn** (via the bundled Python RPC client):

```bash
python3 <skill_dir>/subagent-rpc.py "Your task description here"
```

Or write the task to a file:

```bash
python3 <skill_dir>/subagent-rpc.py task.md
```

**With a specific model**:

```bash
python3 <skill_dir>/subagent-rpc.py task.md --provider a0venice --model deepseek-v4-flash
```

**Without extensions** (lean, uses pi-core built-in providers only):

```bash
python3 <skill_dir>/subagent-rpc.py task.md \
  --no-extensions --provider openrouter --model "google/gemini-flash-latest"
```

### Mode 2: tmux Session (interactive, for long-running tasks)

Spawn pi as a tmux session. Send input via `send-keys`, read output via `capture-pane`. Best for: long tasks, tasks needing monitoring, interactive debugging by a subagent.

```bash
SOCKET=/tmp/pi-tmux-sockets/pi.sock
mkdir -p $(dirname $SOCKET)
SKILL_DIR=<skill_dir>

# Spawn — MUST use temp PI_CODING_AGENT_DIR with preprocessorEnabled=false
# to prevent input-polisher from blocking in non-interactive contexts.
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"

tmux -S $SOCKET new-session -d -s "worker-1" \
  "cd $PWD && PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi --no-session 2>&1 | tee /tmp/worker-1.log"

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

## Session Resumption

Subagents normally start from scratch (fresh context). To resume from a previous session:

### Resume most recent session

```bash
python3 <skill_dir>/subagent-rpc.py "Continue the analysis" --resume
```

This uses pi's `-c` flag to continue the most recent session.

### Resume a specific session

```bash
python3 <skill_dir>/subagent-rpc.py "Continue the analysis" --session ~/.pi/agent/sessions/.../session.jsonl
```

### Fork a session into a new file

```bash
# Fork from the CLI before spawning
pi --fork <session-path> --session <new-session-path>

# Then spawn the subagent with the forked session
python3 <skill_dir>/subagent-rpc.py "Continue the analysis" --session <new-session-path>
```

### RPC commands for session management

When using the RPC protocol directly (not via the Python client), you can manage sessions with these commands:

```json
{"type": "new_session", "parentSession": "<session-path>"}
{"type": "switch_session", "sessionPath": "<session-path>"}
{"type": "fork", "entryId": "<entry-id>"}
{"type": "clone"}
{"type": "get_session_stats"}
{"type": "get_entries"}
{"type": "get_tree"}
{"type": "get_messages"}
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

---

## Event Stream (What Happens Inside)

With `--verbose`, the bundled RPC client prints the event stream to stderr:

```
[subagent] Cmd: pi --mode rpc --no-session -e /path/to/braid --provider a0venice --model deepseek-v4-flash
[subagent] Env: PI_CODING_AGENT_DIR=/tmp/pi-subagent-xxxxxx
[subagent] Sending prompt (54 chars)...
[subagent] message_update: thinking_start
[subagent] message_update: thinking_delta     (one per thinking chunk, may be many)
[subagent] message_update: toolcall_start
[subagent] message_update: toolcall_delta     (one per tool call argument chunk)
[subagent] message_update: toolcall_end
[subagent] message_update: thinking_end
[subagent] message_update: text_start
[subagent] message_update: text_delta         (output text chunks — accumulate these)
[subagent] message_update: text_end
[subagent] UI request: notify (no title)      (fire-and-forget, ignored)
[subagent] # Final assistant text printed to stdout
[subagent] Timeout (120s) — sending abort...
```

### Event types

| Event | Meaning | What to do |
|-------|---------|-----------|
| `thinking_start` | Model started thinking | Reset thinking buffer |
| `thinking_delta` | Thinking chunk | Append to thinking buffer |
| `thinking_end` | Thinking complete | Thinking buffer is ready |
| `toolcall_start` | Model wants to call a tool | Reset tool buffer |
| `toolcall_delta` | Tool call argument chunk | Append to tool buffer |
| `toolcall_end` | Tool call arguments complete | Parse and execute tool |
| `text_start` | Model started producing text | Reset text buffer |
| `text_delta` | Text chunk | Append to text buffer |
| `text_end` | Text complete | Text buffer is the final output |
| `agent_end` | Agent turn finished | Extract final message |
| `extension_ui_request` | Extension wants UI interaction | Auto-cancelled by client |
| `agent_settled` | All agent activity complete | Task is done |

### System prompt visibility

**The system prompt is NOT exposed through the RPC protocol.** It is constructed by the prompt-builder extension and sent directly to the LLM. It does not appear in session messages or the event stream.

To see the system prompt after a session:

1. Use `export_html` to get a full session export (includes reconstructed conversation):
   ```bash
   # After the subagent finishes, send an export command
   echo '{"type": "export_html", "outputPath": "/tmp/session.html"}' | \
     PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi --mode rpc ...
   ```
2. The HTML export includes the full conversation but is formatted for human reading, not structured parsing.

---

## Critical: Input Polisher Workaround

Extensions like `input-polisher` intercept user prompts in RPC mode. It classifies the input, then returns `{ action: "handled" }` and waits for a second Enter press — which never comes in headless mode. This causes the prompt to silently never reach the model.

**Solution**: The bundled Python RPC client (`subagent-rpc.py`) automatically creates a temp `PI_CODING_AGENT_DIR` with `preprocessorEnabled: false` in settings.json. This disables the input polisher for the subagent session.

If you're writing your own RPC client or using tmux, you must do this manually:

```bash
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"
export PI_CODING_AGENT_DIR="$TEMP_PI_DIR"
# ... spawn pi ...
# Clean up: rm -rf $TEMP_PI_DIR
```

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
SKILL_DIR=<skill_dir>
for i in 1 2 3; do
  python3 "$SKILL_DIR/subagent-rpc.py" \
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

**Start pi** (always use temp settings with `preprocessorEnabled=false`):

```bash
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"

PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi --mode rpc --no-session \
  --provider a0venice --model deepseek-v4-flash
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
python3 <skill_dir>/subagent-rpc.py task.md \
  --no-extensions --provider openrouter --model "google/gemini-flash-latest" \
  --tools read,bash,edit,write,find,grep
```

Use for: simple code tasks, file transformations, grep-heavy analysis.

**Note**: Without extensions (`--no-extensions`), only pi-core built-in providers work (anthropic, openai, google, openrouter). Custom providers registered by extension packages require those extensions to be loaded.

### Full subagent (with extensions)

```bash
python3 <skill_dir>/subagent-rpc.py task.md \
  --provider a0venice --model deepseek-v4-flash
```

Use for: complex reasoning, multi-step tasks, tasks needing memory/tools from extensions.

### Research subagent (web access)

```bash
python3 <skill_dir>/subagent-rpc.py task.md \
  --tools read,bash,write,web_fetch
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

## Bundled Files

| File               | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `SKILL.md`         | This skill file (loaded by pi)                 |
| `subagent-rpc.py`  | Python RPC client with UI handling + temp settings |
| `package.json`     | npm package metadata for sharing               |
| `README.md`        | Standalone usage documentation                 |

---

## Known Issues

- **`--print` / `-p` mode**: Does not work with extension packages loaded. The process exits immediately without calling the model. Use `--mode rpc` instead.
- **Model patterns**: Model names with `~` prefix (e.g. `~google/gemini-flash-latest`) require the model registry from extensions. Without extensions, use the bare model ID.
- **Custom providers**: Provider extension packages register custom providers (e.g. Venice, OpenRouter-compatible proxies, etc.). Without the relevant extension loaded, only pi-core built-in providers (anthropic, openai, google, openrouter) are available.
- **System prompt**: Not exposed through the RPC protocol. Use `export_html` for a human-readable session export.