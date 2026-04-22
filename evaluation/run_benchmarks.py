#!/usr/bin/env python3
"""
pi-braid Benchmark Runner
=========================
Runs all pi-braid benchmarks and generates consolidated reports.

Usage:
  python3 run_benchmarks.py --all                    # Run all benchmarks
  python3 run_benchmarks.py --bm1                   # Multi-turn debugging
  python3 run_benchmarks.py --br4 --task "..."       # Latent activator test
  python3 run_benchmarks.py --quick                 # Fast sanity check
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime

DEFAULT_MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
DEFAULT_EXTENSIONS = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")
OUTPUT_DIR = "/Users/kifir/projects/agents/pi-braid/evaluation/results"


def ensure_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(f"{OUTPUT_DIR}/logs", exist_ok=True)


def run_command(cmd: list[str], timeout: float = 300) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Timeout"
    except Exception as e:
        return -1, "", str(e)


def run_bm1_quick(model: str, extensions: str) -> dict:
    """Run BM1 with quick settings (1 trial per task)."""
    print("\n=== Running BM1: Multi-Turn Debugging ===", file=sys.stderr)

    cmd = [
        sys.executable,
        "bm1_multi_turn_debug.py",
        "--model", model,
        "--extensions", extensions,
        "--timeout", "120",
    ]

    rc, stdout, stderr = run_command(cmd, timeout=600)
    return {
        "benchmark": "BM1",
        "returncode": rc,
        "stdout": stdout,
        "stderr": stderr,
        "timestamp": datetime.now().isoformat(),
    }


def run_br4_quick(model: str, extensions: str, task: str) -> dict:
    """Run BR4 with quick settings (2 trials per config)."""
    print("\n=== Running BR4: Latent Activator Multi-Turn ===", file=sys.stderr)

    cmd = [
        sys.executable,
        "br4_latent_multi_turn.py",
        "--task", task,
        "--model", model,
        "--trials", "2",
        "--timeout", "90",
    ]

    rc, stdout, stderr = run_command(cmd, timeout=600)
    return {
        "benchmark": "BR4",
        "returncode": rc,
        "stdout": stdout,
        "stderr": stderr,
        "timestamp": datetime.now().isoformat(),
    }


def run_quick_sanity(model: str, extensions: str) -> dict:
    """Run a quick sanity check (single task, 2 configs)."""
    print("\n=== Running Quick Sanity Check ===", file=sys.stderr)

    sanity_task = "Read the file /tmp/test.txt and tell me what it contains. Create it first with the content 'Hello World'."

    cmd = [
        sys.executable,
        "pi_rpc_benchmark.py",
        "--prompt", sanity_task,
        "--model", model,
        "--extensions", extensions,
        "--no-extensions",
        "--trials", "1",
        "--timeout", "60",
        "--compare",
        "--output", f"{OUTPUT_DIR}/quick_sanity.json",
    ]

    rc, stdout, stderr = run_command(cmd, timeout=300)
    return {
        "benchmark": "quick_sanity",
        "returncode": rc,
        "stdout": stdout,
        "stderr": stderr,
        "timestamp": datetime.now().isoformat(),
    }


def format_summary(results: list[dict]) -> str:
    """Format consolidated benchmark summary."""
    lines = ["# pi-braid Benchmark Results", ""]
    lines.append(f"**Generated**: {datetime.now().isoformat()}")
    lines.append(f"**Model**: {DEFAULT_MODEL}")
    lines.append(f"**Extensions**: {DEFAULT_EXTENSIONS}")
    lines.append("")

    for result in results:
        benchmark = result.get("benchmark", "unknown")
        rc = result.get("returncode", -1)
        status = "✅ PASS" if rc == 0 else f"❌ FAIL ({rc})"
        lines.append(f"## {benchmark}: {status}")
        lines.append("")

        stdout = result.get("stdout", "")
        if stdout:
            lines.append("```")
            lines.append(stdout[:2000])  # Truncate long output
            lines.append("```")

        stderr = result.get("stderr", "")
        if stderr and stderr != "Timeout":
            lines.append("*stderr*:")
            lines.append("```")
            lines.append(stderr[:500])
            lines.append("```")

        lines.append("")

    return "\n".join(lines)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="pi-braid Benchmark Runner")
    parser.add_argument("--all", action="store_true", help="Run all benchmarks")
    parser.add_argument("--bm1", action="store_true", help="Run BM1 (multi-turn debugging)")
    parser.add_argument("--br4", action="store_true", help="Run BR4 (latent activator)")
    parser.add_argument("--quick", action="store_true", help="Run quick sanity check")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model")
    parser.add_argument("--extensions", type=str, default=DEFAULT_EXTENSIONS, help="Extensions path")
    parser.add_argument("--task", type=str, help="Task prompt for BR4")
    parser.add_argument("--output", type=str, help="Output file for summary")
    args = parser.parse_args()

    if not any([args.all, args.bm1, args.br4, args.quick]):
        parser.print_help()
        sys.exit(1)

    ensure_output_dir()
    results = []

    if args.quick or args.all:
        results.append(run_quick_sanity(model=args.model, extensions=args.extensions))

    if args.bm1 or args.all:
        results.append(run_bm1_quick(model=args.model, extensions=args.extensions))

    if args.br4 or args.all:
        default_task = (
            "You are debugging a Node.js server with a race condition. "
            "Read /tmp/server.js, identify the bug, fix it, and verify the fix works. "
            "This requires multiple turns: diagnose → propose → implement → test."
        )
        task = args.task or default_task
        results.append(run_br4_quick(model=args.model, extensions=args.extensions, task=task))

    # Format and output summary
    summary = format_summary(results)
    print(summary)

    # Save to file
    output_file = args.output or f"{OUTPUT_DIR}/summary_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    with open(output_file, "w") as f:
        f.write(summary)
    print(f"\nSummary saved to: {output_file}", file=sys.stderr)

    # Save raw results
    raw_file = f"{OUTPUT_DIR}/raw_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(raw_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"Raw results saved to: {raw_file}", file=sys.stderr)

    sys.exit(0 if all(r.get("returncode", -1) == 0 for r in results) else 1)


if __name__ == "__main__":
    main()