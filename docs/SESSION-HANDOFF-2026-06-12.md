# Session Handoff — 2026-06-12

This is a checkpoint for resuming work in a fresh chat session. The audit
of fragile patterns in pi-braid is in a good state; one large merge
remains for the next session.

## Where the audit stands

**Last commit on main:** `641c62bd` (docs: update timer investigation with
actual root cause). Working tree clean. 32/32 tests pass, typecheck clean,
check-deps clean, check-duplicates clean.

## What got done in this stretch (chronological, this session only)

The audit started before this session. The current session added 5
fragile-pattern fixes (commits, oldest to newest):

1. **`07e3de9e`** — `refactor(timer): use sendMessage whisper instead of sendUserMessage`
   - The critical fix for the user's "timers fill the input box" complaint
   - Root cause: input polisher intercepts `sendUserMessage`, treats as user input,
     re-fills the input box (doesn't send)
   - Switched `wake: true` to `pi.sendMessage({ customType: "timer-fire", content,
     display: true }, { triggerTurn: true })` — CustomMessage that wakes the
     agent without polisher interception
   - Removed `TIMER_FIRE_HANDLING` constant from prompt-builder (unnecessary noise)
   - Updated test to verify the new behavior
   - Files: `src/extensions/scheduling/timer/index.ts`,
     `src/extensions/core/prompt-builder/index.ts`,
     `test/runtime/lib/test-timer-fire-wake-handling.mjs`

2. **`fbff9b71`** — `docs: timer delivery investigation (whisper vs user input)`
   - Full investigation before the fix
   - Documents the SDK `sendUserMessage` vs `sendMessage` vs `sendTrackedMessage`
     behavior, and why the old code was wrong
   - File: `docs/TIMER-DELIVERY-INVESTIGATION.md`

3. **`e51ef0fb`** — `docs(restore): re-add TOOL-INVENTORY-AUDIT.md with analytics-cut updates`
   - Restored file that got accidentally deleted in commit 71255872
   - File: `docs/TOOL-INVENTORY-AUDIT.md`

4. **`134ae43c`** — `docs: mark analytics cuts as DONE in cut-candidates-deep-dive`
   - Updated analysis doc
   - File: `docs/CUT-CANDIDATES-DEEP-DIVE.md`

5. **`641c62bd`** — `docs: update timer investigation with actual root cause`
   - User identified input-polisher interception as the actual reason
   - File: `docs/TIMER-DELIVERY-INVESTIGATION.md`

## Tool inventory state

**30 → 27 tools registered by pi-braid** (3 cuts done in the broader audit):

| Tool | Status | Commit |
|------|--------|--------|
| `auto_singleton` | CUT | `5ffacd7b` |
| `get_session_metrics` | CUT | `8824877a` |
| `get_tool_reliability` | CUT | `8824877a` |
| `health_maintenance` | KEEP (opt-in) | — |
| `error` | KEEP (opt-in) | — |

## Outstanding work (in priority order)

### 1. ~~Merge 3 memory read tools into 1~~ (DONE)

Merged `memory_recall` + `memory_episodes` + `memory_heuristics` into a
single `memory` tool with 9 actions:

- `recall_search`, `recall_list`, `recall_get` (semantic unified memory)
- `episodes_search`, `episodes_list`, `episodes_add` (episodic store)
- `heuristics_list`, `heuristics_add`, `heuristics_evolve` (procedural rules)

Pattern follows the `scratchpad` tool's flat action namespace. Tool lives
in `src/extensions/memory/memory-agent-bridge/index.ts`; data-layer
functions stay in `three-memory-stores/`. Tool count now **25** (was 27).

### 2. `tools-config.json` orphan file (LOW PRIORITY)

`~/.pi/agent/braid/scratchpads/--Users-kifir-projects-agents-pi-braid--/tasks.json`
(3KB, dated May 29, 9 stale entries) — orphan from the previously-removed
`task` tool. The `persistence.ts` retains `taskFilePath()` for cleanup
tooling. User can delete manually if desired (it's user-data in `~/.pi/`,
not project code).

### 3. Two slug paths for project data (OUT OF SCOPE)

- `projectSlugFromCwd()` in `persistence.ts` uses `--` prefix and suffix
- The SDK's `task` tool uses no dashes

This causes 2 storage locations for the same project. Not a bug per se,
but a hidden inconsistency. Out of scope for this audit.

## Files in scope for the next session

### Documentation (current state)

| File | What it covers |
|------|----------------|
| `docs/TOOL-INVENTORY-AUDIT.md` | 30→27 tool inventory with cut/merge recommendations |
| `docs/CUT-CANDIDATES-DEEP-DIVE.md` | Deep dive on 5 cut candidates (3 done, 2 KEEP-OPT) |
| `docs/AUTO-SINGLETON-DECISION.md` | Decision doc for auto_singleton (CUT, not MERGE) |
| `docs/TIMER-DELIVERY-INVESTIGATION.md` | Timer fix investigation and root cause |
| `docs/SESSION-HANDOFF-2026-06-12.md` | This file |

### Code state

- `src/extensions/scheduling/timer/index.ts:295-385` — the fix (sendMessage whisper)
- `src/extensions/scheduling/auto-singleton/` — DELETED
- `src/extensions/heartbeat/analytics/index.ts:296-310` — analytics tools removed
- `src/extensions/memory/memory-agent-bridge/index.ts` — the 3 memory read tools to merge
- `src/extensions/heartbeat/analytics/AGENTS.md` — updated (0 tools)

## Scratchpad / Task state

- **Scratchpad goal**: "Continue fragile-pattern audit: extract shared
  extractJson to lib, scan remaining heuristics, then verify final state."
- **Plan**: 4 items (extract extractJson DONE, BUILTIN_HEURISTICS audit
  DONE with verdict KEEP, probe-handler audit DONE with verdict KEEP,
  Final verification DONE)
- **Task list**: 3 items, all completed (the live SDK task store at
  `~/.pi/agent/braid/scratchpads/Users-kifir-projects-agents-pi-braid/tasks.json`)

## Quick-start for the next session

When the user opens a fresh chat and asks to continue, look at:

1. **git log --oneline -10** — see the most recent commits
2. **This file** (`docs/SESSION-HANDOFF-2026-06-12.md`) — current state
3. **docs/TOOL-INVENTORY-AUDIT.md** — tool inventory status (25 tools)

The memory-tool merge is complete. The remaining items (orphan tasks.json,
two slug paths) are low-priority cleanups.
