<!-- status: forward-looking -->

# P2-10 / Q13: Large-File Decomposition Plan

## Rationale

Four files in the extension layer exceed maintainable size thresholds.
The `scratchpadExecute` dispatch function (DR-M-8) also qualifies as a
refactoring target. Splitting improves testability, reduces cognitive
load per file, and matches the `handlers/` pattern already established
by metacognition, context-manager, and enforcement.

## Candidates

| File | Lines | Decomposition strategy |
|---|---|---|
| `memory-agent-bridge/index.ts` | 963 | Split into types + stats + 6 handler files |
| `timer/index.ts` | 581 | Extract TimerManager class + types + helpers |
| `session-recall/index.ts` | 564 | Extract LLM query + search logic from factory |
| `scratchpad/index.ts` | 650 | Extract formatters + schemas from dispatch |
| `latent-activator/index.ts` | 296 | **No split needed** (under 300 lines) |

## Implementation Order

### 1. `session-recall/index.ts` (564 lines, EASIEST)

**Boundaries:**
- `text-utils.ts` already exists (66 lines)
- Everything else is in one flat file

**Split into:**
- `index.ts` — extension factory + tool registration (~80 lines)
- `search.ts` — session_search tool logic, keyword grep, session discovery (~200 lines)
- `query.ts` — session_query tool logic, LLM-based session analysis (~280 lines)

**Backward compat:** All public exports stay in `index.ts` via re-export.
No importers reference internal functions (only the default export).

### 2. `scratchpad/index.ts` (650 lines, MEDIUM)

**Boundaries:**
- Handlers already split into `handlers.ts`
- Types already split into `types.ts`
- Persistence already split into `persistence.ts`
- Utils already split into `utils.ts`
- What remains: formatting (106-300), cache (303-344), schemas (345-425),
  dispatch (426-624), registration (625-650)

**Split into:**
- `format.ts` — `formatScratchpad`, `formatContinueDigest` (moved from index.ts)
- `schemas.ts` — tool schemas (moved from index.ts)
- `index.ts` — cache + dispatch + registration (~200 lines)

**Backward compat:** `formatScratchpad` and `formatContinueDigest` are
exported from `index.ts` and imported by `handlers.ts` and external
callers. Keep re-exports in `index.ts` during the split.

### 3. `timer/index.ts` (581 lines, MEDIUM)

**Boundaries:**
- `TimerManager` class (72-163): all timer CRUD + persistence
- Module-level singleton + exported API (164-257)
- `fireTimer` + helper functions (258-367)
- `createTimerTool` + extension factory (368-581)

**Split into:**
- `types.ts` — `ScheduledTimer`, `TimerState` types
- `timer-manager.ts` — `TimerManager` class
- `helpers.ts` — `fireTimer`, `getSessionId`, `createTimerTool` helpers
- `index.ts` — extension factory, tool registration, public exports (~100 lines)

**Backward compat:** `scheduleTimer`, `cancelTimer`, `listTimers`,
`cancelTimersByTag`, `clearSessionTimers` are imported by
`src/lib/events/timer-bus.ts` at line 2. Keep re-exports.

### 4. `memory-agent-bridge/index.ts` (963 lines, HARDEST)

**Boundaries:**
- Stats tracking (56-100): `MemoryBridgeStats`, `createMemoryBridgeStats`,
  `getMemoryBridgeStats`, `recordMemoryToolCall`
- Handler functions inside `cognitiveMemoryExtension` (113-963):
  - `memory_store` handler (~100 lines)
  - `recall_search` handler (~80 lines)
  - `recall_get` handler (~50 lines)
  - `recall_list` handler (~40 lines)
  - `episodes_search` handler (~60 lines)
  - `episodes_add` handler (~40 lines)
  - `episodes_list` handler (~30 lines)

**Split into:**
- `stats.ts` — memory tool usage tracking (56-100, already extracted-ish)
- `handlers/memory-store.ts` — `memory_store` tool
- `handlers/recall-search.ts` — `recall_search` tool
- `handlers/recall-get.ts` — `recall_get` tool
- `handlers/recall-list.ts` — `recall_list` tool
- `handlers/episodes-search.ts` — `episodes_search` tool
- `handlers/episodes-add.ts` — `episodes_add` tool
- `handlers/episodes-list.ts` — `episodes_list` tool
- `index.ts` — extension factory, tool registration, re-exports (~80 lines)

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Broken imports** — external files import from old paths | Keep barrel re-exports in `index.ts` during migration |
| **Circular dependencies** — handler files import each other | Each handler file is independent; only imports from `lib/` |
| **Test breakage** — tests import internal functions | All tests import via `extensions/memory/memory-agent-bridge/index.js` — barrel re-exports preserve this |
| **`textResult` utility** — used across handlers | Import from `lib/utils/extension-utils.js`, no circular risk |

## Verification

Each file split is verified by:
1. `npx tsc --noEmit` — must be clean
2. `npm test` — must pass 81/81
3. `rg "old-path" src/` — no stale references after barrel re-exports removed
4. `npm run check:docs && npm run check:doc-drift` — doc discipline clean

## Commit Strategy

4 separate commits, one per file:
1. `P2-10a: split session-recall into search + query handlers`
2. `P2-10b: split scratchpad format + schemas from index`
3. `P2-10c: split timer into types + manager + helpers`
4. `P2-10d: split memory-agent-bridge into per-handler files`