# Context Hygiene Pipeline

## Problem

Single sessions can run for days, weeks, or months. The context window fills up (75%+), and the agent hits a wall. Compaction is the standard solution, but it:

1. **Destroys information**: Original messages are replaced with a summary. You can't go back and see what was actually said.
2. **Triggers the stack overflow bug**: The `session_compact` event handler calls `sendTrackedMessage` with `triggerTurn: true`, which enters the agent loop synchronously. This can overflow the V8 stack when multiple compactions happen in close succession.
3. **Loses thread context**: Compaction summaries often lack speaker attribution, making it hard to distinguish who said what.

## Solution: Branching Instead of Compacting

Pi sessions are **trees**, not linear logs. Every entry has an `id` and `parentId`. The current position is the active leaf. `context_navigate checkout` navigates to any point in the tree and creates a new branch.

### The Pipeline

```
1. context_navigate(action="tag", name="checkpoint-N")     # Save position
2. [Continue working... context fills up]                   # Normal work
3. context_navigate(action="checkout", target="checkpoint-N", 
   message="Branch summary")                                # Branch to fresh context
```

### What Happens

When you call `context_navigate checkout`:

1. **Auto-tag**: The current position is auto-tagged as `before-<target>` (preserved in the session tree)
2. **Branch summary**: The recent context (from the target to the current position) is captured as a branch summary. The `message` parameter is the summary text.
3. **Navigate**: The session navigates to the target point (the tag)
4. **New branch**: A new branch is created from the target point. The old context is preserved as a leaf in the session tree.

```
Session tree before:

  checkpoint-1 ─── work ─── work ─── work ─── CURRENT (75% full)
                     ↑
              target = checkpoint-1

Session tree after checkout:

  checkpoint-1 ─── work ─── work ─── work ─── [branch summary]
       │
       └── NEW BRANCH (fresh context, 0% full)
```

### Advantages Over Compaction

| Aspect | Compaction | Branching |
|--------|-----------|-----------|
| Information preservation | Destroyed | Preserved in tree |
| Stack overflow risk | Yes (session_compact → sendTrackedMessage) | No (no session_compact event) |
| Speaker attribution | Lost (summary format) | Preserved (original messages) |
| Recoverability | One-way (can't undo) | Two-way (navigate back anytime) |
| Context cleanliness | Partial (summary replaces old messages) | Complete (fresh context, summary injected) |

### Cross-Session Knowledge

For durability across sessions and branches:

```typescript
// Persist important insights
memory_store(content="...", memoryType="insight", tags=["project", "session"])

// Retrieve at start of new branch
memory(action="recall_search", query="...", projectScope="current")

// Find past sessions
session(action="search", query="...")
```

## Workflow for Long-Running Sessions

### Daily Rhythm

```
Morning (user returns):
  1. memory(action="recall_search", query="work done today")  // Review what happened
  2. context_navigate(action="log", limit=10)                   // See recent context
  3. Continue working

Every 100 turns or when context > 70%:
  1. context_navigate(action="tag", name="checkpoint-N")       // Save position
  2. Continue working

When context > 75%:
  1. context_navigate(action="checkout", target="checkpoint-N", 
     message="Summary of work since checkpoint-N")              // Branch
  2. memory_store to persist key learnings                      // Durability
  3. Continue in fresh context

Night (user sleeps):
  1. Tag current position: checkpoint-N
  2. Set timer: timer(action="set", delay_seconds=28800, reason="user return at ~9am")
  3. Agent proceeds with task queue autonomously
  4. Each subtask is a branch in the session tree
  5. memory_store persists learnings after each subtask
```

### Example: 1000-Turn Session

```
Session tree:

  checkpoint-1 ─── turns 1-100 ─── [branch summary]
       │
       ├── checkpoint-2 ─── turns 101-200 ─── [branch summary]
       │      │
       │      ├── checkpoint-3 ─── turns 201-300 ─── [branch summary]
       │      │      │
       │      │      ├── checkpoint-4 ─── turns 301-400 ─── [branch summary]
       │      │      │      │
       │      │      │      └── ... (continues)
       │      │      │
       │      │      └── turns 301-1000 ─── CURRENT
       │      │
       │      └── ... (other branches from same checkpoint)
       │
       └── ... (other branches from same checkpoint)
```

Each branch is a self-contained context window. The full session history is preserved in the tree. You can navigate to any branch at any time.

## Verification

### Prerequisites

- The `context_navigate` tool must be registered and working
- Tags must persist across branch checkouts
- Branch summaries must be injected into the new branch's context

### Test

1. `context_navigate(action="tag", name="test-checkpoint")` → creates tag
2. `context_navigate(action="checkout", target="test-checkpoint", message="Testing branch")` → creates branch
3. Verify the new branch has:
   - Fresh context (low usage)
   - The branch summary (from the message parameter)
   - The tag is preserved (can navigate back)
4. `context_navigate(action="checkout", target="before-test-checkpoint")` → navigate back
5. Verify the old context is preserved

### Expected Behavior

- After checkout, context usage drops to near 0% (fresh branch)
- The branch summary is visible in the new context
- The old branch is still accessible via `context_navigate checkout`
- No compaction events fire (no `session_compact` handler)
- No stack overflow (no `sendTrackedMessage` with `triggerTurn: true` from compaction)