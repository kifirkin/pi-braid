# Tool Inventory Audit (June 2026)

Audit of the 30 tools registered by pi-braid. Goal: identify bloat, redundancy, and
out-of-scope tools. Recommend cuts/merges based on actual call-site usage.

## Scope correction (from user)

- **pi SDK base**: 4 core tools + 3 additional (the SDK itself is small).
- **`task` tool**: was previously in pi-braid, already cut. Any references to it
  now are leftovers (e.g., stale files, agent tool descriptions). Track down and
  clean up.
- **Browser/web-fetch tools**: come from a separate extension (pi-core or
  another), not pi-braid. Out of scope for this audit.
- **This audit** focuses on pi-braid's 30 tools only.

## Complete inventory (30 tools, pi-braid-only)

### Cognitive / Metacognition (5)
| Tool | Purpose | Files |
|------|---------|-------|
| `think` | Structured thinking with decision/observation/reason | 10 |
| `hypothesize` | Root-cause analysis with ranked/tree/list formats | 6 |
| `verify` | Pre-finalize verification of code/reasoning/tools | 6 |
| `finalize` | Mark task complete, trigger calibration | 10 |
| `verify_claim` | Evidence-pool claim verification | 2 |

### Memory (12)
| Tool | Purpose | Files |
|------|---------|-------|
| `memory_store` | Persist a memory item | 8 |
| `memory_recall` | Search memory by query | 6 |
| `memory_episodes` | List recent episodes | 3 |
| `memory_heuristics` | View/manage adaptive heuristics | 2 |
| `session` | Past-session search/query | 14 |
| `conflict_qa` | Resolve conflicting memories | 1 |
| `explore_paths` | Sub-agent parallel hypothesis exploration | 2 |
| `context_compress` | Manual context compaction | 1 |
| `context_inspect` | Context health snapshot | 1 |
| `context_navigate` | Tag, log, checkout, prune | 1 |
| `context_proposals` | List/apply proposals | 2 |
| `workspace_snapshot` | Capture/list/diff/restore | 1 |

### Heartbeat / Analytics (2)
| Tool | Purpose | Files |
|------|---------|-------|
| `get_session_metrics` | Aggregated session stats | 1 |
| `get_tool_reliability` | Per-tool success/failure rates | 1 |

### Scheduling (1)
| Tool | Purpose | Files |
|------|---------|-------|
| `timer` | Set/clear/list timed reminders | 3 |

_(Removed: `auto_singleton` — see `docs/AUTO-SINGLETON-DECISION.md`.)_

### Self-management (4)
| Tool | Purpose | Files |
|------|---------|-------|
| `behavior` | Latent behavior activation | 2 |
| `health_maintenance` | (opt-in) Health-based checkpointing | 2 |
| `error` | (opt-in) Inspect captured extension errors | 1 |
| (latent-activator has no other tools) |  |  |

### Quality (1)
| Tool | Purpose | Files |
|------|---------|-------|
| `topic_drift` | Check/reset topic drift | 2 |

### Scratchpad (1)
| Tool | Purpose | Files |
|------|---------|-------|
| `scratchpad` | Per-project structured session memory | 11 |

## Cut-candidate deep dive (5 tools)

The user identified these as the first removal candidates. Deep investigation:

### 1. `auto_singleton` — watchdog, one-shot

**What it is**: Single-purpose inactivity watchdog. Arms with a timeout, renews
on every tool_call/turn_end, fires once if no activity for N seconds, auto-cancels.

**Relationship to `timer`**: AGENTS.md explicitly says it's a "specialization of
the more general `extensions/tools/timer/` extension. The general timer can set
multiple timers with arbitrary wake policies. The auto-singleton is constrained
to: at-most-one, auto-renew, one-shot, fires on inactivity."

**Question**: Can `timer` subsume `auto_singleton`?
- `timer` supports `set/list/cancel` with arbitrary delay
- `timer` does NOT auto-renew on activity — that's a special property
- Adding `set_auto` action to `timer` would consolidate, but adds complexity

**Assessment**: 1 reference in source (its own definition). Not heavily used.
Could either be (a) merged into `timer` as `set_auto` action, or (b) cut
entirely if "inactivity watchdog" isn't a common need. The agent rarely needs
this — it's mostly for autonomous session recovery.

**Recommendation**: MERGE into `timer` (add `set_auto` action with auto-renew).
Cuts 1 tool. The `timer` description should explain when to use `set_auto`.

### 2. `health_maintenance` — opt-in health + checkpointing

**What it is**: Monitors agent health (degradation detection), supports
checkpoint/rollback. 8 actions: `status`, `health`, `check`, `commit`, `rollback`,
`config`, `reset`, `benchmark`.

**Opt-in**: `disabledByDefault: true`. Not in default extensions.

**Usage**: 2 files. Heavyweight — pulls in `degradation-detector`,
`metacognitive-state`, plus its own `helpers.ts` and `format.ts`.

**Question**: Is this in scope for pi-braid?
- "Health-based checkpointing" is a major feature
- "Degradation detection" is already used by other extensions (turn-dedup,
  auto-recovery, watchdog)
- "Rollback" is a recovery primitive

**Assessment**: The functional primitives (degradation detection, checkpoint,
rollback) are real and useful, but:
- They might be better as internal infrastructure (no tool, just events)
- Or broken into smaller, more focused extensions
- The single tool with 8 actions is a Swiss Army knife — a sign of bloat

**Recommendation**: KEEP for now (opt-in) but flag for later review. Could be
split into `checkpoint` + `health` (two tools) if bloat becomes obvious.

### 3. `error` — opt-in error log inspection

**What it is**: Logs extension errors to `~/.pi/agent/braid/errors/errors.jsonl`,
provides a single tool with 4 actions (`list`, `get`, `clear`, `stats`).

**Opt-in**: `disabledByDefault: true`.

**Usage**: 1 file (just the tool definition + log file). The "26 file references"
I found earlier were mostly false positives (the word "error" appears in many
contexts like `errorMessage`).

**Question**: Does the agent need to read its own error log?
- During normal operation: probably not. The error is surfaced inline.
- During debugging: yes, but pi's own UI may already show this.
- The "log + read-back" pattern is only useful if someone reads it back.

**Assessment**: Lightweight (single file, no dependencies). Low cost to keep.
Question is whether the agent ever benefits from reading back errors.

**Recommendation**: KEEP for now (opt-in). Could be cut if the agent never
calls it. Monitor for usage.

### 4. `get_session_metrics` — passive session stats

**What it is**: Reads aggregated session metrics (call counts, rates, sequences).

**Usage**: 1 file. Defined in `heartbeat/analytics/index.ts`.

**Question**: Does the agent benefit from its own session metrics?
- During work: unlikely. The agent doesn't need to know "I've made 47 tool
  calls" to do its job.
- At session end: maybe for self-reflection, but `finalize` already does
  calibration.

**Assessment**: Observability tool. More for the developer watching the agent
than for the agent itself. Pi has its own metrics affordances.

**Recommendation**: CUT or make opt-in. If we keep it, mark `disabledByDefault:
true` in the manifest.

### 5. `get_tool_reliability` — passive per-tool stats

**What it is**: Reads per-tool success/failure rates.

**Usage**: 1 file. Same module as #4.

**Question**: Does the agent benefit from knowing each tool's reliability?
- Probably not for one-shot tool use. The tool either succeeds or doesn't.
- Could be useful for a meta-tool that routes to the most reliable tool, but
  the agent doesn't have such a router.

**Assessment**: Same as #4 — observability, not agent-actionable.

**Recommendation**: CUT or make opt-in. Same as above.

## Other notes (not cut candidates, but worth fixing)

### Stale references from the `task` tool cut

The `task` tool was cut earlier. We found:
- `~/.pi/agent/braid/scratchpads/--Users-kifir-projects-agents-pi-braid--/tasks.json`
  has 9 stale tasks from May 29 (orphaned storage file)
- The `scratchpad` AGENTS.md comment says "For richer task state (priority,
  dependencies, tags, fail/next/clear), add plan items and use read to view them."
  This is good — it explicitly directs agents away from the SDK's `task`.

**Action**: Delete the orphan `tasks.json` file. Verify no other references.

### `set_ab_variant` was removed (per analytics/AGENTS.md)

"A/B state is now set via `behavior` action=activate". This is already cleaned.

## Net cut/merge recommendations

| Action | Tool(s) | Result | Status |
|--------|---------|--------|--------|
| CUT | `auto_singleton` | -1 tool | **DONE** (commit pending) |
| OPT-IN | `get_session_metrics`, `get_tool_reliability` | 0 tools, but 2 fewer defaults | pending |
| KEEP-OPT | `health_maintenance`, `error` | 0 changes (already opt-in) | n/a |
| CLEANUP | orphan `tasks.json` file | -0 tools, but storage cleanup | pending user |
| MERGE | `memory_recall`/`episodes`/`heuristics` → `memory` | -2 tools | pending |

After all: **30 → 24 tools** with cleaner API and clearer tool-vs-internal
separation. (29 after this commit; pending: 1 more merge + 2 opt-ins.)

## Priority order (high confidence first)

1. Delete orphan `tasks.json` file (immediate, no risk)
2. Update `scratchpad` tool description to point agents at scratchpad, not
   SDK's `task` (1-line edit, prevents future confusion)
3. Make `get_session_metrics` + `get_tool_reliability` opt-in
   (1 manifest edit, 0 functional impact since they're rarely used)
4. Merge `auto_singleton` into `timer.set_auto` (small refactor, removes tool)

Lower priority:
5. Merge 3 memory read tools into 1 `memory` tool (touches more call sites)
6. Decide on `health_maintenance` / `error` long-term (out of scope for this pass)
