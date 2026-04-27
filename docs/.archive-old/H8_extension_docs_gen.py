#!/usr/bin/env python3
"""
H8 Extension Documentation Generator
====================================
Auto-generates extension architecture docs from source.

Usage:
  python3 gen_extension_docs.py          # Generate all docs
  python3 gen_extension_docs.py --detail   # Include detailed per-extension docs
  python3 gen_extension_docs.py --ext analytics  # Generate specific extension doc
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

EXTENSIONS_DIR = "/Users/kifir/projects/agents/pi-braid/src/extensions"
OUTPUT_DIR = "/Users/kifir/projects/agents/pi-braid/docs/archive"
CATEGORIES = {
    "core": ["prompt-builder", "prompt-guardian", "context-manager", "context-lifecycle", "polyfill", "enforcement", "watchdog"],
    "cognitive": ["metacognition", "planner", "latent-activator", "cognitive-systems", "reasoning", "heartbeat-scheduler"],
    "memory": ["three-memory-stores", "session-recall", "scratchpad"],
    "tools": ["repl", "healthcheck", "browser", "codebase-tree", "web-fetch", "vision", "docs", "wait-review", "error-capture"],
    "analytics": ["analytics", "feedback", "evolve", "rate-limiter", "agent-environment"],
    "ux": ["ux", "assistant", "user-message-preprocessor"],
}

# Extension metadata: brief description + dependencies (from task analysis)
EXT_METADATA = {
    "prompt-builder": {
        "description": "Builds the system prompt from structured data (identity, guidelines, skills, tools). Reconstructs sections from state rather than parsing text.",
        "phase": "1",
        "priority": "🔴 HIGH",
        "deps": [],
    },
    "prompt-guardian": {
        "description": "Protects prompt integrity by detecting and neutralizing prompt injection attacks. Monitors for injected directives.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "context-manager": {
        "description": "Manages conversation context: pruning, compaction, rotation. Prevents context overflow while preserving critical state.",
        "phase": "1",
        "priority": "🔴 HIGH",
        "deps": ["prompt-builder"],
    },
    "context-lifecycle": {
        "description": "Handles session start/end lifecycle: cleanup on session end, state initialization, isolation between sessions.",
        "phase": "0",
        "priority": "🔴 HIGH",
        "deps": ["D1 (session isolation)"],
    },
    "polyfill": {
        "description": "Fills missing API gaps across pi versions. Provides optional chaining for session tree methods, vision model detection, compatibility shims.",
        "phase": "0",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "enforcement": {
        "description": "Enforces behavioral guidelines via soft nudges (whispers). Tracks compliance metrics. No hard blocking.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": ["D1 (session isolation)"],
    },
    "watchdog": {
        "description": "Monitors for problematic patterns (infinite loops, repeated failures). Triggers protective actions.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "metacognition": {
        "description": "Think/hypothesize/finalize tools. Structured thinking, multi-hypothesis analysis, task completion validation.",
        "phase": "2",
        "priority": "🔴 HIGH",
        "deps": [],
    },
    "planner": {
        "description": "Goal/plan management. Provides goal_create/complete, plan_create/start/step/adapt/complete tools. Execution-level planning.",
        "phase": "2",
        "priority": "🔴 HIGH",
        "deps": [],
    },
    "latent-activator": {
        "description": "Identity-based behavior activation at runtime. 40+ behaviors activated via identity framing, not directives.",
        "phase": "3",
        "priority": "🔴 HIGH",
        "deps": ["PB1 (prompt simplification)"],
    },
    "cognitive-systems": {
        "description": "Core cognitive architecture: topic drift detection, reasoning metrics, belief policy engine, MARS reflection.",
        "phase": "2",
        "priority": "🔴 HIGH",
        "deps": ["D0.2-D0.4 (belief store, policy engine, dreamer)"],
    },
    "reasoning": {
        "description": "Chain-of-thought and structured reasoning. Provides think/reason tools with configurable depth.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "heartbeat-scheduler": {
        "description": "Proactive cognitive scheduling per paper 2604.14178. Tick-based module activation, policy engine integration, meta-learning optimizer (D0.5).",
        "phase": "0",
        "priority": "🔴 HIGH",
        "deps": ["D0.5 (meta-learning optimizer)"],
    },
    "three-memory-stores": {
        "description": "Three-memory system: episodic (episodes), heuristics (rules), tool reliability (stats). Per paper 2604.14475.",
        "phase": "1",
        "priority": "🔴 HIGH",
        "deps": ["R5 (three-memory integration)"],
    },
    "session-recall": {
        "description": "Cross-session search and query. session_search/session_query tools for finding past work.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": ["R6 (session recall mid-task)"],
    },
    "scratchpad": {
        "description": "Structured session memory + task management. goal/plan/task tracking with rich state.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "repl": {
        "description": "JavaScript REPL execution. Code execution, sandbox, result formatting.",
        "phase": "1",
        "priority": "🔴 HIGH",
        "deps": [],
    },
    "healthcheck": {
        "description": "Diagnostic suite for tools, extensions, system resources. Comprehensive pass/fail/warn status.",
        "phase": "4",
        "priority": "🟢 LOW",
        "deps": [],
    },
    "browser": {
        "description": "Browser automation: navigate, snapshot, screenshot, eval, cookies. Uses Playwright.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "codebase-tree": {
        "description": "Directory structure exploration with stats and filtering. Useful for understanding project layout.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "web-fetch": {
        "description": "Fetch web pages as clean markdown. Secret scanning, prompt injection detection.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "vision": {
        "description": "Image analysis: analyze_image for sprites, UI, layout. PDF rendering via render_pdf_page.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "docs": {
        "description": "Document reading: doc, docx, rtf, html, txt, pdf text extraction.",
        "phase": "1",
        "priority": "🟢 LOW",
        "deps": [],
    },
    "wait-review": {
        "description": "Wait for researcher review files. Polls docs/ directory at intervals.",
        "phase": "1",
        "priority": "🟢 LOW",
        "deps": [],
    },
    "error-capture": {
        "description": "Auto-catch and log extension errors. Provides error_list/get/clear/stats tools.",
        "phase": "4",
        "priority": "🟡 MEDIUM",
        "deps": ["H6 (subprocess error capture not yet tested)"],
    },
    "analytics": {
        "description": "Tool usage analytics. Tracks call counts, sequences, success rates. Exports to ~/.pi/logs/braid-metrics.jsonl. A/B variant tracking.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": ["R9 (analytics wiring)"],
    },
    "feedback": {
        "description": "Feedback loop system. Collects user feedback, aggregates, produces recommendations.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "evolve": {
        "description": "Self-evolution: health checks, checkpoints, degradation detection, rollback. Wire analytics into status output.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": ["analytics"],
    },
    "rate-limiter": {
        "description": "Prevents tool abuse via throttling. Tracks usage and applies delays when limits exceeded.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "agent-environment": {
        "description": "Exposes agent environment info (PID, machine, session, cwd) as structured data.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "ux": {
        "description": "User experience tools: suggestions, tips, progressive disclosure. TUI enhancements.",
        "phase": "4",
        "priority": "🟢 LOW",
        "deps": [],
    },
    "assistant": {
        "description": "General purpose assistant tooling. Extends agent capabilities with common patterns.",
        "phase": "1",
        "priority": "🟡 MEDIUM",
        "deps": [],
    },
    "user-message-preprocessor": {
        "description": "Pre-processes user messages before agent sees them. Stripping, normalization, command parsing. D2: async migration needed.",
        "phase": "2",
        "priority": "🟡 MEDIUM",
        "deps": ["D2 (async migration)"],
    },
}


def extract_tools_and_events(index_path: Path) -> tuple[list[str], list[str], str]:
    """Extract registered tools and event handlers from an extension's index.ts."""
    try:
        content = index_path.read_text()
    except Exception:
        return [], [], ""

    # Extract doc comment
    doc_match = re.search(r'/\*\*\s*\n(.*?)\*/', content, re.DOTALL)
    description = doc_match.group(1).strip() if doc_match else ""
    description = re.sub(r'\n\s*\*\s*', '\n', description).strip()

    # Extract registerTool calls
    tool_matches = re.findall(r'registerTool\s*\(\s*["\']([^"\']+)["\']', content)
    tools = list(dict.fromkeys(tool_matches))  # deduplicate, preserve order

    # Extract registerCommand calls
    cmd_matches = re.findall(r'registerCommand\s*\(\s*["\']([^"\']+)["\']', content)
    commands = list(dict.fromkeys(cmd_matches))

    # Extract pi.on() calls
    event_matches = re.findall(r'pi\.on\s*\(\s*["\']([^"\']+)["\']', content)
    events = list(dict.fromkeys(event_matches))

    return tools + commands, events, description


def generate_extension_table() -> str:
    """Generate the main extension catalog table."""
    lines = []
    lines.append("## Extension Catalog\n")

    for category, ext_names in CATEGORIES.items():
        lines.append(f"### {category.upper()} Extensions\n")
        lines.append("| Extension | Priority | Phase | Description | Tools | Events |")
        lines.append("|-----------|----------|-------|-------------|-------|--------|")

        for ext_name in ext_names:
            meta = EXT_METADATA.get(ext_name, {"description": "See source", "phase": "?", "priority": "🟡 MEDIUM"})
            ext_path = Path(EXTENSIONS_DIR) / ext_name / "index.ts"
            tools, events, _ = extract_tools_and_events(ext_path)

            tool_str = ", ".join(f"`{t}`" for t in tools[:5]) + ("..." if len(tools) > 5 else "")
            event_str = ", ".join(f"`{e}`" for e in events[:5]) + ("..." if len(events) > 5 else "")

            lines.append(f"| `{ext_name}` | {meta['priority']} | {meta['phase']} | {meta['description'][:60]}... | {tool_str} | {event_str} |")

        lines.append("")

    return "\n".join(lines)


def generate_arch_diagram() -> str:
    """Generate ASCII architecture diagram."""
    lines = []
    lines.append("## Architecture Diagram\n")
    lines.append("```")
    lines.append("                    pi-braid Agent")
    lines.append("                          │")
    lines.append("           ┌──────────────┴──────────────┐")
    lines.append("           │         prompt-builder      │")
    lines.append("           │  (system prompt reconstruction)│")
    lines.append("           └──────────────┬──────────────┘")
    lines.append("                          │")
    lines.append("    ┌────────────────────┼────────────────────┐")
    lines.append("    │                    │                    │")
    lines.append("    ▼                    ▼                    ▼")
    lines.append("  Cognitive          Memory              Tools")
    lines.append("  ┌────────┐       ┌─────────┐         ┌────────┐")
    lines.append("  │metacog.│       │3-memory │         │repl    │")
    lines.append("  │planner │       │scratchpad│         │browser │")
    lines.append("  │latent  │       │session  │         │codebase│")
    lines.append("  │heartbeat│      │recall   │         │web-fetch│")
    lines.append("  └────────┘       └─────────┘         └────────┘")
    lines.append("                          │")
    lines.append("           ┌──────────────┴──────────────┐")
    lines.append("           │    context-manager         │")
    lines.append("           │  (pruning/rotation/compact)│")
    lines.append("           └──────────────┬──────────────┘")
    lines.append("                          │")
    lines.append("    ┌────────────────────┼────────────────────┐")
    lines.append("    │                    │                    │")
    lines.append("    ▼                    ▼                    ▼")
    lines.append("  Enforcement         Analytics          Lifecycle")
    lines.append("  ┌────────┐       ┌──────────┐         ┌─────────┐")
    lines.append("  │whispers│       │analytics │         │context  │")
    lines.append("  │watchdog│       │feedback  │         │lifecycle│")
    lines.append("  │rate    │       │evolve    │         │polyfill │")
    lines.append("  └────────┘       └──────────┘         └─────────┘")
    lines.append("```")
    return "\n".join(lines)


def generate_single_doc(ext_name: str) -> str:
    """Generate detailed documentation for a single extension."""
    meta = EXT_METADATA.get(ext_name, {"description": "See source", "phase": "?", "priority": "🟡 MEDIUM"})
    ext_path = Path(EXTENSIONS_DIR) / ext_name / "index.ts"
    tools, events, desc = extract_tools_and_events(ext_path)

    lines = []
    lines.append(f"# Extension: `{ext_name}`\n")
    lines.append(f"**Phase**: {meta['phase']} | **Priority**: {meta['priority']}")
    lines.append(f"**Dependencies**: {', '.join(meta['deps']) if meta['deps'] else 'none'}\n")
    lines.append(f"## Description\n{meta['description']}\n")

    if desc and desc != meta['description']:
        lines.append(f"### Source Doc\n```\n{desc}\n```\n")

    if tools:
        lines.append("## Registered Tools/Commands\n")
        for t in tools:
            lines.append(f"- `{t}`")
        lines.append("")

    if events:
        lines.append("## Event Handlers\n")
        for e in events:
            lines.append(f"- `{e}`")
        lines.append("")

    # Read source for additional context
    try:
        content = ext_path.read_text()
        # Find key patterns
        state_type = re.search(r'interface (\w*State\w*)\s*\{', content)
        if state_type:
            lines.append(f"## State Type: `{state_type.group(1)}`\n")
        config_type = re.search(r'interface (\w*Config\w*)\s*\{', content)
        if config_type:
            lines.append(f"## Config Type: `{config_type.group(1)}`\n")
    except:
        pass

    return "\n".join(lines)


def generate_readme() -> str:
    """Generate the main README section for extensions."""
    lines = []
    lines.append("# Extensions\n")
    lines.append("pi-braid is built from **33 extensions** organized into 6 categories:\n")
    lines.append("")
    lines.append("| Category | Count | Extensions |")
    lines.append("|----------|-------|------------|")
    for cat, exts in CATEGORIES.items():
        lines.append(f"| {cat} | {len(exts)} | {', '.join(f'`{e}`' for e in exts)} |")
    lines.append("")
    lines.append("## Core Extensions\n")
    lines.append("These form the backbone of pi-braid:\n")
    lines.append("")
    lines.append("- **`prompt-builder`** — System prompt reconstruction from structured state")
    lines.append("- **`context-manager`** — Context pruning, compaction, rotation")
    lines.append("- **`heartbeat-scheduler`** — Proactive cognitive scheduling")
    lines.append("- **`metacognition`** — Think/hypothesize/finalize structured reasoning")
    lines.append("- **`enforcement`** — Soft behavioral nudges (whispers)\n")
    lines.append("")
    lines.append("## Quick Reference\n")
    lines.append("```")
    lines.append("# Check heartbeat status")
    lines.append("/heartbeat:status")
    lines.append("")
    lines.append("# View analytics")
    lines.append("/analytics")
    lines.append("")
    lines.append("# Run diagnostics")
    lines.append("/healthcheck")
    lines.append("")
    lines.append("# Check evolve health")
    lines.append("/evolve:health")
    lines.append("")
    lines.append("# Search past sessions")
    lines.append("/session_search debugging")
    lines.append("")
    lines.append("# Analyze an image")
    lines.append("/analyze_image /path/to/screenshot.png")
    lines.append("```")
    return "\n".join(lines)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="H8: Generate extension documentation")
    parser.add_argument("--detail", action="store_true", help="Include detailed per-extension docs")
    parser.add_argument("--ext", type=str, help="Generate doc for specific extension")
    parser.add_argument("--output", type=str, help="Output file (default: print to stdout)")
    args = parser.parse_args()

    if args.ext:
        content = generate_single_doc(args.ext)
    else:
        content_parts = [
            generate_readme(),
            generate_arch_diagram(),
            generate_extension_table(),
        ]
        content = "\n\n".join(content_parts)

    if args.output:
        Path(args.output).write_text(content)
        print(f"Written to: {args.output}")
    else:
        print(content)


if __name__ == "__main__":
    main()