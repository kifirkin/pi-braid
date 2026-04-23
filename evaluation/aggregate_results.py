#!/usr/bin/env python3
"""
Unified Results Aggregator
===========================
Aggregates results from pi-braid JS test harness and vibe/implicit-framing Python benchmarks
into a unified research format.

Usage:
  python3 aggregate_results.py                           # Aggregate all results
  python3 aggregate_results.py --js ./results/js-test-*.json  # JS results only
  python3 aggregate_results.py --py ./results/py-*.json       # Python results only
"""

import json
import os
import sys
import glob
import re
from datetime import datetime
from collections import defaultdict

PI_BRAID_RESULTS = "/Users/kifir/projects/agents/pi-braid/evaluation/results"
VIBE_RESULTS = "/Users/kifir/projects/vibe/implicit-framing/results"


def load_js_results(patterns):
    """Load and parse JS test harness results."""
    results = []
    for pattern in patterns:
        for filepath in glob.glob(pattern):
            with open(filepath) as f:
                data = json.load(f)
                if isinstance(data, list):
                    results.extend(data)
                else:
                    results.append(data)
    return results


def load_py_results(patterns):
    """Load and parse Python benchmark results."""
    results = []
    for pattern in patterns:
        for filepath in glob.glob(pattern):
            with open(filepath) as f:
                data = json.load(f)
                if isinstance(data, list):
                    results.extend(data)
                else:
                    results.append(data)
    return results


def compute_js_summary(results):
    """Compute summary from JS test harness results."""
    if not results:
        return {}

    by_task = defaultdict(list)
    for r in results:
        by_task[r.get("taskId", "unknown")].append(r)

    task_summary = []
    for task_id, task_results in by_task.items():
        success = sum(1 for r in task_results if r.get("success"))
        total = len(task_results)
        turns = [r.get("turns", 0) for r in task_results if r.get("turns", 0) > 0]
        task_summary.append({
            "taskId": task_id,
            "trials": total,
            "success": success,
            "rate": success / total if total > 0 else 0,
            "avgTurns": sum(turns) / len(turns) if turns else 0,
        })

    total_success = sum(t["success"] for t in task_summary)
    total_trials = sum(t["trials"] for t in task_summary)

    return {
        "source": "pi-braid-js-harness",
        "totalTrials": total_trials,
        "totalSuccess": total_success,
        "overallRate": total_success / total_trials if total_trials > 0 else 0,
        "tasks": task_summary,
    }


def compute_py_summary(results):
    """Compute summary from Python benchmark results."""
    if not results:
        return {}

    by_task = defaultdict(list)
    for r in results:
        by_task[r.get("id", r.get("task_id", "unknown"))].append(r)

    task_summary = []
    for task_id, task_results in by_task.items():
        success = sum(1 for r in task_results if r.get("success"))
        total = len(task_results)
        task_summary.append({
            "taskId": task_id,
            "trials": total,
            "success": success,
            "rate": success / total if total > 0 else 0,
        })

    total_success = sum(t["success"] for t in task_summary)
    total_trials = sum(t["trials"] for t in task_summary)

    return {
        "source": "vibe-implicit-framing-py",
        "totalTrials": total_trials,
        "totalSuccess": total_success,
        "overallRate": total_success / total_trials if total_trials > 0 else 0,
        "tasks": task_summary,
    }


def format_unified_report(summaries):
    """Format unified research report."""
    lines = []
    lines.append("# pi-braid Unified Research Results")
    lines.append(f"Generated: {datetime.now().isoformat()}")
    lines.append("")

    for summary in summaries:
        source = summary.get("source", "unknown")
        lines.append(f"## Source: {source}")
        lines.append(f"- **Overall Solve Rate**: {summary.get('overallRate', 0) * 100:.0f}%")
        lines.append(f"- **Total Trials**: {summary.get('totalTrials', 0)}")
        lines.append(f"- **Total Success**: {summary.get('totalSuccess', 0)}")
        lines.append("")
        lines.append("| Task | Trials | Success | Rate |")
        lines.append("|------|--------|---------|------|")

        for task in summary.get("tasks", []):
            rate = task.get("rate", 0) * 100
            turns = f" (avg: {task.get('avgTurns', 0):.1f} turns)" if task.get("avgTurns") else ""
            lines.append(
                f"| {task['taskId']} | {task['trials']} | {task['success']} | {rate:.0f}%{turns} |"
            )
        lines.append("")

    # Cross-source comparison
    if len(summaries) > 1:
        lines.append("## Cross-Source Comparison")
        for summary in summaries:
            source = summary.get("source", "unknown")
            rate = summary.get("overallRate", 0) * 100
            lines.append(f"- **{source}**: {rate:.0f}% ({summary.get('totalSuccess', 0)}/{summary.get('totalTrials', 0)})")

    return "\n".join(lines)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Aggregate benchmark results")
    parser.add_argument("--js", nargs="+", help="JS result files (glob patterns)")
    parser.add_argument("--py", nargs="+", help="Python result files (glob patterns)")
    parser.add_argument("--output", help="Output file (default: print to stdout)")
    args = parser.parse_args()

    summaries = []

    # Load JS results
    js_patterns = args.js or [f"{PI_BRAID_RESULTS}/js-test-*.json"]
    try:
        js_results = load_js_results(js_patterns)
        if js_results:
            summaries.append(compute_js_summary(js_results))
    except Exception as e:
        print(f"Warning: Could not load JS results: {e}", file=sys.stderr)

    # Load Python results
    py_patterns = args.py or [f"{VIBE_RESULTS}/*.json"]
    try:
        py_results = load_py_results(py_patterns)
        if py_results:
            summaries.append(compute_py_summary(py_results))
    except Exception as e:
        print(f"Warning: Could not load Python results: {e}", file=sys.stderr)

    if not summaries:
        print("No results found.")
        sys.exit(1)

    report = format_unified_report(summaries)

    if args.output:
        with open(args.output, "w") as f:
            f.write(report)
        print(f"Written to: {args.output}")
    else:
        print(report)


if __name__ == "__main__":
    main()
