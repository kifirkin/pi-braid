---
name: agent-testing
description: "Use when testing agent behavior programmatically: benchmarking, multi-turn tests, tool execution verification, or running agents as subprocesses for evaluation. Covers pi RPC mode, event parsing, and Python/JS test harness patterns."
---

# Agent Testing

Test agent behavior programmatically using RPC mode and subprocess control.

## Quick Start: Python Test Harness

```python
#!/usr/bin/env python3
import subprocess
import json
import os
import select
import time

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session",
     "--provider", "openrouter", "--model", "openrouter/qwen/qwen3.5-flash-02-23",
     "-e", "/Users/kifir/projects/agents/pi-braid"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env={**os.environ, "OPENROUTER_API_KEY": API_KEY},
)

# Send prompt
prompt = json.dumps({"type": "prompt", "message": "Your task here"}) + "\n"
proc.stdin.write(prompt.encode())
proc.stdin.flush()

# Read events with timeout
events = []
tool_results = []

while True:
    ready, _, _ = select.select([proc.stdout], [], [], 2.0)
    if not ready:
        if proc.poll() is not None:
            break
        continue
    
    line = proc.stdout.readline()
    if not line:
        break
    
    try:
        event = json.loads(line.decode().strip())
        etype = event.get("type")
        events.append(etype)
        
        # Handle extension UI requests (must respond!)
        if etype == "extension_ui_request":
            resp = json.dumps({
                "type": "extension_ui_response",
                "id": event.get("id"),
                "cancelled": True
            }) + "\n"
            proc.stdin.write(resp.encode())
            proc.stdin.flush()
        
        # Track tool execution
        if etype == "tool_execution_end":
            tool_results.append({
                "tool": event.get("toolName"),
                "success": not event.get("isError")
            })
        
        # Get final response
        if etype == "message_end":
            msg = event.get("message", {})
            if msg.get("role") == "assistant":
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        final_text = block.get("text", "")
        
        if etype == "agent_end":
            break
    except:
        pass

proc.kill()
proc.wait()

print(f"Events: {sorted(set(events))}")
print(f"Tools executed: {len(tool_results)}")
```

## Key Event Types

| Event | When | Purpose |
|-------|------|---------|
| `agent_start` | Agent begins | Log start time |
| `turn_start` | New turn begins | Track turns |
| `message_start/end` | Message boundaries | Extract content |
| `message_update` | Streaming deltas | Real-time updates |
| `tool_execution_start/update/end` | Tool runs | Track execution |
| `extension_ui_request` | Extension needs input | Must respond quickly |
| `turn_end` | Turn completes | Check stopReason |
| `agent_end` | Agent finishes | Collect final response |

## Tool Execution Tracking

```python
tool_calls = []
tool_results = []

for line in proc.stdout:
    event = json.loads(line)
    
    if event["type"] == "tool_execution_start":
        tool_calls.append({
            "id": event["toolCallId"],
            "name": event["toolName"],
            "args": event["args"]
        })
    
    if event["type"] == "tool_execution_end":
        tool_results.append({
            "id": event["toolCallId"],
            "name": event["toolName"],
            "content": event["result"],
            "isError": event.get("isError")
        })
```

## Multi-turn: Send Tool Results Back

Pi handles tool execution internally - you don't need to feed results back. Just respond to `extension_ui_request` events and pi will execute tools automatically.

```python
# Critical: Always respond to extension UI requests
if event["type"] == "extension_ui_request":
    resp = json.dumps({
        "type": "extension_ui_response",
        "id": event["id"],
        "cancelled": True  # Or provide actual response
    }) + "\n"
    proc.stdin.write(resp.encode())
    proc.stdin.flush()
```

## Parse Final Response

```python
final_text = None
for line in proc.stdout:
    event = json.loads(line)
    
    if event["type"] == "message_end":
        msg = event["message"]
        if msg["role"] == "assistant":
            for block in msg["content"]:
                if block["type"] == "text":
                    final_text = block["text"]
                    break

# Extract code from markdown blocks
import re
match = re.search(r'```(?:javascript|js|python)\n(.*?)```', final_text, re.DOTALL)
if match:
    code = match.group(1)
```

## Timeout Patterns

```python
import signal

def timeout_handler(signum, frame):
    raise TimeoutError()

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(60)  # 60 second timeout

try:
    # ... run agent ...
finally:
    proc.kill()
    proc.wait()
```

## Test Code Correctness

```python
import tempfile
import subprocess

def test_code(code, test_code):
    tmpdir = tempfile.mkdtemp()
    
    # Write solution
    with open(f"{tmpdir}/solution.js", "w") as f:
        f.write(code)
    
    # Write tests
    with open(f"{tmpdir}/test.js", "w") as f:
        f.write(test_code)
    
    # Run with Node
    result = subprocess.run(
        ["node", "test.js"],
        capture_output=True,
        text=True,
        cwd=tmpdir,
        timeout=10
    )
    
    return result.returncode == 0 and "PASS" in result.stdout
```

## Extract System Prompt

To see what system prompt pi uses:

```python
# In a new session, send simple prompt then check session file
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", ...],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)

prompt = json.dumps({"type": "prompt", "message": "test"}) + "\n"
proc.stdin.write(prompt.encode())
proc.stdin.flush()

# Read agent_start event
for line in proc.stdout:
    event = json.loads(line)
    if event["type"] == "agent_start":
        # System prompt is injected in the first turn
        break

proc.kill()
```

## Common Configurations

### Baseline (no extensions)
```bash
pi --mode rpc --no-extensions --tools read,bash,edit,write
```

### With pi-braid
```bash
pi --mode rpc --no-session -e /Users/kifir/projects/agents/pi-braid
```

### With specific model
```bash
pi --mode rpc --provider openrouter --model openrouter/anthropic/claude-sonnet-4
```

## Benchmark Template

```python
#!/usr/bin/env python3
"""Multi-trial benchmark comparing configurations"""

import subprocess
import json
import os
import select
import re

MODEL = "openrouter/qwen/qwen3.5-flash-02-23"

CONFIGS = [
    {"name": "baseline", "args": ["--no-extensions", "--tools", "read,bash,edit,write"]},
    {"name": "pi-braid", "args": ["-e", "/Users/kifir/projects/agents/pi-braid"]},
]

TASKS = [
    {"id": "task1", "prompt": "...", "test": "..."},
]

TRIALS = 5

def run_pi(args, prompt, timeout=90):
    cmd = ["pi", "--mode", "rpc", "--no-session", 
           "--provider", "openrouter", "--model", MODEL] + args
    
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env={**os.environ}
    )
    
    prompt_json = json.dumps({"type": "prompt", "message": prompt}) + "\n"
    proc.stdin.write(prompt_json.encode())
    proc.stdin.flush()
    
    final_text = None
    start = time.time()
    
    while time.time() - start < timeout:
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        if not ready:
            if proc.poll() is not None:
                break
            continue
        
        line = proc.stdout.readline()
        if not line:
            break
        
        try:
            event = json.loads(line.decode().strip())
            etype = event.get("type")
            
            if etype == "extension_ui_request":
                resp = json.dumps({
                    "type": "extension_ui_response",
                    "id": event.get("id"),
                    "cancelled": True
                }) + "\n"
                proc.stdin.write(resp.encode())
                proc.stdin.flush()
            
            if etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if block.get("type") == "text" and "```" in block.get("text", ""):
                            final_text = block.get("text")
            
            if etype == "agent_end":
                break
        except:
            pass
    
    proc.kill()
    proc.wait()
    return final_text

def extract_code(text):
    if not text:
        return None
    match = re.search(r'```(?:javascript|js)\n(.*?)```', text, re.DOTALL)
    return match.group(1).strip() if match else None

def main():
    for config in CONFIGS:
        for task in TASKS:
            for trial in range(TRIALS):
                text = run_pi(config["args"], task["prompt"])
                code = extract_code(text)
                # test code...
```

## Debugging Tips

1. **Check stderr** for extension logs: `2>&1` captures extension output
2. **Count events** to understand flow: `events.count("tool_execution_end")`
3. **Check stopReason** in message_end for errors
4. **Extension UI timeout** - respond within 2s or agent waits

## Resources

- RPC protocol: `docs/rpc.md`
- Agent loop: `packages/agent/src/agent-loop.ts`
- Extension types: `src/core/extensions/types.ts`
