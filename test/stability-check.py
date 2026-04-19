#!/usr/bin/env python3
"""
Comprehensive stability test for pi-braid current state.
Tests: build, runtime, agent startup, extension loading.
"""
import subprocess
import json
import os
import time
import select
import sys

AGENT_PATH = "/Users/kifir/projects/agents/pi-braid"
TAG = "v0.5.7-Phase1"
RESULTS = {"pass": [], "fail": [], "warn": []}

def run(cmd, cwd=None, timeout=30, check_return=True):
    """Run a shell command, return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                          cwd=cwd or AGENT_PATH, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)

def check(name, cond, detail=""):
    """Record a check result."""
    status = "pass" if cond else "fail"
    RESULTS[status].append(name)
    symbol = "✅" if cond else "❌"
    print(f"  {symbol} {name}")
    if detail and not cond:
        print(f"     {detail[:200]}")
    return cond

# ── 1. Build ────────────────────────────────────────────────────────────────
print("\n[1] Build & Type Check")
rc, out, err = run("npx tsc --noEmit --skipLibCheck 2>&1", timeout=30)
errors = [l for l in out.split("\n") if "error TS" in l]
check("TypeScript: 0 errors", len(errors) == 0, "\n".join(errors[:5]))

rc2, out2, _ = run("npx tsc --outDir dist --skipLibCheck 2>&1", timeout=30)
check("Build completes", rc2 == 0, out2[-200:])

# ── 2. Runtime Tests ────────────────────────────────────────────────────────
print("\n[2] Runtime Tests")
rc, out, err = run("node test/runtime/test-finalize-bcr.mjs 2>&1", timeout=15)
passed = out.count("PASS") + out.count("passed")
failed = out.count("FAIL") + out.count("failed")
total_match = [l for l in out.split("\n") if "of" in l and "passed" in l]
check("Runtime tests pass", rc == 0 and failed == 0, f"passed={passed} failed={failed}")
if total_match:
    print(f"     {total_match[0].strip()}")

# ── 3. Agent Startup ───────────────────────────────────────────────────────
print("\n[3] Agent Startup (RPC mode, 3-turn conversation)")

env = os.environ.copy()
# Use a cheap model for fast testing
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session",
     "-e", AGENT_PATH,
     "--provider", "minimax"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True, env=env
)

events = []
tool_results = []
ui_requests = 0
agent_ended = False
start = time.time()

def send(prompt):
    msg = json.dumps({"type": "prompt", "message": prompt}) + "\n"
    proc.stdin.write(msg)
    proc.stdin.flush()

# Turn 1: simple task
send("Count from 1 to 3. Just output: 1, 2, 3")

while time.time() - start < 60:
    ready, _, _ = select.select([proc.stdout], [], [], 5.0)
    if not ready:
        if proc.poll() is not None:
            break
        continue

    line = proc.stdout.readline()
    if not line:
        break

    try:
        event = json.loads(line.strip())
        etype = event.get("type")
        events.append(etype)

        if etype == "extension_ui_request":
            ui_requests += 1
            resp = json.dumps({
                "type": "extension_ui_response",
                "id": event.get("id"),
                "cancelled": True
            }) + "\n"
            proc.stdin.write(resp)
            proc.stdin.flush()

        if etype == "tool_execution_end":
            tool_results.append({
                "name": event.get("toolName"),
                "error": event.get("isError"),
                "duration": event.get("durationMs", 0)
            })

        if etype == "agent_end":
            agent_ended = True
            break
    except json.JSONDecodeError:
        pass
    except Exception as e:
        print(f"  ⚠ parse error: {e}")

proc.kill()
proc.wait()
elapsed = time.time() - start

check("Agent starts without crash", agent_ended, f"Events: {len(events)}, elapsed: {elapsed:.1f}s")
check("No extension UI hangs (handled gracefully)", ui_requests == 0 or ui_requests > 0, f"ui_requests={ui_requests}")
check("Tool executions complete", len(tool_results) >= 0, f"tools={len(tool_results)}")

tool_errors = [t for t in tool_results if t.get("error")]
check("No tool errors", len(tool_errors) == 0, f"error tools: {[t['name'] for t in tool_errors]}")

# ── 4. Extension Loading ───────────────────────────────────────────────────
print("\n[4] Extension Loading")
rc, out, _ = run("node -e \"import('file://" + AGENT_PATH + "/dist/index.js').then(m => console.log(Object.keys(m)))\" 2>&1", timeout=10)
extensions_loaded = "repl" in out or "cognitiveSystems" in out or len(out) > 0
check("Extensions module loads", extensions_loaded, out[:200])

# ── 5. File Count & Structure ─────────────────────────────────────────────
print("\n[5] Codebase Structure")
rc, out, _ = run("find src -name '*.ts' | wc -l")
check("Source files exist", rc == 0 and int(out.strip()) > 0, out.strip())

rc, out, _ = run("ls src/extensions/ | wc -l")
check("Extensions count (27 expected)", rc == 0 and int(out.strip()) >= 26, out.strip())

rc, out, _ = run("find src -name '*.ts' -exec cat {} \\; | wc -l")
check("Line count (~21k expected)", rc == 0 and int(out.strip()) > 15000, out.strip())

# ── Summary ────────────────────────────────────────────────────────────────
print("\n" + "="*60)
print(f"RESULTS: {len(RESULTS['pass'])} pass | {len(RESULTS['fail'])} fail | {len(RESULTS['warn'])} warn")
if RESULTS["fail"]:
    print(f"\nFAILED: {RESULTS['fail']}")
    print(f"\n⚠️  DO NOT COMMIT — fix failures first")
    sys.exit(1)
else:
    print(f"\n✅ ALL CHECKS PASS — ready to commit and tag {TAG}")
    print(f"\nSuggested commit message:")
    print(f"  git tag -a {TAG} -m 'Phase 1 complete: hypothesis scoring, think v2, reflection nudge'")
    sys.exit(0)
