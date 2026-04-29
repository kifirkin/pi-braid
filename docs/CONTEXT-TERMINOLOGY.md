# Context Lifecycle Terminology

## Core Distinction

| Term | Type | Who initiates | What happens |
|------|------|---------------|---------------|
| **compaction** | Event / system | pi core (automatic) | LLM summarizes + removes older context. Preserves backbone. |
| **session_compact** | Event name | pi core | Fires when pi initiates automatic compaction. |
| **compaction_end** | Event name | pi core | Fires after compaction attempt (success or failure). |
| **session_before_compact** | Event name | pi core | Fires before compaction — allows us to inject smart instructions. |
| **context_archive** | Tool (formerly `context_compress`) | Agent (manual) | LLM compresses a specific range of messages. Original preserved in session file. |
| **context_prune** | Tool | Agent (manual) | Rule-based cleanup. Identifies candidates, doesn't remove. Auto-runs on every LLM call. |
| **finalize** | Tool | Agent (manual) | Rotates session — summaries current work, preserves to memory, starts fresh branch. |

## Naming Rationale

- **compaction** = automatic system process (happens without agent consent)
- **archive** = manual agent action (agent decides when to use it)

The old name `context_compress` was too similar to `compaction`, causing confusion in user-facing messages. `context_archive` clearly distinguishes manual agent action from system behavior.

## Quick Reference

```
Auto (pi core)           Manual (Agent)
───────────────────────────────────────
compaction               context_archive
compaction_end           finalize
session_before_compact   context_tag
                         context_prune
                         context_audit
                         context_log
                         context_checkout
```

## Event Flow

1. `session_before_compact` → braid injects smart summarization instructions
2. `compaction` → pi runs LLM summarization (automatic)
3. `compaction_end` → braid handles success/failure/retry
4. If agent needs manual cleanup: `context_archive(startIndex, endIndex, summary)` or `finalize(completed, summary)`

## Rotations vs Compactions

- **Rotation** (`finalize`): Agent chooses to end a session cleanly. Produces a summary entry, clears state, starts fresh branch.
- **Compaction** (automatic): pi core trims context when it gets large. Happens mid-conversation without agent triggering it.

Both reduce context pressure but serve different purposes:
- Rotation = task completion / checkpoint
- Compaction = context management / overflow prevention