# Extension: verification

**Status**: ✅ Working
**Tests**: None
**Version**: v0.12.x

## Purpose

Agent claim verification — detects contradictions, unsupported assertions, and hedge-word issues in agent output. Provides the `verify_claim`, `verify_decomposition`, and `conflict_qa` tools.

## Architecture

Three verification tools:

1. **`verify_claim`** — Check a claim against retrieved context. Detects contradictions, unsupported claims, and hedging issues.
2. **`verify_decomposition`** — Verify that subtask decomposition fully covers the parent task. Detects gaps.
3. **`conflict_qa`** — View/resolve knowledge conflicts from the evidence pool. Supports `list`, `stats`, `resolve`, `search` actions.

## Events Handled

None — tools are called directly by the agent.

## Tools

| Tool                   | Description                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify_claim`         | Verify a claim against context. Params: `claim` (string), `context` (array of strings), `threshold` (0-1 confidence). Returns contradiction/unsupported/supported verdict. |
| `verify_decomposition` | Verify subtask decomposition coverage. Params: `parentTask`, `subtasks`, `constraints`. Returns coverage score with gaps.                                                  |
| `conflict_qa`          | Manage evidence-pool conflicts. Actions: `list` (show all), `stats` (summary counts), `resolve` (verdict: accept/reject/merge), `search` (filter by topic).                |

## Key Patterns

- **Claim verification**: Compares the claim against context passages using Jaccard/overlap similarity. Unsupported claims have low overlap with any context. Contradictions have high overlap but opposing polarity signals.
- **Decomposition gaps**: Subtask verification detects missing coverage by matching subtask descriptions against parent task requirements.
- **Evidence-pool conflicts**: Integrates with `lib/conflict-qa.ts` to manage evidence conflicts detected by the evidence pool.
