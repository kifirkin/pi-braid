#!/usr/bin/env python3
"""
BM2: Code Quality Benchmark
===========================
Assesses code quality beyond pass/fail.

Problem: Pass rate ignores robustness, edge cases, documentation.

Metrics:
- eslint score (linting compliance)
- cyclomatic complexity (code complexity)
- edge case coverage (tests for edge cases)
- documentation score (JSDoc, comments)
- idiomatic usage (language-specific patterns)

This benchmark runs against code the agent produces and scores it.
"""

import json
import os
import re
import subprocess
import sys
import time
import tempfile
from dataclasses import dataclass
from typing import Optional

DEFAULT_MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
DEFAULT_EXTENSIONS = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")


@dataclass
class QualityMetrics:
    task_id: str = ""
    task_name: str = ""

    # Core quality
    correctness: float = 0.0  # Does it work?
    lint_score: float = 0.0  # eslint compliance
    complexity_score: float = 0.0  # Cyclomatic complexity
    edge_case_score: float = 0.0  # Edge case coverage
    doc_score: float = 0.0  # Documentation
    idiomatic_score: float = 0.0  # Idiomatic usage

    overall: float = 0.0
    error: Optional[str] = None


def check_eslint(code: str, language: str = "javascript") -> float:
    """
    Check eslint compliance of generated code.
    Returns 0-1 score based on error count.
    """
    if language not in ("javascript", "typescript"):
        return 0.5  # No linting available for other languages

    with tempfile.NamedTemporaryFile(mode="w", suffix=f".{language}", delete=False) as f:
        f.write(code)
        filepath = f.name

    try:
        result = subprocess.run(
            ["npx", "eslint", filepath, "--quiet"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        # eslint returns 0 on success, 1 on lint errors
        if result.returncode == 0:
            return 1.0
        # Count errors from stderr
        error_count = result.stderr.count("error")
        # Normalize: 0 errors = 1.0, 10+ errors = 0
        return max(0, 1.0 - error_count * 0.1)
    except Exception:
        return 0.5  # Default if eslint not available
    finally:
        os.unlink(filepath)


def check_complexity(code: str, language: str = "javascript") -> float:
    """
    Estimate cyclomatic complexity from code structure.
    Lower is better. Score is inverse (1 = simple, 0 = very complex).
    """
    if not code:
        return 0.0

    # Count branching constructs
    branching = 0
    branching += len(re.findall(r'\bif\b', code))
    branching += len(re.findall(r'\belse\b', code))
    branching += len(re.findall(r'\bfor\b', code))
    branching += len(re.findall(r'\bwhile\b', code))
    branching += len(re.findall(r'\bswitch\b', code))
    branching += len(re.findall(r'\bcase\b', code))
    branching += len(re.findall(r'\bcatch\b', code))
    branching += len(re.findall(r'\?\s*[^:]*:', code))  # ternary
    branching += len(re.findall(r'\b&&\b', code))
    branching += len(re.findall(r'\b\|\|\b', code))

    # Lines of code (approximate)
    loc = len(code.split('\n'))

    # Complexity ratio: branching per 10 lines
    if loc == 0:
        return 0.0

    ratio = branching / (loc / 10)
    # Score: 0 branching per 10 lines = 1.0, 20+ = 0
    return max(0, 1.0 - ratio / 20)


def check_edge_cases(code: str, language: str = "javascript") -> float:
    """
    Check for edge case handling in generated code.
    Looks for: null checks, empty arrays, error handling, boundary conditions.
    """
    if not code:
        return 0.0

    score = 0.0
    checks = 0

    # Null/undefined checks
    if re.search(r'if\s*\(\s*!?[\w.]+\s*(===|==|!==|!=)\s*(null|undefined)', code):
        score += 1
    checks += 1

    # Optional chaining
    if '?.' in code or '?.(' in code:
        score += 1
    checks += 1

    # Error handling (try/catch)
    if re.search(r'try\s*\{', code) and re.search(r'catch\s*\(', code):
        score += 1
    checks += 1

    # Empty state handling
    if re.search(r'(length\s*===\s*0|length\s*===?\s*0|isEmpty|empty)', code):
        score += 1
    checks += 1

    # Default values
    if re.search(r'(defaults?|fallback|initial)', code, re.I):
        score += 0.5
    checks += 1

    # Boundary checks (array bounds, etc.)
    if re.search(r'(index\s*[<>]=?\s*\w+|length\s*[<>]=?)', code):
        score += 1
    checks += 1

    return score / checks if checks > 0 else 0.5


def check_documentation(code: str, language: str = "javascript") -> float:
    """
    Check documentation quality (JSDoc, comments).
    """
    if not code:
        return 0.0

    # JSDoc comments
    jsdoc_count = len(re.findall(r'/\*\*[\s\S]*?\*/', code))

    # Line comments
    line_comment_count = len(re.findall(r'^\s*//', code, re.MULTILINE))

    # Function declarations
    func_count = len(re.findall(r'function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|class\s+\w+', code))

    if func_count == 0:
        return 0.0

    # Ratio of documented to total
    jsdoc_ratio = min(jsdoc_count / func_count, 1.0)
    comment_ratio = min(line_comment_count / (func_count * 2), 1.0)

    return (jsdoc_ratio * 0.6 + comment_ratio * 0.4)


def check_idiomatic(code: str, language: str = "javascript") -> float:
    """
    Check for idiomatic language usage.
    Penalize: callback hell, manual loops where map/filter/reduce exist,
    manual string building where template literals exist.
    """
    if not code:
        return 0.0

    score = 1.0

    # Penalize callback hell
    nesting = max(0, code.count('.then(') + code.count('.catch(') - 2)
    score -= nesting * 0.1

    # Penalize manual loops where functional alternatives exist
    has_manual_loop = bool(re.search(r'for\s*\(\s*(?:let|var)\s+\w+\s* of\s+', code))
    has_array_op = bool(re.search(r'\.(?:map|filter|reduce|forEach|find|some|every)\s*\(', code))
    if has_manual_loop and not has_array_op:
        score -= 0.2

    # Penalize string concatenation over template literals
    has_concat = bool(re.search(r'["\']\s*\+\s*\w+\s*\+\s*["\']|["\']\s*\+', code))
    has_template = '`' in code
    if has_concat and not has_template:
        score -= 0.1

    # Penalize var over let/const
    if re.search(r'\bvar\s+\w+', code):
        score -= 0.1

    # Penalize == over === (in TypeScript)
    if language == "typescript" and re.search(r'[^=!]==[^=]', code):
        score -= 0.2

    return max(0, min(score, 1.0))


def score_code_quality(code: str, language: str = "javascript") -> dict[str, float]:
    """Compute all quality scores for generated code."""
    return {
        "lint": check_eslint(code, language),
        "complexity": check_complexity(code, language),
        "edge_cases": check_edge_cases(code, language),
        "documentation": check_documentation(code, language),
        "idiomatic": check_idiomatic(code, language),
    }


def format_bm2_report(results: list[QualityMetrics]) -> str:
    """Format BM2 results as a markdown report."""
    lines = ["# BM2: Code Quality Benchmark Results", ""]

    # Per-task table
    lines.append("## Per-Task Quality Scores")
    lines.append("| Task | Correct | Lint | Complex | Edge | Docs | Idiomatic | Overall |")
    lines.append("|------|---------|------|---------|------|------|-----------|---------|")
    for r in results:
        lines.append(f"| {r.task_name[:25]} | {r.correctness:.0%} | "
                     f"{r.lint_score:.0%} | {r.complexity_score:.0%} | "
                     f"{r.edge_case_score:.0%} | {r.doc_score:.0%} | "
                     f"{r.idiomatic_score:.0%} | {r.overall:.0%} |")

    # Aggregate
    if results:
        avg = lambda key: sum(getattr(r, key, 0) for r in results) / len(results)
        lines.append("")
        lines.append("## Aggregate Metrics")
        lines.append(f"- **Avg Correctness**: {avg('correctness'):.0%}")
        lines.append(f"- **Avg Lint Score**: {avg('lint_score'):.0%}")
        lines.append(f"- **Avg Complexity**: {avg('complexity_score'):.0%}")
        lines.append(f"- **Avg Edge Cases**: {avg('edge_case_score'):.0%}")
        lines.append(f"- **Avg Documentation**: {avg('doc_score'):.0%}")
        lines.append(f"- **Avg Idiomatic**: {avg('idiomatic_score'):.0%}")
        lines.append(f"- **Overall Score**: {avg('overall'):.0%}")
        lines.append(f"- **Total Tasks**: {len(results)}")

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="BM2: Code Quality Benchmark")
    parser.add_argument("--code", type=str, help="Code to score")
    parser.add_argument("--language", type=str, default="javascript", help="Language")
    parser.add_argument("--output", type=str, help="Output JSON file")
    args = parser.parse_args()

    if not args.code:
        print("Usage: python3 bm2_code_quality.py --code 'let x = 1;'")
        sys.exit(1)

    scores = score_code_quality(args.code, args.language)
    result = {
        **scores,
        "overall": sum(scores.values()) / len(scores),
    }

    print(json.dumps(result, indent=2))

    if args.output:
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2)