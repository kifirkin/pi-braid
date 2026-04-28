# Dead Extension Cleanup — Review Template

> Mark each item: ✅ approve | 🔬 needs research | ❌ reject

---

## Phase 1: Vestigial Commands (Zero Risk)

- [confirm] Remove `enforcement-on` command
- [confirm] Remove `enforcement-off` command
- [confirm] Remove `enforcement-stats` command
- [confirm] Remove `loop-status` command
- [confirm] Remove `loop-reset` command
- [confirm] Remove `loop-help` command
- [confirm] Remove `feedback-status` command
- [confirm] Remove `feedback-whitelist-show` command
- [confirm] Remove `feedback-whitelist-add` command
- [confirm] Remove `feedback-whitelist-remove` command

## Phase 2: Over-Tooled Extensions (Low Risk)

### 2a. planner tools
- [confirm delete, but keep note for future research or proper implementation] Remove `plan_with_budget` tool
- [confirm delete, but keep note for future research or proper implementation] Remove `check_budget` tool
- [confirm delete, but keep note for future research or proper implementation] Remove `set_budget` tool

### 2b. cognition/heuristic tools
- [confirm] Remove `cognition_evaluate` tool
- [confirm] Remove `heuristics_evaluate` tool

### 2c. preprocessor tools
- [confirm] Remove `preprocessor_config` tool
- [confirm] Remove `preprocessor_stats` tool

### 2d. heartbeat tools
- [confirm] Remove `heartbeat_status` tool

### 2e. latent-activator tools
- [confirm, research] Keep all 4 tools (activate_behavior, deactivate_behavior, get_active_behaviors, activate_mix) — revisit in v0.14
- [decline] Remove all 4 tools
- [keep note for future research] Needs research

## Phase 3: Dead Code

- [there is /retry command and it seems usable for me, research] Delete `context-manager/retry.ts` (no-op functions)
- [confirm review, research in case of recently discovered papers applicable for pi-braid] Review `evolve` extension — keep opt-in or remove?
- [confirm review, research in case of recently discovered papers applicable for pi-braid] Review `watchdog` extension — keep opt-in or remove?
- [confirm review possibly mark for remove] Review `rate-limiter` extension — keep opt-in or remove?

## Phase 4: Architectural Cleanup (High Risk, Deferred)

### 4a. Sync → Async I/O
- [confirm] Convert `analytics/index.ts` (readFileSync, writeFileSync)
- [confirm] Convert `codebase-tree/index.ts` (readFileSync)
- [confirm] Convert `error-capture/index.ts` (writeFileSync)
- [confirm] Convert `feedback/index.ts` (writeFileSync, readFileSync)

### 4b. Global Variable Coupling
- [hard but critical, needs research and implementation document. codebases grows and messes too much.] Replace enforcement ↔ prompt-builder shared mutable state with event-based communication

### 4c. context-lifecycle Simplification
- [cleanup, note for future research in case of our papers] Remove unused signal types (redundancy_detected, context_pressure)
- [cleanup, note for future research in case of our papers] Simplify policy engine to threshold checks
- [cleanup, note for future research in case of our papers] Reduce types.ts from 360 lines
- [cleanup, note for future research in case of our papers] Reduce signal-detector.ts from 259 lines

---

*Mark each item with ✅ 🔬 or ❌ and I'll execute approved items.*

*sorry, but I have to stream my raw brain signals into those [brackets].
