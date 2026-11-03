---
name: healthcheck
description: "Run a structured self-diagnostic of the agent environment: verify read/write/edit/bash/grep/find/ls, cognitive and memory tools, extension and skill availability, and ~/.pi writability; interpret pass/warn/fail results and clean up stale agent processes. Use when a tool misbehaves or fails, right after setup or a config change, before starting work in a fresh environment, or when many agent instances accumulated and the machine slows down."
triggers:
  - "healthcheck"
  - "tool diagnostics"
  - "stale processes"
  - "post-setup"
  - "environment readiness"
validated: 2026-11-03
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

## Cold start

The `coldstart` category answers a different question from every other category here: not "do the tools work on this machine", which is the machine least likely to be broken, but "does braid work where nothing has happened yet". It copies `settings.json`, `auth.json`, `models-store.json` and `mcp.json` into a throwaway home, points `BRAID_HOME` at an empty directory inside it, and runs one real process that asks memory, scratchpad, orchestration and bash to answer from nothing.

```
healthcheck { "categories": ["coldstart"] }
```

It is opt-in and never part of the default sweep, because it spawns a process and can take minutes. Read it in this order:

- `isolation` fail: the rehearsal wrote into the live braid home. Treat the whole report as untrusted, not just that row.
- `verdict` warn: the probe never reported, so the subsystem rows mean nothing. Everything else in this category is downstream of this line.
- `boot` fail with a duration: a hang. This is the answer no retry fixes, and it names the subsystem that waits instead of failing.
- `subsystem-*` fail: that subsystem assumes state exists. A clean-machine blocker, not a warning.
- `first-boot-installs` warn: the first start on a new machine needs network and is slow; a second start is not.

What the category cannot see, and a clean machine will not have: the orchestrator workspace with its briefs and handoffs, userland skills, and `herdr`. None of the three ships in a package, so they are absent before any state question begins.

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
