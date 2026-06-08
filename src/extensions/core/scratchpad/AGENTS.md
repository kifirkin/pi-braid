# Scratchpad Module

Structured session memory (CCA L2): goal, plan, decisions, notes, hypotheses, constraints, key_learnings, session metadata.

## Layout

| File | Purpose |
|---|---|
| `index.ts` | Tool registration + `scratchpadExecute` (all action handlers) |
| `types.ts` | All TypeScript types (KeyLearning, Constraint, PlanStep, etc.) |
| `persistence.ts` | Disk I/O, project slug, recycling/clean |
| `task.ts` | Separate `task` tool (extracted from monolith) |

## Two bugs fixed (2026-06)

### Bug 1: double-push (data corruption)

Every "append" case had a redundant `arr.push(item)` immediately followed by `capPush(arr, item, MAX)`. The `capPush` helper **internally pushes the item**, then caps. So every entry was being added twice.

**Affected cases** (7 + 1): `add_plan`, `mark_done`, `add_decision`, `add_hypothesis`, `add_note`, `add_constraint`, `add_learning`, `elevate_to_plan`.

**Empirical confirmation**: live scratchpad file had 2 copies of every entry. After one-time dedupe: 50 duplicates removed (plan: 20→10, done: 50→25, notes: 30→15, decisions: 22→11, constraints: 2→1).

**Fix**: removed the redundant `.push()` calls. `capPush` is now the single source of truth for append + capacity enforcement.

### Bug 2: `add_learning` "Invalid category:" with empty/bad category

The `add_learning` action used a pipe-delimited text format `"category|content|scope"` that wasn't documented in the schema description (the schema said "Text content"). When the model passed plain text without pipes, `parts[0]` (the category) became the entire sentence and failed validation with a bare `Invalid category: <whatever>.` error.

**Fix**:
1. Added explicit `category` + `content` + `scope` fields to the schema (preferred path).
2. Legacy pipe-delimited text still works (backward compat).
3. Added a category alias map: `bug`/`defect`→`root_cause`, `insight`/`idiom`→`pattern`, `solution`/`patch`→`fix`, `rule`/`requirement`→`constraint`, `fact`/`codebase`→`codebase_fact`.
4. Error message now: quotes the invalid input, lists valid categories, suggests common aliases, and points to the explicit-fields alternative.

## Action format (per case)

| Action | Required params | Optional params |
|---|---|---|
| `read` | — | — |
| `set_goal` | `text` (the goal) | — |
| `add_plan` | `text` (the step) | — (also parses `[budget:N]` suffix) |
| `mark_done` | `text` (the plan step text, exact match) | — |
| `add_decision` | `text` | — (also parses `decision\|reason`) |
| `add_hypothesis` | `text` | — |
| `add_note` | `text` | — |
| `update_session` | — | `turn`, `phase`, `mode` |
| `add_constraint` | `text` ("type\|description") | `expires_in_ms` |
| `remove_constraint` | `text` (constraint id) | — |
| `add_learning` | `text` (legacy) OR `category`+`content` | `scope` (array of tags) |
| `persist_learnings` | — | — |
| `note_compact` | — | — (triggers scratchpadClean) |
| `elevate_to_goal` | `text` | `successCriteria` |
| `elevate_to_plan` | `text` | — |

## Capacity (RECYCLE constants)

| Array | Max |
|---|---|
| `plan` | 20 (oldest pruned first) |
| `done` | 50 |
| `decisions` | 30 |
| `hypotheses` | 20 |
| `notes` | 30 |
| `key_learnings` | 50 |
| `constraints` | 20 |
| `tasks` | 50 (in separate `task` tool) |

## Tests

`test/runtime/lib/test-scratchpad-fixes.mjs` — 48 assertions covering both bugs:
- No double-push in any of the 8 affected cases.
- Schema accepts explicit `category`/`content`/`scope` fields.
- Legacy pipe-delimited text path still works.
- Category alias map covers common misspellings.
- Error message includes the bad input, valid list, alias suggestions, and explicit-fields hint.
- Tool description documents the new format.
