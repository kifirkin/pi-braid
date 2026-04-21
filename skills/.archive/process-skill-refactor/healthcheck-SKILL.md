---
name: healthcheck
description: "Run agent self-diagnostic to validate all tools and capabilities, and clean up stale processes. Use when troubleshooting tool failures, after setup, verifying environment readiness, or when pi instances accumulate and slow down the system."
---

# Healthcheck

## Core Tools

Read a small file · Write temp file and verify · Edit existing file · Run bash commands · Grep search · Find files · List directory

## Cognitive Tools

Think (observation/decision/reason) · Hypothesize · Scratchpad

## Management Tools

Goals (create, complete, delete) · Plans (create, complete steps) · Tasks (add, complete) · Memory (store, recall, search) · Snapshots (create, list, delete) · Metrics (get, detect degradation)

## Infrastructure

REPL (execute simple code) · Sub-agent (spawn and verify) · Time status · Resource usage

## Environment

Extensions loaded (check tool list) · Skills available · ~/.pi directory accessible

## Interpretation

- **All pass** → fully operational
- **Some warns** → degraded but functional
- **Any fails** → capability compromised

## Failure Recovery

Permission denied on write → check ~/.pi permissions
Command not found in bash → verify PATH has node/npm/git
REPL timeout → check system resources
Memory store fails → verify ~/.pi writable
Snapshot create fails → check disk space

## Process Cleanup

```bash
~/.pi/agent/skills/process-hygiene/cleanup.sh --dry-run  # preview
~/.pi/agent/skills/process-hygiene/cleanup.sh            # actually clean
```

Cleans: pi processes, orphaned node children, stale bash subprocesses, old tmux sessions, temp dirs in `/tmp/modern-bench-*` and `/tmp/pi-*`. Safety: never kills processes from last 5 minutes.
