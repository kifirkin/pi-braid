# Extension: context-manager

**Status**: ✅ Working
**Tests**: None (event-driven, hard to unit test)
**Version**: v0.7.x

## Purpose

Full-context lifecycle management — the largest extension at ~1,200 lines, decomposed into handler modules. Handles:

- Context pruning (deduplication, superseded writes, error purging, recency)
- Context compression (LLM-driven summarization)
- Navigation tools (tag, log, checkout, session search/query)
- Compaction integration (retry logic, reserve tokens, emergency rotation)
- Rotation handling (branch management, checkpoint coordination)

## Architecture

Decomposed from a monolith into 5 handler modules:
- `shared.ts` — state factory, helpers, retry logic, navigation utilities
- `tools.ts` — 6 tool registrations + 1 command
- `compaction.ts` — compaction events, retry with exponential backoff, smart instructions
- `navigation.ts` — tree navigation, branch checkout
- `events.ts` — agent_end retry, auto_retry_end, context pruning
- `rotation.ts` — rotation handlers, retry guard cleanup

## Events Handled

| Event | Handler |
|-------|---------|
| `session_start` | Set compaction reserve tokens (50K), initialize pruning state |
| `context` | Rule-based auto-pruning on every LLM call: dedup, superseded writes, error purge, recency |
| `session_before_compact` | Provide custom instructions for compaction summarization |
| `session_compact` | Track compaction events, add evidence for memory consolidation |
| `session_before_tree` | Provide auto-summaries for tree branching |
| `compaction_end` | Smart retry: overflow/threshold failures retry (once), other errors shown immediately |
| `agent_end` | Handle agent retry flow |
| `auto_retry_end` | Clean up auto-retry state |
| `turn_end` | Retry state reset, navigation checkout |
| `session_shutdown` | Final compaction attempt |

## Tools

| Tool | Description |
|------|-------------|
| `context_tag` | Create named save point (milestone) in session history |
| `context_log` | View conversation history as log |
| `context_checkout` | Navigate to any point in conversation history |
| `context_prune` | Analyze session for prune candidates (analysis only; auto-pruning runs on every LLM call) |
| `context_archive` | LLM-driven compression of a conversation range into a summary |
| `context_audit` | Comprehensive session analysis: usage stats, hygiene score, prune candidates, branching triggers |

## Commands

| Command | Description |
|---------|-------------|
| `/context-stats` | Show current context usage (tokens, entries, tags, summaries) |

## Key Patterns

- **Automatic pruning**: Every `context` event runs `applyPruningWorkflow()` — 4 rules (dedup, superseded_writes, error_purging, recency) + repair of orphaned tool pairs.
- **Compaction cascade prevention**: Emergency rotation trigger at 75% threshold. Retry uses `display:false` messages to avoid context pollution. Concurrency guards prevent stacked retries.
- **Navigation via tags**: `context_tag` creates session milestones, `context_checkout` navigates by tag name or entry ID. Checkout creates a branch via `branchWithSummary`.
- **No message deletion**: All context tools work on the `messages` array via the `context` event. Session files are append-only — no entries are ever deleted.
