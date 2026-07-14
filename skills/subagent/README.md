# pi-braid-subagent

Spawn, monitor, and coordinate pi instances as subagents. Each subagent gets its own context window, tools, and lifecycle — isolated from your session.

## Quick Start

```bash
# Install the skill
cp -r skills/subagent ~/.pi/agent/skills/subagent/

# Or from npm (once published)
npm install -g @earendil-works/pi-braid-subagent

# Spawn a subagent
python3 ~/.pi/agent/skills/subagent/subagent-rpc.py "Your task here"
```

## Usage

### Basic subagent

```bash
python3 subagent-rpc.py "Analyze src/auth/ for security issues"
```

### With a specific model

```bash
python3 subagent-rpc.py task.md --provider a0venice --model deepseek-v4-flash
```

### Resume from a session

```bash
# Continue the most recent session
python3 subagent-rpc.py "Continue the analysis" --resume

# Resume a specific session
python3 subagent-rpc.py "Continue the analysis" --session ~/.pi/agent/sessions/.../session.jsonl
```

### See the event stream

```bash
python3 subagent-rpc.py "List files" --verbose
```

Shows: `thinking_start`, `thinking_delta`, `toolcall_start`, `text_delta`, `agent_end`, UI requests, and the final command used.

### Parallel fan-out

```bash
for i in 1 2 3; do
  python3 subagent-rpc.py "Task $i" > /tmp/result-$i.txt 2>&1 &
done
wait
```

## How It Works

The skill uses pi's built-in `--mode rpc` flag to run pi in headless mode. The Python RPC client (`subagent-rpc.py`) handles:

- Creating a temp settings directory with `preprocessorEnabled: false` (input-polisher workaround)
- Sending JSON commands on stdin
- Reading events from stdout (thinking, tool calls, text output)
- Auto-cancelling extension UI requests
- Timeout and abort handling

## Session Resumption

The RPC protocol supports resuming from existing sessions:

- `--resume` / `-c`: Continue the most recent session
- `--session <path>`: Resume from a specific session file
- `--fork <path>`: Fork a session into a new file (via pi CLI)

## Event Stream

With `--verbose`, the RPC event stream is printed to stderr:

```
[subagent] Cmd: pi --mode rpc --no-session -e /path/to/braid --provider a0venice --model deepseek-v4-flash
[subagent] Sending prompt (54 chars)...
[subagent] message_update: thinking_start
[subagent] message_update: thinking_delta     (repeated)
[subagent] message_update: toolcall_start
[subagent] message_update: toolcall_delta     (repeated)
[subagent] message_update: thinking_end
[subagent] message_update: text_start
[subagent] message_update: text_delta         (output text)
[subagent] message_update: text_end
[subagent] UI request: notify (no title)
[subagent] # Final output printed to stdout
```

Note: The system prompt is not exposed through the RPC protocol. It is constructed by the prompt-builder extension and sent directly to the LLM. The `export_html` command can be used to get a full session export including the reconstructed conversation.

## Installation as a pi skill

1. Copy the directory to `~/.pi/agent/skills/subagent/`
2. Pi auto-discovers skills in `~/.pi/agent/skills/` and `.pi/skills/`
3. The skill is triggered when the task matches the `description` field