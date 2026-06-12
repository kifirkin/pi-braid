# Tool Cut Candidates — Deep Dive

Detailed analysis of the 5 first-removal candidates. Each section explains
what the tool does, how it's used, and the cost/benefit of keeping vs cutting.

## 1. `auto_singleton` (inactivity watchdog)

**Location**: `src/extensions/scheduling/auto-singleton/`
**AGENTS.md**: 37 lines, thorough disambiguation
**Tool surface**: 3 actions (set/cancel/status) on one tool

### What it does

A one-shot inactivity watchdog. Arms with a timeout (30-3600s). Renews
on every `tool_call` and `turn_end` event. Fires once if no activity for
N seconds, then auto-cancels. When it fires, sends a steer with
`triggerTurn: true` to wake the agent.

### Why it exists (per AGENTS.md)

"For: autonomous sessions, long-running builds, recovery from transient
hangs."

### Relationship to `timer`

`auto-singleton/` is explicitly a **specialization of the more general
`extensions/tools/timer/` extension**:

| Property | timer | auto_singleton |
|----------|-------|----------------|
| Multiple concurrent | Yes (list shows N) | No (singleton) |
| Auto-renew on activity | No | Yes (every tool_call/turn_end) |
| One-shot | No (repeats if recurring) | Yes |
| Fire condition | Fixed delay | Inactivity timeout |
| Agent use case | "remind me in 5 min" | "wake me if I'm idle 30s" |

The AGENTS.md says: "The agent should use the right tool for the job".

### Cost

- 1 tool definition (~330 lines including manager class)
- 1 module, 1 AGENTS.md file
- Polling loop (1 interval per 5s)
- 1 file reference in source (just the tool definition itself)

### Benefit

- Autonomous session recovery (real scenario)
- Inactivity detection distinct from fixed-delay

### Recommendation

~~**MERGE into `timer` as `set_auto` action with auto-renew semantics.**~~
**CUT entirely** (per `docs/AUTO-SINGLETON-DECISION.md`, 2026-06).
The merge would have touched 5-7 files and risked regressing the
carefully-session-scoped `TimerManager`. The simpler and safer path
is to remove the niche watchdog tool entirely. The plain `timer`
covers the 90% case. The watchdog use case (if anyone needs it) is
recoverable via a thin script that uses `timer` with manual
re-scheduling on activity.

---

## 2. `health_maintenance` (opt-in health + checkpointing)

**Location**: `src/extensions/self/health-maintenance/`
**AGENTS.md**: 35 lines
**Tool surface**: 8 actions (status/health/check/commit/rollback/config/reset/benchmark)

### What it does

Monitors agent health, detects degradation, supports checkpoint/rollback.
Heavy-weight feature.

### Actions (8 total)

| Action | Purpose |
|--------|---------|
| `status` | Show current health score |
| `health` | Detailed health breakdown |
| `check` | Run a health check now |
| `commit` | Save a checkpoint |
| `rollback` | Restore a previous checkpoint |
| `config` | Update health-check config |
| `reset` | Clear all metrics |
| `benchmark` | Run a benchmark suite |

### Opt-in status

`disabledByDefault: true`. User must explicitly enable via
`BRAID_MODULES=+health-maintenance` or settings.json.

### Dependencies

Pulls in:
- `lib/detection/degradation-detector.js` (used by other extensions too)
- `lib/state/metacognitive-state.js`
- Own `helpers.ts`, `format.ts`, `types.ts`

### Cost (when opt-in)

- 4 files, ~200 lines
- 8-action tool (Swiss Army knife — a sign of bloat)
- Background metric tracking

### Benefit

- Real health monitoring (not just metrics)
- Checkpoint/rollback for catastrophic errors
- Used by `watchdog` extension for session monitoring

### Question

Is health monitoring a "core braid" concern or a "peripheral" concern?

The primitives are real (degradation detection, checkpoint, rollback), but:
- Degradation detection is already in `lib/detection/`
- Checkpoint/rollback is rare in normal use
- The single tool with 8 actions signals bloat

### Recommendation

**KEEP for now (opt-in)**. The functionality is real, even if heavy. Consider
splitting into 2 tools (`checkpoint` + `health`) if bloat becomes obvious.

---

## 3. `error` (opt-in error log inspection)

**Location**: `src/extensions/self/error-tracking/`
**AGENTS.md**: 21 lines
**Tool surface**: 4 actions (list/get/clear/stats) on one tool

### What it does

Auto-catches extension errors from `tool_execution_end` events and
`turn_end` events. Persists to `~/.pi/agent/braid/errors/errors.jsonl`.
Single LLM-callable tool to query and manage the error history.

### Why it exists (per AGENTS.md)

"Log + read-back" pattern. Only useful if someone reads it back.

### Opt-in status

`disabledByDefault: true`.

### Cost (when opt-in)

- 1 file, ~307 lines
- 4-action tool
- One file read on session start (~/.pi/agent/braid/errors/errors.jsonl)

### Benefit

- Diagnostic: agent can see what went wrong in past turns
- Audit trail (handled flag, never deleted)
- Already light-weight

### Question

Does the agent benefit from reading its own error log?
- During normal operation: probably not (errors surfaced inline)
- During debugging: yes
- Pi's own UI may already show errors

### Recommendation

**KEEP for now (opt-in)**. Light-weight, useful for debugging. Could be
cut if usage is zero.

---

## 4. `get_session_metrics` (passive session stats)

**Location**: `src/extensions/heartbeat/analytics/index.ts:299`
**Tool surface**: 1 action (read-only), no parameters

### What it does

Returns aggregated metrics for the current session:
- Total tool calls
- Unique tools
- Duration
- Per-tool breakdown

### Usage

- 1 file (the tool definition itself)
- No internal callers (analytics tracks in background; the tool is for
  LLM consumption only)

### Question

Does the agent benefit from its own session metrics?
- During work: unlikely. Agent doesn't need "I've made 47 tool calls" to do its job.
- At session end: maybe for self-reflection, but `finalize` already calibrates.

### Cost

- ~20 lines (tool definition + execute)
- One tool name in the LLM's available-tool list

### Benefit

- Observability for the agent
- Could enable meta-tools that route to reliable tools

### Recommendation

**CUT or make opt-in.**

If we keep it, mark opt-in via a settings check. The cost is low, the
benefit is unclear, and removing it reduces tool surface.

---

## 5. `get_tool_reliability` (passive per-tool stats)

**Location**: `src/extensions/heartbeat/analytics/index.ts:388`
**Tool surface**: 1 action (read-only), no parameters

### What it does

Returns per-tool success/failure rates and p50/p95 durations.

### Usage

- 1 file (the tool definition itself)
- No internal callers

### Question

Does the agent benefit from knowing each tool's reliability?
- Probably not for one-shot tool use. The tool either succeeds or doesn't.
- Could be useful for a meta-tool that routes to the most reliable tool, but
  no such router exists.

### Cost

- ~20 lines
- One tool name

### Benefit

- Unclear

### Recommendation

**CUT or make opt-in.** Same as #4.

---

## Net summary

| # | Tool | Cost | Benefit | Verdict | Status |
|---|------|------|---------|---------|--------|
| 1 | `auto_singleton` | Low | Real | **CUT** | **DONE** |
| 2 | `health_maintenance` | High | Real | KEEP (opt-in, review later) | pending |
| 3 | `error` | Low | Marginal | KEEP (opt-in, monitor) | pending |
| 4 | `get_session_metrics` | Low | Unclear | CUT or opt-in | pending |
| 5 | `get_tool_reliability` | Low | Unclear | CUT or opt-in | pending |

After #1 (done) and #4, #5 (opt-in), the default tool count drops by 3
and the agent has a clearer API.

## Other findings (from this investigation)

### Stale `tasks.json` file

`~/.pi/agent/braid/scratchpads/--Users-kifir-projects-agents-pi-braid--/tasks.json`
(3KB, May 29, 9 stale entries) — orphan from the previously-removed `task` tool.
The project's `persistence.ts` retains `taskFilePath()` for cleanup tooling.
Safe to delete but flagged for user decision.

### `set_ab_variant` tool

Per `analytics/AGENTS.md`: "removed in the 0.3.0 audit; A/B state is now
set via `behavior` action=activate". The `set_ab_variant` tool isn't
currently registered, but a `set_ab_variant` field is in `types.ts`. No
action needed; just noting it.

### Two storage paths for project data

We discovered earlier that there are TWO slug-derivation paths in use:
- `projectSlugFromCwd()` (in `persistence.ts`): uses `--` prefix and suffix
- The SDK's `task` tool: uses no dashes

This creates 2 storage locations for the same project. Not a bug per se,
but it's a hidden inconsistency that can confuse readers and lead to data
duplication. Out of scope for this audit, but worth a future fix.

### `scratchpad` tool description updated

The `scratchpad` tool description now explicitly tells agents to use
scratchpad (not the SDK's `task`) for project work. This is the
high-confidence fix from the previous audit pass.
