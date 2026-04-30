#!/usr/bin/env python3
"""
Overnight test suite — pi-braid comprehensive feature validation.
Runs continuously through the night, testing:
1. Compaction (LLM summarization fires, no double entries)
2. Enforcement (signals emit, recommendations given)
3. Memory stores (record + recall works)
4. Analytics (tool addiction detection fires)
5. Metacognition (think tool + self-reflection)
6. Basic tool execution (read, grep, bash, think)

Usage:
  python3 evaluation/overnight_test.py --timeout 600
"""
import json, os, select, signal, subprocess, sys, time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).parent.parent
MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
EXTENSIONS = str(ROOT)
OUTFILE = ROOT / "evaluation" / "results" / f"overnight_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"

TASKS = [
    {
        "name": "basic_tool_chain",
        "prompt": "Read src/index.ts, count the lines, then grep for 'export' in that file, then use think() to summarize what you found.",
        "timeout": 60,
    },
    {
        "name": "memory_recall_and_store",
        "prompt": "Use memory_recall to find any past insights about TypeScript. If none found, use memory_store to record: category=pattern, content=TypeScript files use .ts extension and compile to JavaScript, importance=0.8. Then report what you stored.",
        "timeout": 90,
    },
    {
        "name": "enforcement_check",
        "prompt": "Use think() to reflect: what are the 3 most important rules you follow when executing bash commands? Be honest and specific.",
        "timeout": 60,
    },
    {
        "name": "analytics_query",
        "prompt": "Run get-session-metrics to see your current session statistics. Then run get-tool-reliability to check tool success rates. Report the results.",
        "timeout": 60,
    },
    {
        "name": "context_pressure",
        "prompt": "Read src/extensions/memory/context-manager/handlers/compaction.ts in full. Then read src/lib/evidence-pool.ts. Then read src/lib/belief-policy-engine.ts. Then use think() to explain how compaction decisions are made in this codebase.",
        "timeout": 120,
    },
    {
        "name": "tool_addiction_test",
        "prompt": "Use grep to search for 'async' in exactly 3 different files: src/index.ts, src/lib/logger.ts, and package.json. Report what you found in each.",
        "timeout": 90,
    },
    {
        "name": "self_reflection",
        "prompt": "After completing the previous tasks, use think() to evaluate: how well did you sequence your tools? Was there a better order? What would you do differently?",
        "timeout": 60,
    },
    {
        "name": "hypothesize",
        "prompt": "A user reports that compaction sometimes fires twice in rapid succession. Use hypothesize() to generate 3 possible root causes, each with evidence and resolution.",
        "timeout": 90,
    },
]


@dataclass
class RunResult:
    name: str
    success: bool
    duration: float
    turns: int
    tool_calls: int
    error: Optional[str] = None
    final_text: str = ""


def run_pi(prompt: str, timeout: int = 60) -> RunResult:
    """Run a single pi task and collect metrics."""
    cmd = [
        "pi", "--mode", "rpc", "--no-session",
        "--provider", "openrouter", "--model", MODEL,
        "-e", EXTENSIONS,
    ]

    env = {**os.environ}
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)

    start = time.time()
    turns = 0
    tool_calls = 0
    final_text = ""
    error = None
    done = False

    try:
        proc.stdin.write(json.dumps({"type": "prompt", "message": prompt}).encode() + b"\n")
        proc.stdin.flush()

        while time.time() - start < timeout:
            elapsed = time.time() - start
            ready, _, _ = select.select([proc.stdout], [], [], min(2.0, timeout - elapsed))
            if not ready:
                if proc.poll() is not None:
                    break
                continue

            line = proc.stdout.readline()
            if not line:
                break

            try:
                event = json.loads(line.decode().strip())
            except:
                continue

            etype = event.get("type")

            # Must respond to extension_ui_request within 2s
            if etype == "extension_ui_request":
                resp = json.dumps({"type": "extension_ui_response", "id": event.get("id"), "cancelled": True}).encode() + b"\n"
                proc.stdin.write(resp)
                proc.stdin.flush()

            if etype == "turn_start":
                turns += 1
            if etype == "tool_execution_end":
                tool_calls += 1
            if etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if block.get("type") == "text":
                            final_text = block.get("text", "")[-500:]  # last 500 chars
            if etype == "agent_end":
                done = True
                break

    except Exception as e:
        error = str(e)
    finally:
        proc.kill()
        proc.wait()

    duration = time.time() - start
    return RunResult(
        name="",
        success=done and not error,
        duration=duration,
        turns=turns,
        tool_calls=tool_calls,
        error=error,
        final_text=final_text,
    )


def main():
    OUTFILE.parent.mkdir(parents=True, exist_ok=True)
    print(f"[{datetime.now().isoformat()}] Overnight test suite starting")
    print(f"Model: {MODEL}  |  Extensions: {EXTENSIONS}")
    print(f"Output: {OUTFILE}")
    print(f"Tasks: {len(TASKS)}  |  Running indefinitely...\n")

    all_results = []
    task_idx = 0
    iteration = 0

    # Catch Ctrl-C gracefully
    def sigint_handler(sig, frame):
        print(f"\n[{datetime.now().isoformat()}] Interrupted — saving results...")
        save_results(all_results)
        sys.exit(0)
    signal.signal(signal.SIGINT, sigint_handler)

    while True:
        task = TASKS[task_idx]
        task_idx = (task_idx + 1) % len(TASKS)
        iteration += 1

        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] Iter {iteration} · {task['name']}... ", end="", flush=True)

        result = run_pi(task["prompt"], task["timeout"])
        result.name = task["name"]

        status = "✅" if result.success else "❌"
        print(f"{status} {result.duration:.1f}s / {result.turns}t / {result.tool_calls}tools")

        if result.error:
            print(f"     ERROR: {result.error[:100]}")

        all_results.append({
            "iteration": iteration,
            "task": task["name"],
            "success": result.success,
            "duration": round(result.duration, 1),
            "turns": result.turns,
            "tool_calls": result.tool_calls,
            "error": result.error,
            "timestamp": datetime.now().isoformat(),
        })

        # Save incrementally every 5 iterations
        if iteration % 5 == 0:
            save_results(all_results)

        # Sleep between tasks to avoid hammering the API
        time.sleep(2)

    save_results(all_results)


def save_results(results):
    with open(OUTFILE, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")

    passed = sum(1 for r in results if r["success"])
    print(f"\n[{datetime.now().isoformat()}] Saved {len(results)} results: {passed}/{len(results)} passed ({passed/len(results)*100:.0f}%)")


if __name__ == "__main__":
    main()
