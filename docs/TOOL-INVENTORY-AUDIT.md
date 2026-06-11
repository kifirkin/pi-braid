# Tool Inventory Audit (June 2026)

Audit of the 30 tools registered by pi-braid. Goal: identify bloat, redundancy, and
out-of-scope tools. Recommend cuts/merges based on actual call-site usage.

## Complete inventory (30 tools, no SDK tools)

### Cognitive / Metacognition (5)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `think` | Structured thinking with decision/observation/reason | 10 |
| `hypothesize` | Root-cause analysis with ranked/tree/list formats | 6 |
| `verify` | Pre-finalize verification of code/reasoning/tools | 6 |
| `finalize` | Mark task complete, trigger calibration | 10 |
| `verify_claim` | Evidence-pool claim verification (moved from `cognitive/verification/`) | 2 |

### Memory (12)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `memory_store` | Persist a memory item (episode, principle, heuristic) | 8 |
| `memory_recall` | Search memory by query (semantic + keyword) | 6 |
| `memory_episodes` | List recent episodes | 3 |
| `memory_heuristics` | View/manage adaptive heuristics | 2 |
| `session` | Past-session search/query (consolidated `session_search` + `session_query`) | 14 |
| `conflict_qa` | Resolve conflicting memories | 1 |
| `explore_paths` | Sub-agent parallel hypothesis exploration | 2 |
| `context_compress` | Manual context compaction | 1 |
| `context_inspect` | Context health snapshot (audit) | 1 |
| `context_navigate` | Tag, log, checkout, prune context | 1 |
| `context_proposals` | List/apply context-management proposals | 2 |
| `workspace_snapshot` | Capture/list/diff/restore file snapshots | 1 |

### Heartbeat / Analytics (2)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `get_session_metrics` | Aggregated session stats | 1 |
| `get_tool_reliability` | Per-tool success/failure rates | 1 |

### Scheduling (2)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `timer` | Set/clear/list timed reminders | 3 |
| `auto_singleton` | One-shot inactivity watchdog | 1 |

### Self-management (4)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `behavior` | Latent behavior activation (`activate`/`deactivate`/`mix`) | 2 |
| `health_maintenance` | (opt-in) Health-based checkpointing | 2 |
| `error` | (opt-in) Inspect captured extension errors | 23 |
| (latent-activator has no other tools) |  |  |

### Quality (1)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `topic_drift` | Check/reset topic drift | 2 |

### Scratchpad (1)
| Tool | Purpose | Usage (files) |
|------|---------|---------------|
| `scratchpad` | Per-project structured session memory | 11 |

## Categories

### Definite bloat — MERGE

**1. `memory_recall` + `memory_episodes` + `memory_heuristics` → single `memory` tool with actions**

Three separate tool names for "access past stored items". All three are read paths
into the same `three-memory-stores` extension. Consolidating them into one tool with
an `action` parameter (like `scratchpad` already does) would:
- Cut 2 tool definitions and 2 schema documents
- Make the relationship between recall/episodes/heuristics explicit
- Match the existing `scratchpad` pattern (which already has `add_plan`/`mark_done`)

Implementation: deprecate the 3 names with a redirect, or rename and re-register.

### Definite bloat — RESOLVE (user-flagged)

**2. `scratchpad` vs SDK's `task` — pick one, document the choice**

The user flagged this as near-duplicate. The state we found:
- pi-braid registers only `scratchpad` (per-project, on-disk, rich state)
- The SDK has its own `task` tool (cross-project, simple TODO with priority/dependencies)
- Both are currently active in default extensions
- pi-braid's `scratchpad` has `add_plan`/`mark_done` actions that act as a TODO list

**Decision: keep `scratchpad` as the agent's primary TODO + thinking state.**
- It's richer (goal/plan/decisions/learnings)
- It's per-project (correct scoping)
- It's persistent on disk (survives restart)
- The SDK's `task` becomes unused by default

**Action**: update `scratchpad` tool description to explicitly tell agents to use
`scratchpad` (NOT the SDK's `task`) for project work. Add a note to AGENTS.md.

### Probably bloat — CUT (dev affordances, not agent-useful)

**3. `get_session_metrics` and `get_tool_reliability` — make opt-in or remove**

Usage: 1 file each. These look like dev/observability tools, not things the agent
needs to call during work. Pi has its own metrics affordances. If kept, mark
`disabledByDefault: true` in the manifest like `health-maintenance` and `error`.

**4. `explore_paths` — sub-agent tool, mark opt-in**

Usage: 2 files. Spawns parallel sub-agents for hypothesis exploration. This is
useful for deep research but adds significant tool count for an edge case. Could
move to opt-in like the others.

### Out of scope (already removed)

`prompt_preview` — removed (per comment in `core/prompt-builder/index.ts:825`:
"out of scope — dev/debug affordance, not agent use"). Good precedent.

## Net result if all recommendations applied

| Category | Before | After |
|----------|--------|-------|
| Cognitive/Metacognition | 5 | 5 (no change) |
| Memory | 12 | 10 (merge 3 → 1) |
| Analytics | 2 | 0–2 (cut or opt-in) |
| Scheduling | 2 | 2 (no change) |
| Self-management | 4 | 4 (no change) |
| Quality | 1 | 1 (no change) |
| Scratchpad | 1 | 1 (no change) |
| **Total** | **30** | **23–25** |

A modest 5–7 tool cut. More importantly, the relationship between scratchpad and
the SDK's `task` is now explicit (not a footgun for future agents).

## Out of scope for braid (NOT cuts — broader question)

The user asked: "some maybe out of scope for braid". Distinguishing between
"core braid value-add" and "extensions to it":

**Core braid (in scope)**:
- Cognitive chain: `think` / `hypothesize` / `verify` / `finalize` / `verify_claim`
- Memory: `memory_store` / `memory_recall` / `memory_episodes` / `memory_heuristics`
- Past session: `session`
- Memory quality: `conflict_qa`
- Context: `context_compress` / `context_inspect` / `context_navigate` / `context_proposals`
- File state: `workspace_snapshot`
- Quality signals: `topic_drift`
- Thinking state: `scratchpad`

**Peripheral (could be opt-in)**:
- `explore_paths` — sub-agent exploration (niche)
- `behavior` — latent activation (cognitive priming, not always-on need)
- `get_session_metrics` / `get_tool_reliability` — observability (dev affordance)
- `health_maintenance` / `error` — already opt-in, fine as-is

**Always-on infrastructure (not agent-facing)**:
- `timer` / `auto_singleton` — runtime scheduling primitives
- These are different in kind: the agent USES them, but they are not "tool affordances"

**SDK-provided (pi-braid doesn't register)**:
- `read` / `write` / `edit` / `bash` / `grep` / `find` / `ls` / `web_fetch` / `browser_*` — all from pi-core
- `task` — also pi-core; our recommendation is "agents should use `scratchpad` instead"

## Recommended next steps

1. **High-confidence cut** (do first):
   - Update `scratchpad` tool description to explicitly direct agents away from SDK's `task`
   - Add a paragraph to `AGENTS.md` about scratchpad vs task

2. **Medium-confidence merge** (do second):
   - Consolidate `memory_recall` + `memory_episodes` + `memory_heuristics` into single `memory` tool
   - Requires a deprecation path; could co-register the old names as aliases for 1 release

3. **Low-confidence cut** (decide later):
   - `get_session_metrics` / `get_tool_reliability` opt-in or remove
   - `explore_paths` opt-in

## Summary

The 30-tool inventory is bloated mainly by:
1. The 3 separate `memory_*` read tools (should be 1 with actions)
2. The unclear relationship between `scratchpad` and the SDK's `task`
3. Two analytics tools that look more like dev affordances than agent tools

Cutting these doesn't reduce functionality — it just reduces the API surface the
agent has to learn, and clarifies the thinking-state vs TODO-list relationship.
