# lib/evidence-pool.ts

**Purpose**: Structured evidence tracking with source labeling and automatic conflict detection. Implements XoT (Cross-observational Thinking) two-stage decomposition.

## Stage 1 — Evidence Explanation
- Classify sources into types: `memory`, `web`, `docs`, `code`, `session`, `unknown`
- Score each source with `SOURCE_RELIABILITY` weights
- Classify conflicts: `direct` (contradictory claims), `implication` (logical conflict), `reliability` (source trust mismatch)

## Stage 2 — Faithful Reasoning
- Generate acknowledgments that surface disagreement rather than silently picking one side
- Connected to `conflict-qa.ts` for question generation and enforcement whispers

## Key Functions

| Function | Description |
|----------|-------------|
| `addEvidence(ctx, source, claim, confidence, metadata?)` | Add evidence, auto-detect conflicts via `detectConflictsFor` |
| `getAllConflicts(ctx)` | Return all tracked conflicts |
| `getUnresolvedConflicts(ctx)` | Filter to unresolved conflicts only |
| `resolveConflict(ctx, id, verdict, resolution)` | Mark conflict as resolved |
| `detectConflicts(ctx)` | Run full conflict detection across all current evidence |
| `detectConflictsFor(ctx, evidenceId)` | Check new evidence against existing pool |
| `getEvidence(ctx, id)` | Retrieve single evidence entry by ID |
| `formatConflictMessage(conflict)` | Render conflict for agent consumption |

## State

Session-scoped via `getExtensionState(ctx, "evidence-pool", ...)`:
- `evidence: Evidence[]` — all stored evidence entries
- `conflicts: Conflict[]` — all detected conflicts
- `resolvedConflictIds: Set<string>` — IDs of resolved conflicts

## Key Patterns

- **Source-weighted confidence**: Each evidence entry has a `SOURCE_RELIABILITY` score. Conflicts that involve a low-reliability source vs a high-reliability one are automatically biased toward the reliable source.
- **Token-overlap matching**: `detectConflictsFor` uses token-overlap similarity (Jaccard) to find related evidence, then classifies the relationship.
- **Claims are normalized**: Evidence claims are lower-cased, whitespace-normalized, and stop-word-filtered before comparison.
