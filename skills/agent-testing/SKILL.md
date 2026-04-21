---
name: agent-testing
description: "Use when testing agent behavior programmatically: benchmarking, multi-trial comparisons, tool execution verification, or evaluating agent configurations. Covers: pi RPC mode event parsing, Python/JS test harness patterns, and extracting results from agent runs. Activate when building a test suite, running a benchmark, or comparing agent behaviors."
---

# Agent Testing

Test agent behavior programmatically. pi runs in RPC mode as a subprocess — you send JSON events, receive structured events back.

---

## RPC Mode

```bash
pi --mode rpc --no-session \
   --provider openrouter --model openrouter/qwen/qwen3.5-flash-02-23 \
   -e /Users/kifir/projects/agents/pi-braid
```

Key flags: `--no-extensions` for baseline · `-e <path>` for extensions · `--tools read,bash` to limit tools

---

## Event Protocol

Send one JSON event per line on stdin, read events from stdout.

**Start agent**:
```json
{"type": "prompt", "message": "Your task here"}
```

**Key event types**:

| Event | When | Your Action |
|-------|------|------------|
| `agent_start` | Agent begins | Log start time |
| `message_end` | Response complete | Extract text/code |
| `tool_execution_start/end` | Tool runs | Track what was called |
| `extension_ui_request` | Extension needs input | Respond to every one (within 2s) |
| `agent_end` | Agent finishes | Collect results |

### Responding to `extension_ui_request`

```python
if event["type"] == "extension_ui_request":
    resp = json.dumps({
        "type": "extension_ui_response",
        "id": event["id"],
        "cancelled": True
    }) + "\n"
    proc.stdin.write(resp.encode())
    proc.stdin.flush()
```

---

## Python Harness

```python
import subprocess, json, select, time

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session",
     "--provider", "openrouter", "--model", "openrouter/qwen/qwen3.5-flash-02-23",
     "-e", "/Users/kifir/projects/agents/pi-braid"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={**os.environ, "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", "")},
)

proc.stdin.write(json.dumps({"type": "prompt", "message": "task"}).encode() + b"\n")
proc.stdin.flush()

while True:
    ready, _, _ = select.select([proc.stdout], [], [], 2.0)
    if not ready:
        if proc.poll() is not None: break
        continue
    line = proc.stdout.readline()
    if not line: break
    event = json.loads(line.decode().strip())
    
    if event["type"] == "extension_ui_request":
        proc.stdin.write(json.dumps({
            "type": "extension_ui_response", "id": event["id"], "cancelled": True
        }).encode() + b"\n")
        proc.stdin.flush()
    
    if event["type"] == "message_end":
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            for block in msg.get("content", []):
                if block.get("type") == "text":
                    result = block["text"]
    
    if event["type"] == "agent_end":
        break

proc.kill(); proc.wait()
```

---

## Extract Code from Response

```python
import re
match = re.search(r'```(?:javascript|js|python)\n(.*?)```', final_text, re.DOTALL)
code = match.group(1).strip() if match else None
```

---

## Test Code Correctness

```python
import tempfile, subprocess

def test_code(code, test_code):
    tmpdir = tempfile.mkdtemp()
    with open(f"{tmpdir}/solution.js", "w") as f: f.write(code)
    with open(f"{tmpdir}/test.js", "w") as f: f.write(test_code)
    result = subprocess.run(["node", "test.js"], capture_output=True, text=True, cwd=tmpdir, timeout=10)
    return result.returncode == 0
```

---

## Timeout

```python
import signal
def timeout_handler(signum, frame): raise TimeoutError()
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(60)
try:
    # ... run agent ...
finally:
    proc.kill(); proc.wait()
```

---

## Benchmark Template

```python
import subprocess, json, os, select, re, time

MODEL = "openrouter/qwen/qwen3.5-flash-02-23"

CONFIGS = [
    {"name": "baseline", "args": ["--no-extensions", "--tools", "read,bash,edit,write"]},
    {"name": "pi-braid",   "args": ["-e", "/Users/kifir/projects/agents/pi-braid"]},
]

def run_pi(args, prompt, timeout=90):
    cmd = ["pi", "--mode", "rpc", "--no-session",
           "--provider", "openrouter", "--model", MODEL] + args
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env={**os.environ})
    proc.stdin.write(json.dumps({"type": "prompt", "message": prompt}).encode() + b"\n")
    proc.stdin.flush()
    
    result = None
    start = time.time()
    while time.time() - start < timeout:
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        if not ready:
            if proc.poll() is not None: break
            continue
        line = proc.stdout.readline()
        if not line: break
        try:
            event = json.loads(line.decode().strip())
            if event["type"] == "extension_ui_request":
                proc.stdin.write(json.dumps({
                    "type": "extension_ui_response", "id": event["id"], "cancelled": True
                }).encode() + b"\n")
                proc.stdin.flush()
            if event["type"] == "message_end":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text" and "```" in block.get("text", ""):
                        result = block["text"]
            if event["type"] == "agent_end": break
        except: pass
    
    proc.kill(); proc.wait()
    return result

def extract_code(text):
    if not text: return None
    match = re.search(r'```(?:javascript|js)\n(.*?)```', text, re.DOTALL)
    return match.group(1).strip() if match else None
```

For subprocess persistence and monitoring across trials, delegate to **process-control** for tmux patterns.
