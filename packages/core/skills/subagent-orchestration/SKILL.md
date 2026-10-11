---
name: subagent-orchestration
description: "Coordinate multi-agent work: spawn workers, manage lifecycles, signal between agents, transfer context, handle errors, and cascade to fresh sessions. Covers both orchestrator and worker roles — an orchestrator is a subagent that owns coordination; every subagent orchestrates its own tools."
trigger: "spawning workers, delegating tasks, parallel execution, mastership transfer, context handoff, error recovery, context hygiene, multi-agent coordination"
validated: 2026-08-16
verdict: KEEP
---

# Subagent Orchestration

## Role & Identity

Two roles, one skill:

- **Orchestrator** - coordinates other agents. Spawns workers, assigns tasks, reviews results, manages lifecycles. Never executes work outside its own CWD.
- **Worker** - executes tasks in its CWD. Receives a task description, produces results, signals completion. Does not coordinate other agents.

An orchestrator is a subagent that owns coordination responsibility. Every subagent implicitly orchestrates its own tool calls. The distinction is a responsibility boundary, not a different kind of agent.

## CWD & Workspace Discipline

### Why the orchestrator's process CWD should be `<orchestrator-cwd>`

Pi's runtime directory is `~/.pi/agent/` - that's where `PI_CODING_AGENT_DIR` points, where `settings.json` and `auth.json` live. Pi finds its config via this env var, not via CWD. The orchestrator can start from any directory without breaking pi's runtime.

The orchestrator's **process CWD** should be `<orchestrator-cwd>` - the dedicated workspace. This enforces the boundary by default: all artifacts naturally land in the workspace, not in pi's runtime root. No discipline required.

**Start the orchestrator:**

```
herdr action=pane_split cwd=<orchestrator-cwd> label=orchestrator
herdr action=run pane=<pane> command="pi"
```

This separates pi's runtime config (found via `PI_CODING_AGENT_DIR` at `~/.pi/agent/`) from the orchestrator's working data (at `<orchestrator-cwd>`).

### Workspace-Level Isolation

Each major task domain gets its own herdr workspace. This provides full isolation: independent terminal session, independent CWD, clean lifecycle management.

| Scope          | Workspace              | Process CWD          | Purpose                             |
| -------------- | ---------------------- | -------------------- | ----------------------------------- |
| Orchestration  | Orchestrator workspace | `<orchestrator-cwd>` | Coordinate agents, manage lifecycle |
| Extension host | Repo workspace         | `<repo-dir>`         | Extension/dev work in that repo     |
| Skills/content | Skills workspace       | `<skills-repo-dir>`  | Content-only skill pack edits       |

**Rule:** Never spawn a worker in a pane within the same workspace if the task spans a different domain. Use a separate workspace with its own CWD.

### Worker CWD Must Match Task Scope

A worker's CWD determines what it can reach. A worker in `~/.pi/agent/` cannot stat project source files without path gymnastics. Always spawn workers in the project whose scope matches the task:

| Task                                | Worker CWD           |
| ----------------------------------- | -------------------- |
| Orchestration (coordinating agents) | `<orchestrator-cwd>` |
| Code changes in a repo              | `<repo-dir>`         |
| Skills/content changes              | `<skills-repo-dir>`  |
| Researching your extension host     | `<repo-dir>`         |
| Session management research         | `<repo-dir>`         |
| Fire-and-forget extraction          | Target project's CWD |
| Pi settings/config work             | `~/.pi/agent/`       |

## Context-Transfer Docs

When transferring context between agents, write documentation to disk rather than composing giant inline prompts. This produces a durable artifact that survives session boundaries.

Pattern:

1. Write a context document to a well-known path (e.g., `context/<slug>.md`)
2. The receiving agent reads the document
3. The document serves as the shared understanding between agents

This is preferred over inline context because documents survive session compaction and agent restarts, can be referenced by multiple agents, and are inspectable/editable.

## Spawning Subagents

Three methods, depending on the task type:

### Method 1: orchestrate tool (preferred for git code changes)

Uses the built-in `orchestrate` tool for code-modification tasks in git repos. Handles branch creation, file locking, and merge verification:

```
1. Determine the task, target files, and repo
2. orchestrate action=spawn-worker workerId=<id> slug=<kebab-task> files=[<file-paths>]
   — Creates branch worker/<id>/<slug> and locks the files
3. The worker checks out the branch, makes changes, commits, signals completion
4. orchestrate action=verify-and-merge workerId=<id> branch=worker/<id>/<slug>
   — Reads the diff, prompts for verification, squash-merges to main
5. orchestrate action=release-locks workerId=<id>
```

**Lock-only mode**: When CWD is not a git repo, orchestrate falls back to lock-only coordination. Use herdr for task handoff.

### Method 2: herdr TUI mode (default: for ongoing orchestration)

```
1. Create pane: herdr action=pane_split cwd=<target> label=worker-<task>
2. Start TUI pi: herdr action=run pane=<worker> command="pi"
3. Wait for pi to render its prompt, then give the task:
   herdr action=send pane=<worker> text="[agent:orchestrator→worker] <task>"
```

TUI mode supports multi-turn signaling, revision feedback, and ongoing control.
The worker signals completion back via `herdr send`.

### Method 3: herdr JSON mode (alternative: for fire-and-forget extraction)

```
1. Create pane: herdr action=pane_split cwd=<target> label=worker-<task>
2. Start pi: herdr action=run pane=<worker> command="pi --mode json '<task>' 2>/dev/null"
3. Read output: herdr action=read pane=<worker> source=recent
```

JSON mode exits after one turn. Use for simple extraction where you don't need ongoing control.

**CRITICAL: `pane_split` creates a SHELL, not an agent.** You MUST `herdr action=run` to start pi inside the pane. `herdr action=send` is for signaling between already-running agents - it does NOT start a task. Use `herdr action=run` to start, then `herdr send` to signal.

### Which to use

| Situation                               | Method                         |
| --------------------------------------- | ------------------------------ |
| Editing source files in a git repo      | orchestrate spawn-worker       |
| Ongoing orchestration, multi-turn tasks | herdr TUI + send               |
| Fire-and-forget extraction, one-shot    | herdr JSON mode                |
| Non-git directory tasks                 | herdr or orchestrate lock-only |

## Task Prompt Guidelines

Workers start from scratch - the task prompt is their entire context. Write accordingly.

**Good task prompt** - specific, scoped, has clear done condition:

```
Analyze src/auth/login.ts for security vulnerabilities.
For each finding: file, line, OWASP category, severity, suggested fix.
Format as a markdown table.
```

**Bad task prompt** - vague, unbounded:

```
Look at the auth code and tell me if anything is wrong.
```

**Structuring tips:**

- State the exact files or paths to examine
- Define the output format
- Set scope boundaries ("do not modify files", "read-only analysis")
- Include verification commands the worker should run
- For file modification tasks: include exact search/replace strings

## Error Handling

### Stop on first provider error

If a worker encounters a provider error, **stop immediately**. Do NOT retry the same provider/model. Do NOT switch providers silently. Signal the orchestrator.

**Errors that mean STOP:**

- **403 quota** - No quota on this provider/model. Stop.
- **400 bad request** - Provider misconfiguration. Stop.
- **Stream ended without finish_reason** - Provider stream corruption. Stop.
- **Any unknown LLM error** - Stop and signal.

**Signal format:**

```
herdr send pane=<orchestrator-pane> text="[agent:worker→orchestrator] ERROR: <error-type>. <error-message>. Model: <model>. Provider: <provider>."
```

**Orchestrator action on error:**

- Check if other providers have quota
- If none, notify the user
- If another provider works, re-spawn the worker with the new provider
- Never let a worker retry indefinitely on the same error

### Loop guardrails

Small/cheap models can enter infinite think/respond loops. Detect and halt:

- **Repeat output** ≥3 turns (same content/hash) → stop
- **Max-token limit** error ≥2 turns → stop
- **Thinking without a tool call** while context grows for ≥N turns → stop

On detection: stop all work, signal orchestrator with `LOOP_DETECTED`. Orchestrator may: lower the `thinking` level, switch to a different cheap model, escalate to a stronger model for one corrective turn, or branch to a fresh session. **Never retry the same loop.**

## Worker Review

When a worker signals completion, review critically before closing the pane.

### Review procedure

1. **Read the pane output** - `herdr action=read pane=<worker-pane> source=visible` (or `source=recent` for JSON mode after `wait_agent`)
2. **Verify claims** - Check git diff, run grep for key patterns, confirm unchanged files are untouched
3. **Check side effects** - No stale processes, no unintended file modifications
4. **Assess quality** - Does the output meet the original task requirements?

### Decision outcomes

- **APPROVED** - `herdr action=send pane=<worker-pane> text="[agent:orchestrator→worker] APPROVED. Close your pane."` Then close the worker pane and capture knowledge to memory.
- **REVISION** - `herdr action=send pane=<worker-pane> text="[agent:orchestrator→worker] REVISION: <specific feedback>."` Set a timer to check back.
- **REJECTED** - If fundamentally wrong: send rejection and close the pane manually.

### Failure modes

- **Worker does not respond**: orchestrator checks timer, closes pane after timeout.
- **Worker crashes mid-task**: orchestrator detects via `agent_get` status change, spawns replacement.
- **Orchestrator is busy**: worker retries signal with backoff (max 3, 60s apart), then writes results to a well-known path.

## Completion Signal

### For orchestrate-spawned workers

You are on a branch with locked files. Lifecycle:

1. Make changes to locked files
2. Commit: `git add <files> && git commit -m "<task>: summary"`
3. Orchestrator calls `verify-and-merge` to review and merge
4. Branch is deleted and locks released - no need to signal or close

### For herdr-spawned workers

Signal the orchestrator:

```
herdr send pane=<orchestrator-pane> text="[agent:worker→orchestrator] TASK COMPLETE: <brief-summary>. Ready for review."
```

Do NOT close your pane. Wait for the orchestrator's response (APPROVED → close, REVISION → fix and re-signal).

## Context Hygiene

braid ships a context-manager: `context_navigate` (tag / checkout) and `context_compress` (archive / deep_clean). pi's default compaction is destructive and can hit `Maximum call stack size exceeded` past ~70% context.

### Budget guardrail

Enforce a HARD context budget BEFORE degradation begins. Mistakes and loop-risk rise sharply at ~75–100k tokens, independent of window size.

**Trigger (absolute, not %):** when `context_inspect` reports **>80k tokens** OR **>35% of the window** (whichever comes first):

1. `context_navigate action=tag name="pre-archive-<n>"` - mark your position
2. `context_compress action=archive topic="<task>"` - archive everything before the tag
3. If still >70%: `context_compress action=deep_clean`, then trigger Session Cascade

**Never** `context_compress action=compact` above 70% context - that is the recursive-compaction / `Maximum call stack size exceeded` path. Archive + checkout only.

Subagents are responsible for their own context hygiene. The orchestrator cannot reach into a subagent's window. If context is unhealthy and you cannot recover, STOP and signal the orchestrator for a handoff.

## Session Cascade

When context hits ~70% (or a Context Budget Guardrail archive still leaves you >70%), hand off to a fresh session instead of fighting bloat:

1. Write a handoff document with: current goal, open plan, worker status, context health, provider/model status, and skills active.
2. Spawn successor: `herdr action=pane_split cwd=<orchestrator-cwd> label=successor`

**Option A: JSON mode (one-shot handoff)**

```
herdr action=run pane=<successor> command="pi --mode json 'Read /path/to/handoff.md. Continue backlog.' 2>/dev/null"
```

Best for a single handoff task. Successor reads doc, processes, exits.

**Option B: TUI mode (ongoing orchestration)**

```
herdr action=run pane=<successor> command="pi"
herdr action=send pane=<successor> text="[agent:orchestrator→successor] Read /path/to/handoff.md. Continue backlog."
```

Best for a successor that will orchestrate subagents. TUI pi persists, accepts signaling, can spawn its own workers.

3. Transfer mastership: the current session closes when the successor completes. The successor can close the predecessor's pane via `herdr action=stop pane=<predecessor-pane>`.
4. The successor starts clean (no bloat) and reads the handoff.

This is a **pipeline, not a loop**: each session is a fresh stage. Never compact above 70% - cascade instead.

## Non-blocking Orchestration

Master never blocks on workers. Use timers for non-blocking monitoring:

1. Spawn worker
2. Set timer: `timer action=set delay_seconds=60 reason="check worker-X"`
3. Continue other work or return to user
4. When timer fires: check worker status, handle result
5. Repeat if worker needs more time

**A timer is set, and then the turn ends.** Set the timer for the next checkpoint, then yield with a text-only response - never loop `sleep` calls while waiting on a worker; the loop spins the turn and burns quota, and the timer's fire is the wake-up. When a suitable timer is already armed, yield at once rather than arming a duplicate. `sleep` is for a single short pause mid-operation only.

### Wake-up discrimination

Timers fire with `triggerTurn: true`. Distinguish:

- **Timer fire**: system wake-up. Check the timer reason, re-read scratchpad, continue pending work.
- **User message**: actual user input. Respond normally.

When woken by a timer: do not assume the user replied. Re-read the scratchpad, check what was pending, and continue without user interaction.

## Workspace Hygiene

### One workspace per project

Each project gets exactly one workspace. Do not create duplicate workspaces.

### Clear pane naming

- `orchestrator` - the coordinating agent
- `worker-<task>` - worker panes named after their task
- `successor` - replacement orchestrator panes

### Close stale agents

When an agent finishes, close its pane. List panes with `herdr action=list`, inspect older ones, close agents that are no longer needed. Kill orphaned processes spawned by now-closed agents.

## Subagent Hygiene

Subagents (workers) are ephemeral - they should be created, do work, and be cleaned up. Stale subagents accumulate as open panes, locked files, abandoned branches, and orphaned processes. Systematic hygiene prevents this.

### Fleet status at a glance

`scripts/workers.mjs` answers "what is every worker doing, and is anything wrong with it" in one
call, from evidence rather than from the registry's own claim about itself:

```bash
node scripts/workers.mjs                # live workers in the cwd's registry
node scripts/workers.mjs <id> <id>      # only these
node scripts/workers.mjs --all          # include closed
node scripts/workers.mjs --repo <path>  # another repo's registry
node scripts/workers.mjs --json         # machine-readable
node scripts/workers.mjs --stale 30     # age at which 'working' is flagged (default 15m)
```

One row per worker: session age, event count, commits ahead, dirty count, deliverable size. It reads
four independent sources because no single one is trustworthy - the registry is only the _claim_;
session mtime proves motion, git proves commits and dirty state, the filesystem proves the
deliverable exists. The registry reports `working` long after a pane has died, and `admitted` for a
worker that has been running for an hour.

The flags name the failure modes worth acting on:

| Flag           | Means                                                    | Do                                   |
| -------------- | -------------------------------------------------------- | ------------------------------------ |
| `NOT-FIRED`    | session has <3 events; the prompt is staged, not running | `send_keys ["enter"]` on the pane    |
| `STALE>Nm`     | status says working, no session write in N minutes       | poll the pane - it may have stalled  |
| `REPORT-READY` | deliverable is on disk                                   | run `check-result.mjs`, then read it |
| `FALSE-DONE`   | closed, with a deliverable that does not exist           | reopen; the result block was untrue  |

Do not build this check by hand per worker. A hand-rolled loop pairs a session path with a worker id
by hand and drifts silently when either changes; this reads the pairing from the registry and
verifies each half against its own source.

### Periodic sweep

At regular intervals (every few turns, or when spawning new work), check for stale subagents:

1. **List all panes** - `herdr action=list` (or check output from `herdr workspace_list / tab_list`)
2. **Inspect each pane** - For each pane that looks complete (long idle, exited to shell prompt, error message), read its visible content:
   `herdr action=read pane=<id> source=visible`
3. **Close completed panes** - If a worker signaled completion and was approved, or crashed and was not restarted:
   `herdr action=stop pane=<id>`
4. **Close error-state panes** - If a pane shows a provider error or retry loop with no recovery path, close it rather than leaving it spinning.

### Lock cleanup

Crashed workers leave orphaned file locks. This blocks future workers from modifying the same files.

1. **List active locks** - `orchestrate action=list-locks`
2. **For each lock**: check if the owning worker pane is still alive. If not:
   `orchestrate action=release-locks workerId=<id>`
3. **Stale lock files** - If the orchestrate tool reports lock files in unexpected locations (e.g., wrong project dir), delete them manually:
   `rm <path-to-locks.json>`

### Branch cleanup

Worker branches accumulate in the repo. After a worker's changes are merged and the worker is closed:

```
git branch -d worker/<id>/<slug>
git push origin --delete worker/<id>/<slug>   # if previously pushed
```

Branches for workers that crashed or were replaced can be force-deleted:

```
git branch -D worker/<id>/<slug>
```

### Orphaned process cleanup

Pi agents that crash can leave orphaned Node.js processes. Detect via:

```
ps aux | grep 'node.*pi' | grep -v grep
```

Any process running in a closed pane's directory is likely orphaned. Kill with:

```
pkill -f 'node.*pi.*<pattern>'   # use cautiously
```

### Recommended cadence

| Situation                          | Action                                             |
| ---------------------------------- | -------------------------------------------------- |
| After every worker completion      | Close the pane, merge/release locks, delete branch |
| Before spawning a new worker       | Quick sweep: close stale panes, release locks      |
| When hitting "no more panes" limit | Full sweep: close all completed panes              |
| At session start                   | Check for stale locks from previous sessions       |
| Weekly or per-major-release        | Clean all merged worker branches                   |

## Mastership Transfer Protocol

### Chain

An agent that modifies code is never the agent that verifies it. The verifier is always a fresh session with the compiled changes.

```
Master → spawns Child → Child modifies code
  → Child spawns Grandchild (fresh session, latest release)
  → Grandchild: build, test, typecheck, verify
  → If pass: Grandchild closes Child, closes Master, takes over
  → If fail: Grandchild calls Child, Child fixes, respawns
```

### Safety valve

If the grandchild cannot verify, it calls the parent for help instead of propagating bad state.

### Parent-child link

The child must know the parent's pane ID to close it. The master passes its pane ID explicitly:

```
Master: "I am pane-abc. Your task is X. When done, close pane-abc."
```

Without this, the child cannot locate the parent to close it.

## Next-Task Selection

After every `finalize`, decide what to do next. Do not guess - use this procedure:

1. **scratchpad** - Check open plan items. Are there incomplete tasks from the current plan?
2. **parking lot** - Check for deferred items, `await-feedback` crumbs, or blocked tasks.
3. **user priorities** - What did the user last ask for? Does anything remain unaddressed?
4. **memory** - `memory recall_search` for patterns, goals, or constraints related to the current project.
5. **project state** - Check the project directory for changes, errors, or signals.
6. **present options** - Offer the user a ranked list of next steps. Let them choose; do not self-assign without confirmation.

This procedure prevents autonomous drift. Always end with the user deciding.
