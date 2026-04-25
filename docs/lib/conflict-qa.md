# lib/conflict-qa.ts

**Purpose**: Conflict question-answering — resolves evidence conflicts by generating targeted questions and managing the resolution workflow. Built on top of `evidence-pool.ts`.

## Architecture

Operates on the same session-scoped state as evidence-pool. Manages a QA workflow:
1. Conflict detected → generate clarifying question
2. Agent/user answers → evaluate against both conflicting claims
3. One side accepted, one rejected, or both merged

## Key Functions

| Function | Description |
|----------|-------------|
| `classifyConflict(e1, e2)` | Classify conflict type: direct, implication, reliability |
| `normalize(text)` | Normalize text for comparison (lowercase, trim, collapse whitespace) |
| `tokens(text)` | Split into tokens using word boundaries |
| `tokenOverlap(e1, e2)` | Compute Jaccard similarity between two evidence claims |

## Key Patterns

- **Conflict resolution**: Uses the evidence-pool's `resolveConflict` under the hood. Resolution verdicts are: `accept` (one side wins), `reject` (one side dismissed), `merge` (both contribute).
- **Token-based matching**: Simple but effective Jaccard overlap for claim similarity. No embedding model needed.
- **Companion to evidence-pool**: This module handles the human-interactive part of conflict resolution; evidence-pool handles the storage and conflict detection.
