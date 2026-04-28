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

### 3a. `context-manager/retry.ts` ✅ DONE

- **Status:** Deleted. 165 lines of dead code using `triggerTurn:true` + `display:true` (removed in compaction cascade fix).
- All retry logic lives in `compaction.ts`. Zero imports from retry.ts.

### 3b. `evolve` extension (opt-in) ✅ CLEANED

- **Status:** Kept as opt-in. Removed dead pijul version control section from output formatting.
- 739→728 lines. Useful for health/degradation/analytics tracking.

### 3c. `watchdog` extension (opt-in) ✅ REVIEWED

- **Status:** Kept as opt-in. 77 lines, clean session health tracking. Low cost.

### 3d. `rate-limiter` extension (opt-in) ✅ REVIEWED

- **Status:** Kept as opt-in. 170 lines, experimental RPM/TPM limiting.
- Note: `throw` from `context` event handler could crash agent on oversized requests.

---

## Phase 4: Architectural Cleanup (High Risk, Deferred)

### 4a. sync→async (HOT PATH ONLY) ✅ DONE

Converted event handlers and tool execution hot paths to async fs:
- `prompt-builder/index.ts` — searchPastInsights, getSkillMeta, reconstructProjectContextSection, reconstructSkillsSection
- `memory/session-recall/index.ts` — nodeSearchFiles, searchLines, loadSessionMessages, searchFiles, turn_end handler
- `tools/repl/index.ts` — loadDataFromFile, loadDataFromGlob, resolveContext
- `browser/vision/index.ts` — getImageMetadata, readImageAsBase64
- `tools/docs/index.ts` — extractPdfWithPdfParse, render_pdf_page

Skipped (init/shutdown, acceptable sync): feedback init, three-memory-stores shutdown, healthcheck, prompt-guardian, preview.ts, l1-environment.ts, retry/state.ts

### 4b. Global variable coupling — DEFERRED

`enforcement/index.ts` exports mutable state that `prompt-builder/index.ts` reads directly.
Replace with event-based communication. Needs design.

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
