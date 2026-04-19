#!/usr/bin/env python3
"""pi-braid stability test via RPC subprocess."""
import subprocess
import json
import os
import select
import time
import sys
import re

AGENT_PATH = "/Users/kifir/projects/agents/pi-braid"
TAG = "v0.5.7-Phase1"

results = {"pass": [], "fail": []}
checks_passed = 0
checks_failed = 0

def log(msg):
    print(f"  {msg}", flush=True)

def check(name, cond, detail=""):
    global checks_passed, checks_failed
    if cond:
        results["pass"].append(name)
        checks_passed += 1
        log(f"✅ {name}")
    else:
        results["fail"].append(name)
        checks_failed += 1
        log(f"❌ {name}")
        if detail:
            for line in detail.split("\n")[:5]:
                log(f"   {line[:200]}")

# 1. Type check
log("[1] Type check")
proc = subprocess.run(
    ["npx", "tsc", "--noEmit", "--skipLibCheck"],
    capture_output=True, text=True, cwd=AGENT_PATH, timeout=30
)
errors = [l for l in proc.stdout.split("\n") if "error TS" in l]
check("TypeScript: 0 errors", len(errors) == 0, "\n".join(errors[:5]))

# 2. Build
log("[2] Build")
proc = subprocess.run(
    ["npx", "tsc", "--outDir", "dist", "--skipLibCheck"],
    capture_output=True, text=True, cwd=AGENT_PATH, timeout=30
)
check("Build completes", proc.returncode == 0, proc.stderr[-300:])

# 3. Runtime tests (fix: count "X failed" not just "failed")
log("[3] Runtime tests")
proc = subprocess.run(
    ["node", "test/runtime/test-finalize-bcr.mjs"],
    capture_output=True, text=True, cwd=AGENT_PATH, timeout=20
)
# Count "N failed" where N > 0
failed_match = re.findall(r"(\d+) failed", proc.stdout)
failed = sum(int(n) for n in failed_match)
passed_match = re.findall(r"(\d+) passed", proc.stdout)
passed = sum(int(n) for n in passed_match)
check(f"Runtime tests ({passed} passed)", passed >= 14 and failed == 0, proc.stdout[-300:])

# 4. Agent RPC startup
log("[4] Agent RPC startup (3 turns)")
env = os.environ.copy()
env.pop("PI_API_KEY", None)

agent_proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session",
     "-e", AGENT_PATH,
     "--provider", "minimax"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env
)

turns_completed = 0
tools_executed = 0
tool_errors = 0
events = []
agent_crashed = True
start_time = time.time()

def send(prompt):
    msg = json.dumps({"type": "prompt", "message": prompt}) + "\n"
    agent_proc.stdin.write(msg.encode())
    agent_proc.stdin.flush()

send("Count from 1 to 3. Output only: 1, 2, 3")

while time.time() - start_time < 90:
    ready, _, _ = select.select([agent_proc.stdout], [], [], 3.0)
    if not ready:
        if agent_proc.poll() is not None:
            break
        continue
    line = agent_proc.stdout.readline()
    if not line:
        break
    try:
        event = json.loads(line.decode().strip())
        etype = event.get("type")
        events.append(etype)
        if etype == "extension_ui_request":
            resp = json.dumps({"type": "extension_ui_response", "id": event.get("id"), "cancelled": True}) + "\n"
            agent_proc.stdin.write(resp.encode())
            agent_proc.stdin.flush()
        if etype == "tool_execution_end":
            tools_executed += 1
            if event.get("isError"):
                tool_errors += 1
        if etype == "turn_end":
            turns_completed += 1
            stop_reason = event.get("stopReason", "")
            prompts = ["Say hello in 1 word.", "What is 2+2? Output just the number."]
            if turns_completed < 3 and turns_completed < len(prompts):
                send(prompts[turns_completed - 1])
        if etype == "agent_end":
            agent_crashed = False
            break
    except Exception:
        pass

agent_proc.kill()
agent_proc.wait()
elapsed = time.time() - start_time

check("Agent starts without crash", not agent_crashed,
      f"events={len(events)}, elapsed={elapsed:.1f}s, turns={turns_completed}")
check("Agent completes turns", turns_completed >= 1,
      f"turns={turns_completed}")
check("No tool errors", tool_errors == 0,
      f"tool_errors={tool_errors}/{tools_executed}")

# 5. Extension module load
log("[5] Extension module load")
proc = subprocess.run(
    ["node", "-e",
     f"import('file://{AGENT_PATH}/dist/index.js').then(m => console.log(JSON.stringify(Object.keys(m))))"],
    capture_output=True, text=True, timeout=10
)
check("Extensions load without error", proc.returncode == 0, proc.stderr[:200])

# 6. File structure
log("[6] Codebase structure")
proc = subprocess.run(["find", "src", "-name", "*.ts", "-not", "-path", "*/node_modules/*"],
                      capture_output=True, text=True, cwd=AGENT_PATH)
file_count = len(proc.stdout.strip().split("\n"))
check("Source files (>50)", file_count > 50, f"files={file_count}")

proc = subprocess.run(["sh", "-c", "ls src/extensions/ | wc -l"],
                      capture_output=True, text=True, cwd=AGENT_PATH)
ext_count = int(proc.stdout.strip())
check("Extensions (27)", ext_count == 27, f"extensions={ext_count}")

# Summary
print("\n" + "="*60)
print(f"CHECKS: {checks_passed} pass | {checks_failed} fail")
if results["fail"]:
    print("FAILED:")
    for f in results["fail"]:
        print(f"  - {f}")
    print(f"\n⚠️  STABILITY ISSUES — do NOT tag")
    sys.exit(1)
else:
    print(f"✅ ALL CHECKS PASS — ready to tag {TAG}")
    print(f"  git tag -a {TAG} -m 'Phase 1 complete: hypothesis scoring, think v2, reflection nudge'")
    sys.exit(0)
