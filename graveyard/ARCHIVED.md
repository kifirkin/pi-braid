# Graveyard — Archived Code

This directory holds code that was implemented during rapid prototyping but never
wired into the running extension system, or was superseded by better approaches.

For each archived item, the rationale explains:
- **What it was supposed to do**
- **Why it was abandoned**
- **What replaced it** (if anything)

## Index

| # | File | Lines | Replaced By |
|---|------|-------|-------------|
| 1 | `lib/goal-manager.ts` | 527 | scratchpad task management |
| 2 | `lib/planner.ts` | 415 | metacognition think tool |
| 3 | `lib/observatory.ts` | 384 | contrib/observatory (client-daemon) |
| 4 | `lib/edit-helper.ts` | 202 | pi's builtin edit tool |
| 5 | `lib/agent-events.ts` | 191 | lib/event-bus.ts + consolidation-channel.ts |
| 6 | `lib/tool-security.ts` | 131 | pi's SAFE_MODE env var |
| 7 | `lib/cognition-evaluator.ts` | 90 | enforcement inline tracking |
| 8 | `lib/error-classifier.ts` | 58 | never integrated |
| 9 | `extensions/enforcement/handlers/tool-registrations.ts` | 7 | commands removed 2026-04-28 |
| 10 | `extensions/memory/memory-agent-bridge/project-storage.ts` | 68 | never integrated |

## Archived Proposals

Proposals in `docs/proposals/external/` that identified cleanup work now done:

| Proposal | Reason for Archive |
|----------|-------------------|
| `DEAD- DEAD-EXTENSION-CLEANUP.md | Actions executed in this cleanup pass |
| FEATURE-AUDIT.md | Findings incorporated into codebase state |
| DOC-AUDIT.md | Doc cleanup executed in this pass |