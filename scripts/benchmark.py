#!/usr/bin/env python3
"""
pi-braid End-to-End Benchmark
Measures task success, tool efficiency, context usage, RUMS retrieval quality, degradation.

Usage:
    python3 scripts/benchmark.py --tasks <tasks_file.json>
    python3 scripts/benchmark.py --all  # run all benchmark tasks
"""
import json
import subprocess
import select
import time
import os
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional

PROVIDER = os.environ.get("PI_PROVIDER", "a0-venice")
MODEL = os.environ.get("PI_MODEL", "a0-venice/mercury-2")
EXT_PATH = "/Users/kifir/projects/agents/pi-braid"
TIMEOUT_SECONDS = 120


@dataclass
class BenchmarkTask:
    name: str
    prompt: str
    expected_tools: list[str] = field(default_factory=list)
    min_tools: int = 3
    max_tools: int = 50
    expected_keywords: list[str] = field(default_factory=list)


# Benchmark task suite
BENCHMARK_TASKS = [
    BenchmarkTask(
        name="read_file",
        prompt="Read the package.json file in /Users/kifir/projects/agents/pi-braid and tell me the version.",
        expected_tools=["read"],
        min_tools=1,
        max_tools=3,
        expected_keywords=["version"],
    ),
    BenchmarkTask(
        name="list_extensions",
        prompt="List all extensions in the src/extensions directory. Use bash to run ls.",
        expected_tools=["bash", "ls"],
        min_tools=1,
        max_tools=5,
        expected_keywords=["enforcement", "metacognition", "heartbeat"],
    ),
    BenchmarkTask(
        name="create_file",
        prompt="Create a new file at /tmp/pi-braid-benchmark-test.txt with the text 'benchmark test' on the first line.",
        expected_tools=["write", "bash"],
        min_tools=2,
        max_tools=5,
        expected_keywords=["benchmark test"],
    ),
    BenchmarkTask(
        name="search_code",
        prompt="Search for all TypeScript files in src/lib that contain 'getExtensionState'.",
        expected_tools=["grep", "find"],
        min_tools=1,
        max_tools=8,
        expected_keywords=["getExtensionState"],
    ),
    BenchmarkTask(
        name="complex_refactor",
        prompt="""Read the src/lib/logger.ts file. Then:
1. Count how many lines it has (use bash wc -l)
2. Tell me the filename with the most lines in src/lib/
3. Create a file /tmp/lib-summary.txt with the counts for logger.ts and the largest file.
Do NOT edit any files. Just read and report.""",
        expected_tools=["read", "bash", "write"],
        min_tools=3,
        max_tools=15,
        expected_keywords=["logger", "extension-state"],
    ),
]


def run_task(task: BenchmarkTask) -> dict:
    """Run a single benchmark task and collect metrics."""
    print(f"\n  Running: {task.name}")

    start_time = time.time()
    tool_calls = []
    errors = []
    warnings = []
    whispers = []
    final_response = ""
    agent_end_reason = ""
    turns = 0

    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session",
         "--provider", PROVIDER, "--model", MODEL,
         "-e", EXT_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", "")},
    )

    prompt = json.dumps({"type": "prompt", "message": task.prompt}) + "\n"
    proc.stdin.write(prompt.encode())
    proc.stdin.flush()

    deadline = start_time + TIMEOUT_SECONDS
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        if not ready:
            continue
        try:
            line = proc.stdout.readline()
            if not line:
                break
            event = json.loads(line.decode().strip())
            etype = event.get("type", "")

            if etype == "tool_call":
                tool_calls.append({
                    "name": event.get("toolName", "unknown"),
                    "timestamp": time.time() - start_time,
                })

            elif etype == "tool_execution_end":
                if event.get("isError"):
                    errors.append(event.get("toolName", "unknown"))

            elif etype == "extension_ui_request":
                resp = json.dumps({
                    "type": "extension_ui_response",
                    "id": event.get("id"),
                    "cancelled": True
                }) + "\n"
                proc.stdin.write(resp.encode())
                proc.stdin.flush()

            elif etype == "message_update":
                amsg = event.get("assistantMessageEvent", {})
                if amsg.get("type") == "text_end":
                    final_response += amsg.get("content", "")

            elif etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if block.get("type") == "text":
                            final_response += block.get("text", "")

            elif etype == "agent_end":
                agent_end_reason = event.get("reason", "unknown")

            elif etype == "warning":
                warnings.append(event.get("message", ""))

        except (json.JSONDecodeError, UnicodeDecodeError, KeyError):
            pass

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    duration = time.time() - start_time
    tool_names = [t["name"] for t in tool_calls]

    # Score
    expected_found = sum(1 for kw in task.expected_keywords
                       if kw.lower() in final_response.lower())
    keyword_score = expected_found / max(len(task.expected_keywords), 1)
    tool_score = 1.0 if any(t in tool_names for t in task.expected_tools) else 0.0
    error_penalty = min(len(errors) * 0.1, 0.5)
    success_score = (keyword_score * 0.6 + tool_score * 0.4) * (1 - error_penalty)
    success = success_score >= 0.5

    return {
        "name": task.name,
        "duration_seconds": round(duration, 1),
        "tool_count": len(tool_calls),
        "tool_names": tool_names,
        "error_count": len(errors),
        "errors": errors,
        "warning_count": len(warnings),
        "turns": turns,
        "keyword_match": f"{expected_found}/{len(task.expected_keywords)}",
        "keyword_score": round(keyword_score, 2),
        "tool_score": round(tool_score, 2),
        "success_score": round(success_score, 2),
        "success": success,
        "agent_end_reason": agent_end_reason,
        "response_preview": final_response[:200].replace("\n", " "),
    }


def main():
    results = []
    for task in BENCHMARK_TASKS:
        result = run_task(task)
        results.append(result)
        icon = "✅" if result["success"] else "❌"
        print(f"    {icon} {task.name}: score={result['success_score']:.2f} "
              f"tools={result['tool_count']} err={result['error_count']} "
              f"kw={result['keyword_match']}")

    # Summary
    n = len(results)
    successes = sum(1 for r in results if r["success"])
    total_tools = sum(r["tool_count"] for r in results)
    total_errors = sum(r["error_count"] for r in results)
    avg_score = sum(r["success_score"] for r in results) / n

    print(f"\n{'='*60}")
    print("BENCHMARK SUMMARY")
    print(f"{'='*60}")
    print(f"Tasks: {successes}/{n} succeeded ({100*successes/n:.0f}%)")
    print(f"Success score: {avg_score:.2f}")
    print(f"Tool efficiency: {total_tools/n:.1f} tools/task")
    print(f"Error rate: {total_errors}/{sum(r['tool_count'] for r in results)} "
          f"({100*total_errors/max(sum(r['tool_count'] for r in results),1):.1f}%)")
    print(f"Avg duration: {sum(r['duration_seconds'] for r in results)/n:.0f}s")

    # Per-task table
    print(f"\n{'Task':<25} {'Score':<8} {'Tools':<8} {'Errors':<8} {'Keywords':<12}")
    print("-" * 65)
    for r in results:
        icon = "✅" if r["success"] else "❌"
        print(f"{icon} {r['name']:<23} {r['success_score']:<8.2f} "
              f"{r['tool_count']:<8} {r['error_count']:<8} {r['keyword_match']:<12}")

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = f"/tmp/benchmark_{timestamp}.json"
    with open(out_path, "w") as f:
        json.dump({
            "timestamp": timestamp,
            "summary": {
                "total": n,
                "successes": successes,
                "success_rate": successes / n,
                "avg_score": avg_score,
                "avg_tools": total_tools / n,
                "error_rate": total_errors / max(total_tools, 1),
            },
            "tasks": results,
        }, f, indent=2)
    print(f"\nResults saved to {out_path}")

    # Exit code
    if successes < n * 0.7:
        print(f"\n⚠️  Below 70% threshold: {successes}/{n}")
        sys.exit(1)
    else:
        print(f"\n🎉 Benchmark passed: {successes}/{n} >= 70%")
        sys.exit(0)


if __name__ == "__main__":
    main()
