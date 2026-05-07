# lib/belief-store.ts

**Purpose**: Belief persistence — stores and retrieves beliefs from disk. Used by the belief-policy-engine for cross-session belief accumulation.

## Key Functions

| Function                           | Description                                         |
| ---------------------------------- | --------------------------------------------------- |
| `loadBeliefs()`                    | Load beliefs from disk (`~/.pi/agent/beliefs.json`) |
| `saveBeliefs(beliefs)`             | Save beliefs to disk                                |
| `mergeBeliefs(existing, incoming)` | Merge new beliefs into existing set (dedup by key)  |

## Key Patterns

- **Simple JSON persistence**: Read/write to a single JSON file. No database.
- **Dedup by key**: `mergeBeliefs` ensures each belief key appears only once — latest wins.
- **Cross-session accumulation**: Beliefs accumulate across sessions. They're not session-scoped — they represent persistent knowledge about the agent's environment and behaviors.
