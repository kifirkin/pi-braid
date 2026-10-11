<!-- status: current -->

# src/lib/store/ - Persistent Stores

Persistent stores for ad-hoc claims, evidence, conflicts, and beliefs.
Different from `lib/memory/` (which is the structured three-store memory) -
these are smaller, domain-specific stores.

## Files

| File                        | Purpose                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `claim-tracker.ts`          | Tracks claims made by the agent (with confidence scores and source).                   |
| `evidence-pool.ts`          | Pool of evidence items that support/refute claims.                                     |
| `conflict-qa.ts`            | Conflict resolution - when two claims conflict, runs a Q&A to determine which to keep. |
| `bidirectional-verifier.ts` | Verifies a claim by independently checking it from both directions.                    |
| `belief-store.ts`           | Stores the agent's beliefs (current best-guess claims).                                |

## Local Contracts

- These stores are **persistent** (saved to disk). Use them for things that need to survive session boundaries.
- Each store has a JSON file in `~/.pi/agent/` or similar.
- Stores should be **append-only** when possible - easier to debug, easier to undo.
- See `conflict_qa` tool for the runtime contract on conflict resolution.
