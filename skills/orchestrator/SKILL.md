---
name: orchestrator
description: "Coordinate mastership transfers between agents in a multi-agent system. Use when: spawning successor agents, transferring context between sessions, managing agent lifecycles, or coordinating parallel agent workers."
trigger: "mastership transfer, spawning successor agents, context transfer between sessions, agent lifecycle management, multi-agent coordination, successor handoff"
---

# Orchestrator: Mastership Transfer Protocol

## Chain

An agent that modifies code is NEVER the agent that verifies it.
The verifier is always a fresh session with the compiled changes.

```
Master → spawns Child → child modifies code
  → child spawns Grandchild (fresh session, latest release)
  → Grandchild: build, test, typecheck, verify
  → If pass: Grandchild closes Child, closes Master, takes over
  → If fail: Grandchild calls Child ("parent, fix this"), child fixes, respawns
```

## Safety Valve

If the grandchild cannot verify, it calls the parent for help instead of
propagating bad state. The parent fixes the issue, releases the fix, and
spawns a new grandchild.

## Exit

- The agent that closes itself is the one that successfully verified
- All ancestors are closed by the successor
- No agent lingers after transfer

## Wake-up Discrimination

Braid whispers fire with `triggerTurn: true` which wakes the agent. The
agent MUST distinguish:
- **Timer fire**: system wake-up, not user input. Check timer reason, do
  not assume user answered.
- **User message**: actual user input. Respond normally.

When woken by a timer: re-read the scratchpad, check what was pending,
continue without assuming the user replied.

## Non-blocking Orchestration

Master never blocks on workers. Set a timer, do other work, check at
natural turn boundaries. Workers run independently in their own sessions.

## The `orchestrate` Tool

Braid's `orchestrate` tool provides 6 actions for coordinating workers:

| Action | Purpose | Required params |
|--------|---------|----------------|
| `spawn-worker` | Create branch, acquire locks, prepare worker | workerId, slug, files |
| `check-worker` | Check worker status | workerId |
| `verify-and-merge` | Diff review, merge, cleanup | workerId |
| `release-locks` | Release all locks for a worker | workerId |
| `list-locks` | Show all held locks | — |
| `check-conflicts` | Check files for conflicts | files |

### spawn-worker workflow

1. `orchestrate action=spawn-worker workerId=w1 slug=fix-timer-test files=["src/foo.ts"]`
2. Creates branch `worker/w1/fix-timer-test`, acquires locks on `src/foo.ts`
3. Returns instructions for spawning the worker via herdr
4. Pass the branch name to the worker: "Work on branch worker/w1/fix-timer-test"
5. Set a timer to check back

### verify-and-merge workflow

1. Worker signals completion
2. `orchestrate action=verify-and-merge workerId=w1`
3. Reads diff, squash-merges to main, releases locks, deletes worker branch
4. Run `npm run build && npm test` to verify the merge
5. Commit the squash-merged changes

## Branch-per-Worker Pattern

Each worker gets its own git branch. Branch naming convention:
```
worker/<worker-id>/<kebab-case-slug>
```

The master creates the branch, the worker commits to it, the master
squash-merges back to main. This keeps main history linear.

## File-Lock Awareness

The file-lock registry at `~/.pi/agent/braid/projects/<project>/locks.json`
tracks which files are locked by which worker. Before spawning a worker,
check for conflicts with `orchestrate action=check-conflicts files=[...]`.

## Merge Verification Protocol

After merging a worker's branch:

1. Run `npm run build` — verify compilation
2. Run `npm test` — verify all tests pass
3. Run `npm run typecheck` — verify type correctness
4. Review the diff — verify logic is correct
5. If any step fails, call the worker back with the error details

## Worker Lifecycle (Master)

```
1. Determine file set for task
2. orchestrate action=check-conflicts files=[...]
3. orchestrate action=spawn-worker workerId=w1 slug=task files=[...]
4. Spawn worker via herdr (pass branch name)
5. Set timer for 60s
6. On timer fire: orchestrate action=check-worker workerId=w1
7. If done: orchestrate action=verify-and-merge workerId=w1
8. Run build + test + typecheck
9. If pass: commit and close worker
10. If fail: re-spawn worker with fix instructions
```

## Generic Use Cases

Orchestration works for any parallelizable task, not just code:

- **Presentation creation**: spawn workers for each slide, each worker
  researches and drafts its slide, master assembles the final deck.
- **Bug hunting**: spawn workers for each page/module, each worker reviews
  and reports bugs. One-shot review can uncover 30+ bugs in minutes.
- **Widget generation**: 1000+ widgets, 100 pages — spawn workers in
  batches, each worker handles a batch, master assembles.
- **Research**: spawn workers for each topic, each worker researches and
  summarizes, master synthesizes.

## Parent-Child Link

The child MUST know the parent's pane ID to close it on successful
handoff. The master passes its pane ID explicitly:

```
Master: "I am w3:p1. Your task is X. When done, close w3:p1."
Child: receives pane ID, stores it, uses it on completion.
```

The child stores the parent pane ID in its scratchpad so it survives
compaction. Without this, the child cannot locate the parent to close it.