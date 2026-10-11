---
name: healthcheck
description: "Run a structured self-diagnostic of the agent environment: verify read/write/edit/bash/grep/find/ls, cognitive and memory tools, extension and skill availability, and ~/.pi writability; interpret pass/warn/fail results and clean up stale agent processes. Use when a tool misbehaves or fails, right after setup or a config change, before starting work in a fresh environment, or when many agent instances accumulated and the machine slows down. Triggers: health check, tool diagnostic, environment readiness, stale processes, post-setup validation."
trigger: "troubleshooting tool failures, verifying environment readiness, post-setup validation, stale process cleanup, tool diagnostics"
validated: 2026-09-09
verdict: IMPROVE
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

Kill processes with these patterns:

```bash
# pi agents
pkill -f "pi.*agent" || true

# orphaned node children
pkill -f "node.*minibear" || true

# old tmux sessions
for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
  tmux kill-session -t "$s" 2>/dev/null
done

# temp dirs
rm -rf /tmp/modern-bench-* /tmp/pi-* 2>/dev/null || true
```

Safety: never kill processes from the last 5 minutes.
