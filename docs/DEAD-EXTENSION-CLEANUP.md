# Dead Extension Cleanup — Deep Research Review

> **Goal:** Identify extensions, tools, and commands that add no value, create noise, or
> are dead weight. Propose a phased cleanup plan with safe removal order.

---

## Methodology

1. **Static analysis:** grep for `registerTool`, `registerCommand`, `pi.on` across all extensions
2. **Cross-reference:** module definitions (`src/modules/definitions.ts`) for opt-in vs always-on
3. **Import graph:** which extensions import from which libraries
4. **Historical audit:** SKEPTIC-AUDIT.md (2026-04-14) + FEATURE-AUDIT.md findings
5. **Test coverage:** which extensions have runtime tests, which don't

---

## Phase 1: Vestigial Commands (Low Risk)

These commands are debugging artifacts from development. They register via `registerCommand`
but the agent never invokes them, and they expose internal state that shouldn't be user-facing.

| Command | Extension | Action |
|---------|-----------|--------|
| `enforcement-on` | enforcement | Remove — enforcement auto-activates |
| `enforcement-off` | enforcement | Remove — no use case for disabling |
| `enforcement-stats` | enforcement | Remove — debugging artifact |
| `loop-status` | reasoning | Remove — internal state, not user-facing |
| `loop-reset` | reasoning | Remove — debugging artifact |
| `loop-help` | reasoning | Remove — debugging artifact |
| `feedback-status` | feedback | Remove — redundant with `feedback-config` |
| `feedback-whitelist-show` | feedback | Remove — too granular |
| `feedback-whitelist-add` | feedback | Remove — too granular |
| `feedback-whitelist-remove` | feedback | Remove — too granular |

**Keep:** `feedback-config` (central config), `feedback-toggle` (on/off)

**Risk:** Zero — these are UI-only commands, no tools or events depend on them.

---

## Phase 2: Over-Tooled Extensions (Medium Risk)

Extensions that register tools the agent rarely or never uses in practice.

### 2a. `plan_with_budget` (core/planner)

- **Why remove:** Verbose output fills context. Agent rarely follows the phased plan.
- **Replacement:** `scratchpad` already has task management with priorities and dependencies.
- **Risk:** Low — planner tools are self-contained, no other extension imports from planner.
- **Action:** Remove tool, keep planner extension for `session_start` goal restoration.

### 2b. `check_budget` / `set_budget` (metacognition)

- **Why remove:** Budget tracking is manual and rarely invoked. Should be automatic.
- **Risk:** Low — self-contained tools, no dependents.
- **Action:** Remove tools. If budget tracking matters, make it automatic via heartbeat.

### 2c. `cognition_evaluate` / `heuristics_evaluate` (metacognition)

- **Why remove:** Heuristic evaluation is an indirect metric. Agent never uses the output.
- **Risk:** Low — no dependents.
- **Action:** Remove tools. Keep the heuristic definitions for internal enforcement use.

### 2d. `preprocessor_config` / `preprocessor_stats` (user-message-preprocessor)

- **Why remove:** Preprocessor is foundational infrastructure. Exposing config as agent tools
  invites misconfiguration.
- **Risk:** Medium — preprocessor affects all user input. But the tools themselves are rarely used.
- **Action:** Remove tools. Keep preprocessor extension with hardcoded defaults.

### 2e. `heartbeat_status` (heartbeat-scheduler)

- **Why remove:** Debugging tool. Agent never uses it productively.
- **Risk:** Low — self-contained.
- **Action:** Remove tool. Keep heartbeat-scheduler as invisible infrastructure.

### 2f. Latent behavior tools (latent-activator)

- `activate_behavior`, `deactivate_behavior`, `get_active_behaviors`, `activate_mix`
- **Why reconsider:** Interesting concept but the agent doesn't discover or activate behaviors
  naturally. Mostly self-activation via enforcement whispers.
- **Action:** Keep for now (low cost, potential research value). Revisit in v0.14.

---

## Phase 3: Dead Code / Unused Libraries (High Value)

### 3a. `context-manager/retry.ts`

- **Status:** Dead code. Functions `triggerCompactionRetryFromAgentEnd` and
  `triggerOverflowRetryFromAgentEnd` are intentionally empty no-ops.
- **Action:** Delete the file. All retry logic lives in `compaction.ts` now.

### 3b. `evolve` extension (opt-in)

- **Status:** Opt-in, rarely enabled. The `evolve` tool is never naturally invoked.
- **Action:** Keep as opt-in. Don't load by default. Consider removing in v0.14 if unused.

### 3c. `watchdog` extension (opt-in)

- **Status:** Opt-in error monitoring. Useful for debugging but adds event listeners
  on `session_start`, `message_end`, `agent_start`, `agent_end`.
- **Action:** Keep as opt-in. Useful for production debugging.

### 3d. `rate-limiter` extension (opt-in)

- **Status:** Opt-in usage throttling. Experimental.
- **Action:** Keep as opt-in. Low cost when disabled.

---

## Phase 4: Architectural Cleanup (High Risk, Deferred)

### 4a. Sync FS in event handlers

Files using sync I/O in event-driven code:
- `analytics/index.ts` — `readFileSync`, `writeFileSync`
- `codebase-tree/index.ts` — `readFileSync` (for .gitignore)
- `error-capture/index.ts` — `writeFileSync`
- `feedback/index.ts` — `writeFileSync`, `readFileSync`

**Action:** Convert to async (fs/promises). Batch these conversions together.

### 4b. Global variable coupling

`enforcement/index.ts` exports mutable state that `prompt-builder/index.ts` reads directly:
```
let _enforcementSignals: Record<...> = {}; // Writable by enforcement, read by prompt-builder
```

**Action:** Replace with event-based communication. Enforcement emits signals via
`pi.events.emit("enforcement_signals", data)` and prompt-builder listens.

### 4c. context-lifecycle overengineering

360 lines of types, 187 lines of policy engine, 259 lines of signal detector — for what
amounts to "if context > 70%, nudge agent." Signal types `redundancy_detected` and
`context_pressure` are defined but never fire.

**Action:** Simplify. Remove unused signal types. Replace policy engine with simple
threshold checks in the `context` event handler.

---

## Summary: Removal Counts

| Phase | Items | Risk | LOC Saved (est.) |
|-------|-------|------|-------------------|
| 1. Vestigial commands | 10 commands | Zero | ~200 |
| 2. Over-tooled extensions | 8 tools | Low | ~400 |
| 3. Dead code | 1 file, 3 opt-in reviews | Low | ~150 |
| 4. Architecture (deferred) | 4 files sync→async, coupling | High | ~800 (rewrite) |

**Total immediate savings:** ~750 LOC, 10 commands, 8 tools removed.
**Tool count:** 53 → 45 (more manageable).

---

## Execution Order

1. **Phase 1** — Remove vestigial commands (5 min, zero risk)
2. **Phase 3a** — Delete `retry.ts` dead code (1 min)
3. **Phase 2a-2e** — Remove over-tooled tools (15 min, low risk)
4. Build + test after each phase
5. **Phase 4** — Defer to v0.14 sprint (requires design)

---

*Generated: 2026-04-28 | Based on SKEPTIC-AUDIT.md, FEATURE-AUDIT.md, and static analysis*
