# External Tasks — implicit-framing Research Project

These tasks belong to the **implicit-framing** research project, a separate codebase from pi-braid. They are tracked here for cross-project visibility only.

## Active Tasks

| # | Task | Size | Files | Context |
|---|------|------|-------|---------|
| TIMEOUT | Mercury2 reverse_words timeout | SMALL | `evaluation/pi_rpc_fixed.py` | Increase timeout from 90s |
| IMPLICIT | Implicit vs explicit comparison | LARGE | New experiment script | "Follow the clues" vs explicit instruction |
| EXP | Behavior activation experiment | MEDIUM | `evaluation/experiment_behavior_activation.py` | `python3 experiment_behavior_activation.py --run` |

## Project Location

The implicit-framing project lives outside this repository. If you need to work on these tasks, locate the project directory (typically adjacent to pi-braid) and run from there.

## Research Context

The implicit-framing project studies how prompt framing affects agent reasoning:
- **Identity framing** ("You are Braid, a meticulous...") vs **directive framing** ("You MUST...")
- Measuring "compliance theater" — degraded reasoning quality under directive pressure
- A/B experiments comparing implicit cues vs explicit instructions

Key documents in that project:
- `implicit-framing/paper/main.tex` — LaTeX research paper
- `implicit-framing/RESEARCH_SYNTHESIS.md` — Findings summary
- `evaluation/pi_rpc_fixed.py` — RPC test harness
- `evaluation/experiment_behavior_activation.py` — A/B experiment runner

*Extracted from HANDOFF.md (Session 11–12)*
