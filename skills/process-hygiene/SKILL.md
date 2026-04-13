---
description: Cleans up stale pi instances and related processes that accumulate during long-running agent tasks.
---

# Process Hygiene

Cleans up stale pi instances and related processes that accumulate during long-running agent tasks.

Use when:
- Pi instances are accumulating and slowing down the system
- Running long benchmarks that spawn multiple agents
- After a crashed or interrupted agent session

## Usage

Run the cleanup script:
```bash
# Kill all stale pi processes (older than 5 minutes)
~/.pi/agent/skills/process-hygiene/cleanup.sh

# Kill only pi-cli processes (less aggressive)
~/.pi/agent/skills/process-hygiene/cleanup.sh --pi-only

# Dry run (show what would be killed)
~/.pi/agent/skills/process-hygiene/cleanup.sh --dry-run

# Show current stale processes
~/.pi/agent/skills/process-hygiene/cleanup.sh --list
```

## What Gets Cleaned Up

- `pi` processes (pi-mono cli.js instances)
- `node` processes that are children of pi processes  
- `bash` processes running pi commands
- Stale tmux sessions with pi
- Old temp directories in `/tmp/modern-bench-*`
- Old temp directories in `/tmp/pi-*`

## Age Thresholds

- Default stale threshold: 5 minutes
- Configurable via environment variable `STALE_THRESHOLD_MINUTES`

## Safety

- Never kills processes from the last 5 minutes (unless `--force`)
- Dry run mode shows what would be killed without actually killing
- Lists processes before killing so you can review
