---
name: agent-testing
description: "Use when testing agent behavior programmatically: benchmarking, multi-trial comparisons, tool execution verification, or evaluating agent configurations. Covers: pi RPC mode event parsing, Python/JS test harness patterns, and extracting results from agent runs. Activate when building a test suite, running a benchmark, or comparing agent behaviors."
---

# Agent Testing

Test agent behavior programmatically. pi runs in RPC mode as a subprocess — you send JSON events, receive structured events back.

---

## RPC Mode

```bash
# Replace /path/to/your-extension with your extension path
# IMPORTANT: input-polisher blocks prompts in RPC mode. Use temp settings with preprocessorEnabled=false.
# Also: discover available models first with `pi --list-models`
TEMP_PI_DIR=$(mktemp -d)
python3 -c "import json; d=json.load(open('$HOME/.pi/agent/settings.json')); d['preprocessorEnabled']=False; json.dump(d, open('$TEMP_PI_DIR/settings.json','w'), indent=2)"

PI_CODING_AGENT_DIR=$TEMP_PI_DIR pi --mode rpc --no-session \
   --provider <provider> --model <model> \
   -e /path/to/your-extension
```

Key flags: `--no-extensions` for baseline · `-e <path>` for extensions · `--tools read,bash` to limit tools

**Discovering models**: Run `pi --list-models 2>/dev/null | grep -v 'Warning\|INFO'` to see available providers and models in your setup. Use `--no-extensions` with built-in providers (anthropic, openai, google, openrouter) or load extensions (`-e <path>`) for custom providers.

---

## Event Protocol

Send one JSON event per line on stdin, read events from stdout.

**Start agent**:

```json
{ "type": "prompt", "message": "Your task here" }
```

**Key event types**:

| Event                      | When                  | Your Action                      |
| -------------------------- | --------------------- | -------------------------------- |
| `agent_start`              | Agent begins          | Log start time                   |
| `message_end`              | Response complete     | Extract text/code                |
| `tool_execution_start/end` | Tool runs             | Track what was called            |
| `extension_ui_request`     | Extension needs input | Respond to every one (within 2s) |
| `agent_end`                | Agent finishes        | Collect results                  |

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
import subprocess, json, select, time, os, tempfile

# Create temp settings with preprocessorEnabled=false (prevents input-polisher blocking)
temp_dir = tempfile.mkdtemp()
import pathlib
settings = json.load(open(os.path.expanduser("~/.pi/agent/settings.json")))
settings["preprocessorEnabled"] = False
pathlib.Path(temp_dir, "settings.json").write_text(json.dumps(settings, indent=2))

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session",
     "--provider", PROVIDER, "--model", MODEL,  # see `pi --list-models`
     "-e", "/path/to/your-extension"],  # set to your extension path
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={**os.environ, "PI_CODING_AGENT_DIR": temp_dir},
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

````python
import re
match = re.search(r'```(?:javascript|js|python)\n(.*?)```', final_text, re.DOTALL)
code = match.group(1).strip() if match else None
````

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

````python
import subprocess, json, os, select, re, time

MODEL = "<model>"  # see `pi --list-models`
PROVIDER = "<provider>"

CONFIGS = [
    {"name": "baseline", "args": ["--no-extensions", "--tools", "read,bash,edit,write"]},
    {"name": "with-extensions", "args": ["-e", "/path/to/your-extension"]},  # set to your extension path
]

def run_pi(args, prompt, timeout=90):
    cmd = ["pi", "--mode", "rpc", "--no-session",
           "--provider", PROVIDER, "--model", MODEL] + args
    # Create temp settings with preprocessorEnabled=false
    temp_dir = tempfile.mkdtemp()
    settings = json.load(open(os.path.expanduser("~/.pi/agent/settings.json")))
    settings["preprocessorEnabled"] = False
    open(f"{temp_dir}/settings.json", "w").write(json.dumps(settings, indent=2))
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            env={**os.environ, "PI_CODING_AGENT_DIR": temp_dir})
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
````

For subprocess persistence and monitoring across trials, delegate to **process-control** for tmux patterns.
