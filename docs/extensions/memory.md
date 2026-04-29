# Extension Group: memory

Three-tier memory architecture with automatic persistence and session recovery.

## Extensions

| Extension | Files | Purpose |
|---|---|---|
| `context-manager/` | 8 | Compaction (v0.23), pruning, session lifecycle, navigation. |
| `context-lifecycle/` | 1 | S-MMU governance, proposal system, compaction lifecycle. |
| `session-recall/` | 1 | Past session search via semantic query. |
| `three-memory-stores/` | 1 | Semantic + episodic + procedural stores (200 entries, Jaccard dedup). |

Total: 16 `.ts` files across 4 sub-extensions.

## Key Architecture

**Three memory stores:**
- Semantic: semantic search relevance scoring
- Episodic: past session outcomes
- Procedural: learned patterns

**R6 auto-recall:** trigger on skill transition (3rd+), recentErrors, tool-reliability suggestions.

**Compaction v0.23:** LLM summarization always fires (no hard truncation bypass). Deduplication guard via `sessionId::leafId`. Token threshold uses `prep.tokensBefore`.

**Context lifecycle:** proposal → S-MMU policy → auto-compaction → resume steer.

## See Also

- [context-manager.md](context-manager.md) — compaction
- [context-lifecycle.md](context-lifecycle.md) — S-MMU governance
- [three-memory-stores.md](three-memory-stores.md) — memory stores
- [session-recall.md](session-recall.md) — past session search
