---
name: healthcheck
description: "Run agent self-diagnostic to validate all tools and capabilities are functioning. Use when troubleshooting tool failures, after setup, or to verify environment readiness."
disable-model-invocation: true
---

# Agent Healthcheck Protocol

Run this skill to validate that the agent can fully operate on all required tools and systems.

## Quick Check (1 turn)

1. Call `healthcheck` tool with no parameters
2. Review results and report summary

## Full Diagnostic (multi-turn)

### Phase 1: Core Tools

1. **Read** - `read` a small file to verify file access
2. **Write** - Create temp file, verify content, delete
3. **Edit** - Modify existing file with edit tool
4. **Bash** - Run `echo`, `ls`, `pwd` commands
5. **Grep** - Search for a pattern in source
6. **Find** - List files by glob pattern
7. **Ls** - List directory contents

### Phase 2: Cognitive Tools

1. **Think** - Call `think` with observation/decision/reason
2. **Hypothesize** - Generate test hypotheses
3. **Scratchpad** - Read/write scratchpad entries

### Phase 3: Management Tools

1. **Goals** - Create test goal, mark complete, delete
2. **Plans** - Create test plan, complete step
3. **Tasks** - Add task, complete task
4. **Memory** - Store, recall, search memories
5. **Snapshots** - Create, list, delete snapshot
6. **Metrics** - Get metrics, detect degradation

### Phase 4: Infrastructure

1. **REPL** - Execute simple Python/Node code
2. **Sub-agent** - Spawn and verify sub-agent returns
3. **Time** - Check time_status
4. **Resources** - Check resource usage

### Phase 5: Environment

1. **Extensions** - Verify extensions loaded (check tool list)
2. **Skills** - Verify skills available
3. **Config** - Check ~/.pi directory accessible

## Interpretation

- **All pass** → Agent fully operational
- **Some warns** → Degraded but functional (check details)
- **Any fails** → Agent capability compromised (report issue)

## Failure Recovery

| Check | Failure | Fix |
|-------|---------|-----|
| write | Permission denied | Check file permissions on ~/.pi |
| bash | Command not found | Verify PATH includes node/npm/git |
| repl | Timeout | Check system resources |
| memory | Store fails | Verify ~/.pi writable |
| snapshot | Create fails | Check disk space |

## Report Format

After running, provide:

```
## Healthcheck Summary
- Status: 🟢 HEALTHY / 🟡 DEGRADED / 🔴 UNHEALTHY
- Passed: X/Y checks
- Warnings: (list)
- Failures: (list with fix suggestions)
- Recommendations: (actionable steps)
```
