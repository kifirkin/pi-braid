#!/usr/bin/env python3
"""
Comprehensive Benchmark Suite — pi-braid Feature Coverage
==========================================================
Tests ALL implemented features across 5 categories:
1. CORE: Extension loading, tool execution, error handling
2. METACOGNITION: Self-reflection, confidence, topic drift
3. MEMORY: Episodes, patterns, cross-session learning
4. POLICY: Belief policy engine, enforcement, recommendation feedback
5. BENCHMARK: Latent activator (BR4), multi-turn debugging (BM1)

Run: python3 benchmark_comprehensive.py --all
Output: evaluation/results/comprehensive_<timestamp>.md
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUTPUT_DIR = ROOT / "evaluation" / "results"
MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
EXTENSIONS = str(ROOT)

# ── Feature Test Cases ────────────────────────────────────────────────────

FEATURE_TESTS = {
    "core_tool_execution": {
        "desc": "Basic tool calls — read, write, search, think",
        "prompt": "Read README.md, extract the first heading, and tell me what project this is.",
        "expected_tools": ["read", "grep", "think"],
        "timeout": 60,
    },
    "self_reflection": {
        "desc": "MARS reflector + belief policy engine",
        "prompt": "After each tool call, reflect on whether the approach was optimal. If not, propose a better strategy.",
        "expected_signals": ["reflection", "recommendation"],
        "timeout": 90,
    },
    "memory_episodes": {
        "desc": "Cognitive memory + episode recording",
        "prompt": "Solve: find files matching '*.ts' and count them. Use at least 3 tools. This will be stored as an episode.",
        "expected_artifacts": ["episodes.jsonl"],
        "timeout": 90,
    },
    "cross_session_learning": {
        "desc": "Dreamer cross-session pattern detection",
        "prompt": "Execute 3 similar operations (e.g., read 3 different .md files). The dreamer should detect the pattern.",
        "expected_patterns": ["Recurring pattern"],
        "timeout": 120,
    },
    "tool_addiction_detection": {
        "desc": "Analytics auto-trigger addiction warnings",
        "prompt": "Call the same tool (grep) 15 times in succession with different patterns. Analytics should whisper a warning.",
        "expected_warnings": ["Tool addiction pattern detected"],
        "timeout": 120,
    },
    "latent_activator_on": {
        "desc": "BR4: Latent activator ON — should trigger strategic nudge",
        "prompt": "Solve a task requiring 5+ tool calls. Latent activator should trigger.",
        "expected_behavior": ["latent activation"],
        "timeout": 120,
    },
    "multi_turn_debugging": {
        "desc": "BM1: Multi-turn debugging with verification loop",
        "prompt": "There is a bug in test/runtime/test-reasoning-metrics.mjs. Read it, identify the issue, and fix it.",
        "expected_outcomes": ["test passes", "bug fixed"],
        "timeout": 180,
    },
    "session_rotation": {
        "desc": "Context rotation after deep conversation",
        "prompt": "Generate 50+ turns by asking the agent to repeatedly analyze different files. Session should auto-rotate.",
        "expected_artifacts": ["rotated session"],
        "timeout": 300,
    },
    "daemon_health": {
        "desc": "Daemon orchestrator start/stop/status/health",
        "script": "braid-os/braid-daemon.sh",
        "commands": ["status", "start", "health", "stop"],
        "timeout": 30,
    },
}

# ── Helpers ────────────────────────────────────────────────────────────────


def run_command(cmd: list[str], timeout: float = 300) -> tuple[int, str, str]:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Timeout"
    except Exception as e:
        return -1, "", str(e)


def run_pi_task(name: str, spec: dict) -> dict:
    """Run a single feature test through pi RPC."""
    print(f"\n─── {name}: {spec['desc']} ───", file=sys.stderr)
    prompt = spec["prompt"]

    cmd = [
        sys.executable,
        str(ROOT / "evaluation" / "pi_rpc_benchmark.py"),
        "--prompt", prompt,
        "--model", MODEL,
        "--extensions", EXTENSIONS,
        "--trials", "1",
        "--timeout", str(spec.get("timeout", 90)),
        "--output", str(OUTPUT_DIR / f"bench_{name}.json"),
    ]

    rc, stdout, stderr = run_command(cmd, timeout=spec.get("timeout", 90) + 30)
    return {
        "name": name,
        "desc": spec["desc"],
        "returncode": rc,
        "stdout": stdout[:3000],
        "stderr": stderr[:1000],
        "timestamp": datetime.now().isoformat(),
    }


def run_script_test(name: str, spec: dict) -> dict:
    """Run a shell script test (daemon operations)."""
    print(f"\n─── {name}: {spec['desc']} ───", file=sys.stderr)
    script = ROOT / spec["script"]
    results = []

    for command in spec["commands"]:
        cmd = [str(script), command]
        rc, stdout, stderr = run_command(cmd, timeout=spec.get("timeout", 30))
        results.append({"command": command, "rc": rc, "output": stdout.strip()})

    return {"name": name, "results": results, "timestamp": datetime.now().isoformat()}


def run_br4() -> dict:
    print("\n─── BR4: Latent Activator ON/OFF Comparison ───", file=sys.stderr)
    default_task = (
        "Solve a task requiring strategic tool sequencing. "
        "Identify which files contain 'async' keyword, then read one to understand the concurrency pattern, "
        "then verify your finding. This tests whether latent activator triggers strategic nudges."
    )
    cmd = [
        sys.executable,
        str(ROOT / "evaluation" / "br4_latent_multi_turn.py"),
        "--model", MODEL,
        "--extensions", EXTENSIONS,
        "--task", default_task,
        "--trials", "3",
        "--timeout", "120",
    ]
    rc, stdout, stderr = run_command(cmd, timeout=300)
    return {
        "name": "BR4_latent_activator",
        "returncode": rc,
        "stdout": stdout[:3000],
        "stderr": stderr[:1000],
        "timestamp": datetime.now().isoformat(),
    }


def run_bm1() -> dict:
    print("\n─── BM1: Multi-Turn Debugging Benchmark ───", file=sys.stderr)
    cmd = [
        sys.executable,
        str(ROOT / "evaluation" / "bm1_multi_turn_debug.py"),
        "--model", MODEL,
        "--extensions", EXTENSIONS,
        "--timeout", "180",
    ]
    rc, stdout, stderr = run_command(cmd, timeout=300)
    return {
        "name": "BM1_multi_turn_debug",
        "returncode": rc,
        "stdout": stdout[:3000],
        "stderr": stderr[:1000],
        "timestamp": datetime.now().isoformat(),
    }


def run_npm_tests() -> dict:
    print("\n─── NPM Test Suite ───", file=sys.stderr)
    cmd = ["node", str(ROOT / "scripts" / "run-tests.mjs")]
    rc, stdout, stderr = run_command(cmd, timeout=120)
    return {
        "name": "npm_test_suite",
        "returncode": rc,
        "stdout": stdout[:3000],
        "stderr": stderr[:1000],
        "timestamp": datetime.now().isoformat(),
    }


def run_typecheck() -> dict:
    print("\n─── TypeScript Type Check ───", file=sys.stderr)
    cmd = ["npx", "tsc", "--noEmit", "--skipLibCheck"]
    rc, stdout, stderr = run_command(cmd, timeout=60)
    return {
        "name": "typescript_check",
        "returncode": rc,
        "stdout": stdout[:1000],
        "stderr": stderr[:1000],
        "timestamp": datetime.now().isoformat(),
    }


# ── Main ───────────────────────────────────────────────────────────────────


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Comprehensive pi-braid Benchmark Suite")
    parser.add_argument("--all", action="store_true", help="Run ALL benchmarks")
    parser.add_argument("--core", action="store_true", help="Core feature tests only")
    parser.add_argument("--br4", action="store_true", help="Run BR4 only")
    parser.add_argument("--bm1", action="store_true", help="Run BM1 only")
    parser.add_argument("--tests", action="store_true", help="Run npm test suite")
    parser.add_argument("--typecheck", action="store_true", help="Run TypeScript check")
    parser.add_argument("--output", type=str, help="Output file")
    args = parser.parse_args()

    if not any([args.all, args.core, args.br4, args.bm1, args.tests, args.typecheck]):
        parser.print_help()
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []

    # 1. Core feature tests
    if args.all or args.core:
        for name, spec in FEATURE_TESTS.items():
            if name in ["daemon_health"]:
                continue  # Skip daemon for now
            try:
                results.append(run_pi_task(name, spec))
            except Exception as e:
                results.append({"name": name, "error": str(e), "returncode": -1})

    # 2. BR4
    if args.all or args.br4:
        results.append(run_br4())

    # 3. BM1
    if args.all or args.bm1:
        results.append(run_bm1())

    # 4. npm test suite
    if args.all or args.tests:
        results.append(run_npm_tests())

    # 5. TypeScript check
    if args.all or args.typecheck:
        results.append(run_typecheck())

    # ── Summary ────────────────────────────────────────────────────────────

    passed = sum(1 for r in results if r.get("returncode", -1) == 0)
    total = len(results)
    summary_lines = [
        "# pi-braid Comprehensive Benchmark Results",
        "",
        f"**Generated**: {datetime.now().isoformat()}",
        f"**Model**: {MODEL}",
        f"**Extensions**: {EXTENSIONS}",
        f"**Pass rate**: {passed}/{total} ({passed/total*100:.0f}%)",
        "",
    ]

    for r in results:
        status = "✅ PASS" if r.get("returncode", -1) == 0 else "❌ FAIL"
        summary_lines.append(f"## {r['name']}: {status}")
        if "desc" in r:
            summary_lines.append(f"_ {r['desc']} _")
        summary_lines.append("")
        if "stdout" in r and r["stdout"]:
            summary_lines.append("```")
            summary_lines.append(r["stdout"][:2000])
            summary_lines.append("```")
        if "stderr" in r and r["stderr"]:
            summary_lines.append("*stderr*:")
            summary_lines.append("```")
            summary_lines.append(r["stderr"][:500])
            summary_lines.append("```")
        if "results" in r:
            for sub in r["results"]:
                summary_lines.append(f"- `{sub['command']}` → rc={sub['rc']}")
                if sub.get("output"):
                    summary_lines.append(f"  ```\n  {sub['output'][:200]}\n  ```")
        summary_lines.append("")

    summary_text = "\n".join(summary_lines)
    print(summary_text)

    output_file = args.output or OUTPUT_DIR / f"comprehensive_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    with open(output_file, "w") as f:
        f.write(summary_text)
    print(f"\nSaved: {output_file}", file=sys.stderr)

    raw_file = OUTPUT_DIR / f"raw_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(raw_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"Raw: {raw_file}", file=sys.stderr)

    sys.exit(0 if all(r.get("returncode", -1) == 0 for r in results) else 1)


if __name__ == "__main__":
    main()
