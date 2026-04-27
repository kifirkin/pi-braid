# lib/cognitive-memory.ts

**Purpose**: Unified cognitive memory — merges memory extension (insight, pattern, preference, goal, error with utility scoring) and advanced-memory (episodic, semantic, procedural with relevance search).

## Memory Types

| Type | TTL | Scoring | Description |
|------|-----|---------|-------------|
| `insight` | 7d | Utility | Key realizations and findings |
| `pattern` | 30d | Utility | Recurring code/behavior patterns |
| `preference` | 7d | — | User preferences and settings |
| `goal` | 1d | — | Active goals and objectives |
| `error` | 30d | Utility | Error patterns and solutions |
| `episodic` | 7d | Utility | Task episodes and outcomes |
| `semantic` | 30d | Utility | Semantic knowledge and facts |
| `procedural` | ∞ | — | Reusable procedures and heuristics |

## Key Functions

| Function | Description |
|----------|-------------|
| `remember(category, content, tags?, importance?)` | Store a memory |
| `recall(query, category?, limit?)` | Search memories by text relevance |
| `recallByTags(tags, category?)` | Filter by tag intersection |
| `get(id)` | Get single memory by ID |
| `boost(id)` | Increase utility score |
| `evict(id)` | Remove memory |
| `consolidate()` | Merge similar memories, prune old/weak ones |

## Key Patterns

- **Utility scoring**: Each memory gets a utility score that decays over time. `boost()` increases it; consolidation prunes low-utility entries.
- **Text search**: Simple TF-style relevance scoring based on query token overlap with memory content. No embeddings needed.
- **Auto-consolidation**: `consolidate()` runs periodically — merges near-duplicate memories and drops entries with utility below threshold.
- **File persistence**: Stores to `~/.pi/memory/memory.json`. Loaded on session_start, saved on shutdown.
