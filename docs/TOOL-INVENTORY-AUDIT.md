# pi-braid Tool Inventory Audit

**Date:** 2026-06-10
**Triggered by:** User observation that we have ~40 registered tools and may have bloated.
**Method:** Discovered every `pi.registerTool()` call site, classified by purpose, looked for overlap and out-of-scope candidates.

## 1. Complete Inventory (42 tools)

### Core: prompt + environment (3)
| Tool | Purpose | Calls/turn | Out of scope? |
|---|---|---|---|
| `prompt_preview` | Show current system prompt | Dev-only | **YES** — debug tool, not a real agent capability |
| `time_status` | Current time / elapsed | Low | **YES** — `bash date` does this in 1 line |
| `workspace_snapshot` | Time-travel for files | Low | Marginal — useful but not daily-use |

### Core: state + memory (2)
| Tool | Purpose | Calls/turn | Overlap |
|---|---|---|---|
| `scratchpad` | 16 actions for goal/plan/decisions/notes/learnings/constraints | High | Overlaps with `task` |
| `task` | 8 actions for simple TODO list | High | Overlaps with `scratchpad` (plan ≈ task list) |

### Core: metacognition (6)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `think` | Reasoning chain | High | **Keep** — core braid |
| `hypothesize` | Generate hypotheses with format | Medium | **Keep** — core braid |
| `verify` | Verification loop | Medium | **Keep** — core braid |
| `verify_claim` | Verify a claim against evidence | Low | **Keep but merge with verify_decomposition** |
| `verify_decomposition` | Check task decomposition coverage | Low | Merge with `verify_claim` |
| `finalize` | Mark task complete + consolidate | Low | **Keep** — consolidation wiring |

### Memory: agent-bridge (6)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `memory_store` | Store memory | Medium | **Keep** |
| `memory_recall` | Search memory | Medium | **Keep** |
| `memory_list` | List memories | Low | Could merge into `memory_recall` |
| `memory_get` | Get memory by id | Low | Could merge into `memory_recall` |
| `conflict_qa` | Resolve memory conflicts | Low | **Keep** — important braid feature |
| `explore_paths` | Parallel sub-agent exploration | Low | **Keep** — multi-agent capability |

### Memory: stores (3) — internal
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `memory_episodes` | Read/write episodes | Low | **Keep** — episodic memory |
| `memory_heuristics` | Heuristic rules | Low | **Keep** — adaptive rules |
| `memory_tool_stats` | Tool usage stats | Low | Marginal — could fold into analytics |

### Memory: session-recall (2)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `session_search` | Search past sessions | Low | **Keep** |
| `session_query` | Query specific session | Low | Merge with `session_search` |

### Memory: context-manager (3)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `context_compress` | Compact context | High | **Keep** — critical |
| `context_inspect` | Inspect context state | Medium | **Keep** |
| `context_navigate` | Navigate context branches | Low | **Keep** |

### Memory: context-lifecycle (2)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `context_proposals` | Auto-suggested actions | Medium | **Keep** |
| `context_signal` | Emit context signal | Low | **Keep** — internal mechanism |

### Cognitive (2)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `check_topic_drift` | Check for topic drift | Low | **Keep** — core braid |
| `reset_topic_anchors` | Reset drift tracking | Low | Merge with `check_topic_drift` |

### Tools: timer (3)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `timer_set` | Set wakeup timer | Low | Merge with below |
| `timer_list` | List active timers | Low | Merge |
| `timer_cancel` | Cancel timer | Low | Merge |

### Tools: auto-singleton (3)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `auto_singleton_set` | Set inactivity watchdog | Low | Merge with below |
| `auto_singleton_cancel` | Cancel watchdog | Low | Merge |
| `auto_singleton_status` | Check watchdog | Low | Merge |

### Tools: behavior (1)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `behavior` | Manage behavior modes | Low | **Keep** — useful for self-regulation |

### Error tracking (4)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `error_list` | List errors | Low | Merge with below |
| `error_get` | Get error detail | Low | Merge |
| `error_clear` | Clear errors | Low | Merge |
| `error_stats` | Error stats | Low | Merge |

### Health (1)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `health_maintenance` | Health check / evolve / rollback | Low | **Keep** — self-monitoring |

### Heartbeat / analytics (3)
| Tool | Purpose | Calls/turn | Verdict |
|---|---|---|---|
| `get_session_metrics` | Session telemetry | Low | **Keep** — useful for self-eval |
| `get_tool_reliability` | Tool success rates | Low | **Keep** — useful for self-eval |
| `set_ab_variant` | A/B test | Low | **Out of scope** — dev/research, not agent use |

## 2. Findings

### A. Out of scope for braid (candidates for removal: 3)

These are not what an agent does in a normal session; they're developer/research affordances.

1. **`prompt_preview`** — debug tool. Used during development to inspect prompt assembly. Not part of the agent's productive loop. Move to a dev command or remove.
2. **`time_status`** — trivial. The agent can run `bash date` or any shell command. Whole tool exists for what `date` does in 30 chars.
3. **`set_ab_variant`** — A/B test variant selector. Used during research/eval, not during a normal agent run. The agent doesn't need to A/B test itself.

**Verdict:** Remove or move to dev commands. ~3 tools eliminated.

### B. Overlaps / can be merged (savings: 6-8 tools)

Tools that follow the same CRUD-shape pattern but split into N tools.

| Merge | Into | Net savings |
|---|---|---|
| `error_list/get/clear/stats` | `error` (4 actions) | -3 |
| `timer_set/list/cancel` | `timer` (3 actions) | -2 |
| `auto_singleton_set/cancel/status` | `auto_singleton` (3 actions) | -2 |
| `verify_claim/verify_decomposition` | `verify_extended` (2 actions) OR fold both into `verify` | -1 |
| `check_topic_drift/reset_topic_anchors` | `topic_drift` (2 actions) | -1 |
| `session_search/session_query` | `session` (2 actions) | -1 |
| `memory_list/memory_get` (store+recall already cover this) | fold into `memory_recall` | -2 |

**Verdict:** ~12 tools → ~5 tools. Net savings of 7-9 tools.

### C. Overlap between `scratchpad` and `task`

Both track progress. The differences:
- `scratchpad` has 16 actions: `set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, update_session, add_constraint, remove_constraint, add_learning, persist_learnings, note_compact, elevate_to_goal, elevate_to_plan, read, add_learning`
- `task` has 8 actions: `add, list, complete, fail, next, remove, stats, clear`

**Real overlap:** `scratchpad.add_plan` + `mark_done` = `task.add` + `complete`. A goal's plan items are essentially TODOs.

**Real differences:**
- scratchpad has typed items (decisions, learnings, hypotheses, constraints) with priority
- task has flat list with priority + dependencies
- scratchpad persists to per-project file; task persists to per-project file
- Both have a `prior_goal` / `prior_*` mechanism for state continuity across compaction

**Possible consolidation strategies:**
1. **Make task a thin wrapper over scratchpad**: `task.add` = `scratchpad add_plan` with a single text item, `task.list` = `scratchpad read | filter(plan)`. Saves redundancy but adds a layer.
2. **Pick one as canonical, deprecate the other**: This loses 8 vs 16 actions of capability. Risky.
3. **Live with both**: They're documented as different, scratchpad for thinking state, task for action items. The overlap is small (~10% of use cases).

**Recommendation:** Live with both, but document the distinction clearly in each tool's `description` and `promptSnippet`. The user already cleaned the data, now I should just add a 1-line clarifying note in each tool's `promptSnippet` so the agent knows which to use.

### D. Tools that look in-scope but are borderline (3)

- `memory_tool_stats` — just an analytics view. Could fold into `get_tool_reliability` from heartbeat analytics.
- `workspace_snapshot` — power-user tool, not used every turn. Could move to dev command.
- `context_signal` — internal mechanism (emit signal to context-lifecycle). The agent never calls this directly. Could become a non-tool API (just an exported function).

## 3. Recommended Plan

### Tier 1: Pure removal (out of scope)
- Remove `prompt_preview` (debug-only, not agent capability)
- Remove `time_status` (replaced by `bash date`)
- Remove `set_ab_variant` (research-only, not agent use)
- Remove `context_signal` (internal mechanism, not agent tool)

**Net: -4 tools.** Low risk because the agent doesn't use these in normal sessions.

### Tier 2: Consolidation (overlap reduction)
- Merge `error_*` (4) → `error` (1)
- Merge `timer_*` (3) → `timer` (1)
- Merge `auto_singleton_*` (3) → `auto_singleton` (1)
- Merge `verify_claim` + `verify_decomposition` → fold into `verify` (1)
- Merge `check_topic_drift` + `reset_topic_anchors` → `topic_drift` (1)
- Merge `session_search` + `session_query` → `session` (1)

**Net: -6 tools.** Each is a mechanical refactor: define new schema with action discriminator, route to existing functions.

### Tier 3: Add clarifying docs
- Update `scratchpad` and `task` descriptions to clearly state when to use which
- Add cross-references in each tool's prompt snippet

**Net: 0 tools changed, but reduces user confusion.**

### Tier 4: Borderline — needs user decision
- `memory_tool_stats` (fold into `get_tool_reliability`?)
- `workspace_snapshot` (move to dev command?)
- `behavior` (keep; niche but justified for self-regulation)
- `health_maintenance` (keep; the only way the agent can self-monitor)

## 4. Projected Final Inventory

- **Current:** 42 tools
- **After Tier 1:** 38 tools (-4 out-of-scope)
- **After Tier 2:** 32 tools (-6 consolidations)
- **After Tier 3:** 32 tools (docs only)

The "minimum viable braid" is probably ~25 tools. The 32-tool number is a reasonable target for a feature-complete agent. Going below 25 means dropping core capabilities.

## 5. Implementation order

1. **Document scratchpad vs task** (Tier 3) — zero risk, just text edits
2. **Remove out-of-scope tools** (Tier 1) — small, isolated changes
3. **Consolidate CRUD-shaped tools** (Tier 2) — straightforward, can be one tool family at a time
4. **Address borderline cases** (Tier 4) — requires user judgment

## 6. Open questions for user

1. Is `behavior` tool worth keeping? The latent-activator is large (438 lines) for one tool with 5 actions.
2. Should `memory_tool_stats` fold into `get_tool_reliability`? They're both "tool telemetry" but tracked in different stores.
3. Is `workspace_snapshot` (time-travel files) a real agent need or dev affordance?
4. Should `context_signal` stay as a tool or become an internal API?
