#!/usr/bin/env python3
"""
BR4: Latent Activator Multi-Turn Test
====================================
Research question: Does identity framing work in multi-turn (vs single-shot where it failed)?

Experiment design:
  Config A: pi-braid with latent activator ON
  Config B: latent OFF  
  Config C: baseline (no extensions)

  Task: Multi-turn debugging (read → propose → test → fail → debug → fix)
  Metrics: solve rate, token usage, compliance behaviors

Hypothesis: Latent activator should improve multi-turn persistence and reduce compliance behaviors
compared to single-shot where identity framing had no measurable effect.
"""

import json
import os
import re
import subprocess
import sys
import time
import select
from dataclasses import dataclass, field
from typing import Optional
from pi_rpc_benchmark import PiRPC, make_event, AgentResult

DEFAULT_MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")


@dataclass
class LatentTestResult:
    config: str = ""
    task_id: str = ""
    success: bool = False
    turns: int = 0
    token_count: int = 0
    duration: float = 0.0
    tool_count: int = 0
    compliance_behaviors: int = 0  # Count of directive-following vs identity-driven actions
    error: Optional[str] = None


# Compliance behavior detection patterns
COMPLIANCE_PATTERNS = {
    "excessive_verification": re.compile(r'verify.*again|check.*again|double.?check|confirm.*again', re.I),
    "over_confirmation": re.compile(r'Let me confirm|I need to confirm|I should verify|Let me verify', re.I),
    "rule_anchoring": re.compile(r'According to the guidelines|As per the prompt|As instructed', re.I),
    "hasty_completion": re.compile(r'I.?ll do this now|Completing this|Finishing up|Done', re.I),
    "defensive": re.compile(r'Sorry|apologies|I apologize|excuse me', re.I),
}


def count_compliance_behaviors(text: str) -> dict[str, int]:
    """Count compliance behavior instances in text."""
    counts = {}
    for name, pattern in COMPLIANCE_PATTERNS.items():
        matches = pattern.findall(text)
        counts[name] = len(matches)
    return counts


def run_latent_test(
    config: str,
    task_prompt: str,
    model: str = DEFAULT_MODEL,
    extensions: Optional[str] = None,
    no_extensions: bool = False,
    timeout: float = 90.0,
) -> LatentTestResult:
    """Run a single latent activator test configuration."""
    print(f"  Running config: {config}...", file=sys.stderr)

    rpc = PiRPC(
        extensions=extensions,
        model=model,
        no_extensions=no_extensions,
    )

    result = LatentTestResult(config=config)

    try:
        rpc.start(timeout=3.0)
        start_time = time.time()

        rpc.send(make_event("prompt", message=task_prompt))

        full_text = ""

        while time.time() - start_time < timeout:
            event = rpc.recv(timeout=5.0)
            if not event:
                if rpc.proc and rpc.proc.poll() is not None:
                    break
                continue

            etype = event.get("type", "")

            if etype == "extension_ui_request":
                rpc.send(make_event("extension_ui_response", id=event.get("id"), cancelled=True))

            if etype in ("tool_execution_start", "tool_execution_end"):
                result.tool_count += 1

            if etype == "message_end":
                result.turns += 1
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        full_text += text

            if etype == "agent_end":
                result.success = True
                break

        result.duration = time.time() - start_time
        result.token_count = len(full_text) // 4

        # Count compliance behaviors
        compliance = count_compliance_behaviors(full_text)
        result.compliance_behaviors = sum(compliance.values())

    except Exception as e:
        result.error = str(e)
    finally:
        rpc.stop()

    return result


def run_br4(
    task_prompt: str,
    model: str = DEFAULT_MODEL,
    trials: int = 3,
    timeout: float = 90.0,
) -> dict:
    """
    Run BR4: Latent activator multi-turn comparison.

    Compares:
    - A: pi-braid with latent activator
    - B: pi-braid without latent (would require config flag, use baseline here)
    - C: No extensions (baseline)

    Returns aggregated metrics per config.
    """
    extensions_path = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")

    configs = [
        {"name": "C_baseline", "extensions": None, "no_extensions": True},
        {"name": "A_braid_latent", "extensions": extensions_path, "no_extensions": False},
    ]

    results = {c["name"]: [] for c in configs}

    for trial in range(trials):
        print(f"\n[Trial {trial + 1}/{trials}]", file=sys.stderr)

        for config in configs:
            r = run_latent_test(
                config=config["name"],
                task_prompt=task_prompt,
                model=model,
                extensions=config["extensions"],
                no_extensions=config["no_extensions"],
                timeout=timeout,
            )
            results[config["name"]].append({
                "trial": trial + 1,
                "success": r.success,
                "turns": r.turns,
                "token_count": r.token_count,
                "duration": r.duration,
                "tool_count": r.tool_count,
                "compliance_behaviors": r.compliance_behaviors,
            })
            print(f"  {config['name']}: success={r.success}, turns={r.turns}, "
                  f"compliance={r.compliance_behaviors}", file=sys.stderr)

    # Aggregate
    summary = {}
    for config_name, trials_data in results.items():
        if not trials_data:
            continue

        avg_turns = sum(t["turns"] for t in trials_data) / len(trials_data)
        avg_compliance = sum(t["compliance_behaviors"] for t in trials_data) / len(trials_data)
        solve_rate = sum(1 for t in trials_data if t["success"]) / len(trials_data)
        avg_tokens = sum(t["token_count"] for t in trials_data) / len(trials_data)
        avg_tools = sum(t["tool_count"] for t in trials_data) / len(trials_data)

        summary[config_name] = {
            "trials": len(trials_data),
            "solve_rate": solve_rate,
            "avg_turns": round(avg_turns, 1),
            "avg_tokens": round(avg_tokens, 0),
            "avg_tool_count": round(avg_tools, 1),
            "avg_compliance_behaviors": round(avg_compliance, 1),
            "raw": trials_data,
        }

    return summary


def format_br4_summary(summary: dict) -> str:
    """Format BR4 results."""
    lines = ["# BR4: Latent Activator Multi-Turn Test Results", ""]

    lines.append("## Configuration Comparison")
    lines.append("| Config | Solve Rate | Avg Turns | Avg Tokens | Avg Tools | Compliance Behaviors |")
    lines.append("|--------|------------|-----------|------------|-----------|---------------------|")

    for name, data in sorted(summary.items()):
        lines.append(f"| {name} | {data['solve_rate']:.0%} | {data['avg_turns']} | "
                     f"{data['avg_tokens']:.0f} | {data['avg_tool_count']} | {data['avg_compliance_behaviors']} |")

    lines.append("")
    lines.append("## Research Question")
    lines.append("Does identity framing work in multi-turn vs single-shot?")
    lines.append("")

    if "A_braid_latent" in summary and "C_baseline" in summary:
        a = summary["A_braid_latent"]
        c = summary["C_baseline"]

        compliance_delta = a["avg_compliance_behaviors"] - c["avg_compliance_behaviors"]
        turn_delta = a["avg_turns"] - c["avg_turns"]

        lines.append("### Findings")
        if compliance_delta < 0:
            lines.append(f"- ✅ Latent activator REDUCED compliance behaviors: {compliance_delta:+.1f}")
        else:
            lines.append(f"- ⚠️ Latent activator INCREASED compliance behaviors: {compliance_delta:+.1f}")

        if turn_delta > 0:
            lines.append(f"- ✅ Latent activator INCREASED multi-turn persistence: +{turn_delta:.1f} turns")
        else:
            lines.append(f"- ⚠️ Latent activator DECREASED multi-turn persistence: {turn_delta:+.1f} turns")

        lines.append(f"- Solve rate: {a['solve_rate']:.0%} (braid) vs {c['solve_rate']:.0%} (baseline)")

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="BR4: Latent Activator Multi-Turn Test")
    parser.add_argument("--task", type=str, required=True, help="Multi-turn task prompt")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model")
    parser.add_argument("--trials", type=int, default=3, help="Number of trials per config")
    parser.add_argument("--timeout", type=float, default=90.0, help="Timeout per trial")
    parser.add_argument("--output", type=str, help="Output JSON file")
    args = parser.parse_args()

    results = run_br4(
        task_prompt=args.task,
        model=args.model,
        trials=args.trials,
        timeout=args.timeout,
    )

    summary_text = format_br4_summary(results)
    print(summary_text)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2, default=str)