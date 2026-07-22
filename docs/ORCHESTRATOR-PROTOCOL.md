<!-- status: forward-looking -->

# Orchestrator Protocol: Multi-Agent Code Coordination

## Problem

Multiple agents (master + workers) may modify the same codebase concurrently.
Without coordination, two agents can edit the same file, create conflicting
branches, or step on each other's changes. The orchestrator protocol solves
this with four mechanisms:

1. **Branch-per-worker** — each worker gets an isolated git branch
2. **File-lock awareness** — workers register files they intend to modify
3. **Conflict detection** — master checks locks before spawning workers
4. **Merge verification** — master verifies worker output before merging

---

## 1. Branch-per-Worker Pattern

### Naming Convention

```
worker/<worker-id>/<slug>
```

Where:
- `worker-id` = short unique ID (e.g., `w1`, `w2`, or the pane ID)
- `slug` = kebab-case description of the task (e.g., `fix-timer-test`)

### Protocol

1. **Master creates branch**: `git checkout -b worker/w1/fix-timer-test`
2. **Master spawns worker**: passes the branch name in the task description
3. **Worker works on branch**: commits changes to the worker branch
4. **Worker signals completion**: via `finalize` with done status
5. **Master verifies**: checks out branch, runs tests, reviews diff
6. **Master merges**: `git checkout main && git merge --squash worker/w1/...`
7. **Master deletes branch**: `git branch -D worker/w1/...`

### Squash merge

Always use `--squash` to keep main history linear. The worker's commit
granularity is its own concern; main sees one commit per task.

---

## 2. File-Lock Registry

### Storage

A JSON file at the project root: `.braid/locks.json`

Structure:
```json
{
  "version": 1,
  "locks": {
    "src/foo.ts": { "workerId": "w1", "branch": "worker/w1/fix-foo", "acquiredAt": 1234567890 },
    "src/bar.ts": { "workerId": "w2", "branch": "worker/w2/add-bar", "acquiredAt": 1234567890 }
  }
}
```

### Lock operations

- **acquireLock(files[], workerId, branch)**: Adds entries for each file. Fails
  if any file is already locked by a different worker.
- **releaseLock(workerId)**: Removes all locks held by that worker.
- **releaseAllLocks()**: Clears all locks (for master reset).
- **getConflicts(files[])**: Returns list of files that are locked by other
  workers.

### Stale lock detection

If a worker's git branch no longer exists (deleted or merged), its locks
are considered stale and can be force-released by the master with a warning.

---

## 3. Conflict Detection

### Before spawning a worker

1. Master determines the set of files the worker will touch
2. Master calls `getConflicts(files)` to check for overlaps
3. If conflicts exist, master:
   a. Logs the conflict (worker ID, files, conflicting worker)
   b. Either waits for the conflicting worker to finish, or
   c. Re-routes the task to avoid the conflict, or
   d. Prompts the user for resolution
4. If no conflicts, master acquires locks and spawns the worker

### File set determination

The master infers the file set from the task description. For simple tasks
("fix bug in src/foo.ts"), the file set is explicit. For complex tasks
("add feature X"), the master can:
- Ask the worker to declare its file set before starting
- Use a wildcard lock (e.g., `src/feature-x/**`) which is broader but
  reduces coordination precision

### Lock granularity

- **Explicit files**: `src/foo.ts`, `src/bar.ts` — precise, no false conflicts
- **Directory wildcards**: `src/feature-x/*.ts` — broader, may cause false conflicts
- **Repository-wide**: `.` — only for master-level operations (merge, build)

---

## 4. Merge Verification Protocol

### Steps

After a worker signals completion:

1. **Checkout worker branch**: `git checkout worker/w1/...`
2. **Read diff**: `git diff main...HEAD` — understand what changed
3. **Run build**: `npm run build` (compiles TypeScript)
4. **Run tests**: `npm test`
5. **Run typecheck**: `npm run typecheck`
6. **Review diff**: verify changes are correct, no unintended side effects
7. **If all pass**: `git checkout main && git merge --squash worker/w1/...`
8. **If any fail**: call the worker back with the error details, let it fix
   and re-signal

### Verification gates

| Gate | Command | Failure handling |
|------|---------|-----------------|
| Build | `npm run build` | Call worker to fix compilation errors |
| Tests | `npm test` | Call worker to fix test failures |
| Typecheck | `npm run typecheck` | Call worker to fix type errors |
| Diff review | Manual inspection | Call worker to fix logic errors |

### Auto-merge criteria

All three automated gates (build, test, typecheck) must pass. Diff review
is manual but should be quick for squash-merged changes.

---

## 5. Worker Lifecycle

```
┌─────────────────────────────────────────────────────┐
│ Master                                               │
│  1. Determine file set for task                      │
│  2. Check conflicts → acquire locks                  │
│  3. Create branch → spawn worker (pane)              │
│  4. Set timer for worker check                       │
│  5. Do other work until timer fires                  │
│  6. On timer: check worker status                    │
│  7. If done: verify → merge → release locks          │
│  8. If not done: set another timer, continue         │
│  9. On failure: call worker, let it fix, goto 6      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Worker                                               │
│  1. Read task from master (passed in prompt)         │
│  2. Work on branch (git commit as needed)            │
│  3. When done: finalize with status                  │
│  4. If master calls back: fix issues, goto 2         │
└─────────────────────────────────────────────────────┘
```

### Timer-based checking

Master never blocks on workers. It sets a timer (default: 60s), does other
work, and checks at the timer boundary. This is the non-blocking
orchestration pattern from the orchestrator skill.

---

## 6. Implementation Plan

### Phase 1: File-lock utility (src/lib/orchestrator/locks.ts)
- `acquireLock(files, workerId, branch)` → boolean
- `releaseLock(workerId)` → void
- `getConflicts(files)` → Conflict[]
- `releaseStaleLocks()` → void
- `LOCK_FILE` constant in braid-paths.ts

### Phase 2: Branch utility (src/lib/orchestrator/branch.ts)
- `createWorkerBranch(master, workerId, slug)` → branch name
- `deleteWorkerBranch(branch)` → void
- `squashMerge(branch)` → void
- `getDiff(branch)` → string

### Phase 3: Conflict detection (src/lib/orchestrator/conflict.ts)
- `checkBeforeSpawn(files, existingWorkers)` → Conflict[]
- `resolveConflict(conflict, strategy)` → void

### Phase 4: Orchestrator extension (src/extensions/orchestrator/)
- `spawnWorker(task, files)` → workerId
- `checkWorker(workerId)` → WorkerStatus
- `verifyAndMerge(workerId)` → boolean
- Registers tool: `orchestrate`

### Phase 5: Skill update (skills/orchestrator/SKILL.md)
- Add concrete procedures for branch-per-worker, file-lock, merge verification
- Add trigger patterns for worker status checking