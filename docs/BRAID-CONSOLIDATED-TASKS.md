# BRAID Consolidated Task List
**Sources**: BRAID-WORK-TRACKER.md + BRAID-NEXT-PROPOSAL.md + prompt-builder-refactor.md
**Created**: 2026-04-22 | **Updated**: 2026-04-22 | **Agent**: Braid
**Total Items**: 35 | **Remaining**: ~25

---
## How to Use
- **Status**: ✅ Done | 🟡 In Progress | ❌ Not Started | 🔄 Ready to Start
- **Effort**: XS (<15min) | S (1h) | M (2-4h) | L (4-8h)
- **Track**: D=Archive Recovery | R=System | H=Health | BR=Behavior | BM=Benchmark | PB=Prompt-Builder
- **Dependencies**: Items that must complete first
## PHASE 0: Archive Recovery 🔴
### D0 - Daemon Orchestrator (Belief Store + Policy Engine)
**Status**: 🟡 ~80% Done
**Priority**: 🔴 HIGH | **Effort**: M (remaining ~2h)
**Dependencies**: D0.1 ✅ → D0.2 ✅ → D0.3 ✅ → D0.4 ✅
| Sub-item | Status | Notes |
|----------|--------|-------|
| D0.1: Unarchive daemon-orchestrator docs | ✅ Done | |
| D0.2: Implement belief store | ✅ Done | `src/lib/belief-store.ts` |
| D0.3: Wire belief-store into heartbeat | ✅ Done | PolicyEngine.evaluate() wired |
| D0.4: Implement dreamer module | ✅ Done | Self-reflection episodes |
| **D0.5: Meta-learning optimizer** | ✅ Done | Tick interval adjusts based on activation history effectiveness |
**Implementation hint for D0.5**:
```typescript
// In heartbeat-scheduler, track activation success/failure
// Adjust tick interval: faster when effective, slower when noisy
// Based on: activation_history → effectiveness_score → interval_delta
```
### D1 - Session Isolation
**Status**: ✅ Done
**Priority**: 🔴 HIGH | **Effort**: M
**Notes**: Enforcement singletons + session_end cleanup handler added
## PHASE 1: System Improvements 🔴
### R5 — Three-Memory Integration
**Notes**: Three-memory in recaller; RUMS retrieval wired into agent loop
### R7 — L1 Environment Consolidation
**Status**: 🔄 Partially Done | **Effort**: M (1h remaining)
**Priority**: 🔴 HIGH
**Track**: Infrastructure | **Files**: 3 files modified
**Problem**: Two separate L1 environments with overlapping concerns:
1. `agent-environment/index.ts` — session state, machine info
2. `prompt-builder/l1-environment.ts` — context %, memory count, checkpoint distance
3. **Missing**: path utilities scattered across modules
**What's done**:
- ✅ Created `src/lib/path-utils.ts` with `discoverPiPackage()` and `normalizePlatform()`
- ✅ Updated `agent-environment/index.ts` to use `normalizePlatform()`
- ✅ Updated `prompt-builder/l1-environment.ts` to use `discoverPiPackage()`
**NOT done** (1h remaining):
1. [ ] Update `prompt-builder/index.ts` to use `discoverPiPackage()` for `reconstructProjectContextSection()` instead of manual path walking
2. [ ] Audit for other files using manual pi package path discovery
3. [ ] Remove any duplicate `os` imports after refactor
4. [ ] TypeScript compile check: `npx tsc --noEmit`
5. [ ] Verify runtime: confirm pi package path shows in prompt
**Path naming convention** (established):
| Term | Example | Purpose |
|------|---------|---------|
| `piPackage` | `.../node_modules/@mariozechner/pi-coding-agent` | npm package folder |
| `agentDir` | `~/.pi/agent/` | pi config directory (from getAgentDir) |
| `cwd` / `projectDir` | `/Users/kifir/projects/vibe/implicit-framing` | user's current working directory |
**Files to modify**:
src/extensions/prompt-builder/index.ts  # Use discoverPiPackage() in reconstructProjectContextSection
audit: any file using manual path walking for pi package
**Implementation hint for prompt-builder/index.ts**:
import { discoverPiPackage } from "../../lib/path-utils.js";
// In reconstructProjectContextSection:
// Replace manual path walking with:
const piPackage = discoverPiPackage();
// Use for: agentDir context files, skills location, docs
**Validation command**:
```bash
# After changes, verify prompt shows correct paths:
cd /Users/kifir/projects/agents/pi-braid
npx tsc --noEmit
# Then run pi and check system prompt includes:
# Root: /Users/kifir/.local/share/mise/installs/node/22.22.0/lib/node_modules/@mariozechner/pi-coding-agent
### R6 — Session Recall Mid-Task
**Status**: ❌ Rotation-triggered only
**Priority**: 🟡 MEDIUM | **Effort**: M (2-3h)
**Dependencies**: D0.2 ✅
**What's needed**:
1. Proactive recall before tackling task
2. Cross-session linking ("research threads")
3. Session summary injection
**Implementation hint**:
// Hook into prompt-builder: query semantic memory → inject as "## Past Insights"
// Hook into metacognition/think: query episodic memory before reasoning
// Memory confidence threshold: only inject if importance > 0.7
### R8 - Planner vs Metacognition Conflict
**Status**: ❌ Two planning systems may conflict
**Priority**: 🟡 MEDIUM | **Effort**: S (analysis)
**Options**:
1. Merge into unified planning in metacognition
2. Deprecate planner extension
3. Keep separate with clear use-case differentiation
### R9 - Analytics & Feedback Wiring
**Status**: 🟡 Partial | Metrics now export to `~/.pi/logs/braid-metrics.jsonl` + A/B variant tracking + evolve wired
**Status**: ❌ Extensions exist but never export data
**Priority**: 🟡 MEDIUM | **Effort**: L (4-6h)
1. Metrics export to `~/.pi/logs/braid-metrics.jsonl`
2. Feedback loop closure (scores → adjust behavior)
3. A/B framework for experiments
**Enables**: BR2 (tool addiction), BR3 (nudge measurement)
### D2 - Async Migration
**Status**: ❌ ~70% done
**Priority**: 🟡 MEDIUM | **Effort**: M (2h)
**NOT done**:
- user-message-preprocessor (sync settings)
- prompt-guardian (sync prompts)
- repl extension (sync read/write)
### D5 - Evidence Pool Completeness
**Status**: ❌ Exists but not source-labeled
**Paper**: [2604.14170](https://arxiv.org/abs/2604.14170)
- Source labels on all evidence
- Faithful conflict handling (acknowledge not suppress)
- XoT two-stage reasoning
## PHASE 2: Behavior Research 🔴
### BR1 - Self-Reflection Patterns
**Status**: 🟡 System prompt updated, not validated
**Priority**: 🔴 HIGH | **Effort**: M (2-3h)
**Dependencies**: R5 ✅
**Research question**: Does Braid's self-reflection produce actual behavior change or compliance theater?
**System prompt changes** (already applied):
- MODE_AWARENESS - distinguish Production vs Analysis
- DELIVERABLE_HYGIENE - pre-action pause
- SELF_REFLECTION_GUIDANCE - prevention > explanation
- PROACTIVE_CHECKS - real-time validation
**Experiment**:
1. Give Braid task with known trap
2. Ask: "Reflect on your approach. What could go wrong?"
3. Measure: Does reflection match actual failure modes?
4. Compare explicit framing ("You MUST identify errors") vs implicit
**Validation needed**: Run against known trap tasks, compare old vs new behavior
### BR4 - Latent Activator Multi-Turn Test
**Status**: ❌ Not started
**Priority**: 🔴 HIGH | **Effort**: L (2-3h)
**Research question**: Does identity framing work in multi-turn (vs single-shot where it failed)?
**Experiment design**:
- Config A: pi-braid latent ON
- Config B: latent OFF
- Config C: baseline (no latent extension)
- Task: Multi-turn debugging (read → propose → test → fail → debug → fix)
- Metrics: solve rate, token usage, compliance behaviors
## PHASE 3: Prompt-Builder Refactor 🔴
Based on `implicit-framing` research: compliance theater from directive density
### PB1 - Prompt Simplification
**Changes made**:
- Removed 5 sections (~100 lines): THINK_SILENTLY, BEHAVIORAL_GUIDELINES, KEY_TOOL_COMBINATIONS, VERIFICATION_REMINDER, IMPLICIT_BUDGET
- Condensed INTERACTION_STYLE to single sentence
- Removed directive guidelines (behaviors are latent, not from directives)
- Removed latent behavior activation from prompt
- Removed unused imports
**Result**: 245 lines from ~460, ~30-40% token reduction
### PB2 - Latent Activator Runtime Refactor
**Priority**: 🟡 MEDIUM | **Effort**: M
1. Move 40 behaviors to runtime state, not prompt
2. Simplify to identity-based activation
3. Remove explicit behavior listings from prompt
**Rationale**: Listing behaviors triggers 79-100% compliance regardless of modality (research finding)
### PB3 - Enforcement Audit
**Files to audit**:
- `src/extensions/prompt-builder/l1-environment.ts`
- `src/extensions/watchdog/index.ts`
- `src/extensions/enforcement/` (if exists)
**What to find**:
- Stakes language: "if you don't", "will cause", "you must"
- Consequence framing in whispers
- Softening of self-assessment
**Why**: Context Over Content paper shows stakes signaling corrupts reasoning (ΔV = -9.8pp verdict shift)
// BEFORE: "If you don't verify, you'll produce bugs"
// AFTER: "You verify your work because that's who you are"
// Audit all whispers for consequence framing
function detectStakesSignaling(whisperHistory: Whisper[]): boolean {
  return whisperHistory.some(w =>
    w.content.includes('if you don\'t') ||
    w.content.includes('will cause') ||
    w.content.includes('you must')
  );
}
### PB4 - Benchmark Validation
**Run**: `cd evaluation && python pi_rpc_fixed.py --trials 5`
**Metrics to measure**:
- Solve rate (should maintain or improve)
- Token usage (should decrease 30-50%)
- Compliance behaviors (should decrease)
- Directive density count
## PHASE 4: Benchmarking 🟡
### BM1 - Multi-Turn Debugging Benchmark
**Priority**: 🔴 HIGH | **Effort**: L (3-4h)
**Why**: Current benchmarks are single-shot. pi-braid is designed for multi-turn.
**Design**:
Bug-fixing task with phases:
1. Read → 2. Propose → 3. Test (fail) → 4. Debug → 5. Fix → 6. Pass
Score:
- Diagnosis accuracy
- Fix quality
- Over-fix avoidance
- Explanation quality
### BM2 - Code Quality Benchmark
**Problem**: Pass rate ignores robustness, edge cases, documentation
**Metrics to add**:
- eslint score
- Cyclomatic complexity
- Edge case coverage
- Documentation score
- Idiomatic usage
### BM3 - Real-World Task Suite
**Priority**: 🟡 MEDIUM | **Effort**: L
**Tasks**:
- Add error handling
- Refactor callbacks
- Write tests
- Debug race conditions (multi-turn)
**Dependencies**: BM1
## PHASE 5: Cleanup & Health 🟢
### H5 - Polyfill Cleanup
**Status**: ❌ 4 intentional `as any` casts
**Priority**: 🟢 LOW | **Effort**: S (1h)
1. Remove (if pi core covers it)
2. Scope to pi-braid context only
3. Keep + document
### H6 - Error-Capture Subprocess Test
**Status**: ❌ Not tested
**Priority**: 🟡 MEDIUM | **Effort**: S (1h)
**What's needed**: Test error-capture against subprocess failures (e.g., `forge build`)
### H8 - Document All Extensions
**Status**: ❌ Not done
**Priority**: 🟢 LOW | **Effort**: S
**What's needed**: Architecture docs for each extension
### H9 - README Architecture Diagram
## Dependency Graph
D0.1 → D0.2 → D0.3 → D0.4 → D0.5 (meta-learning)
         ↓
      R6 (session recall)
    BR1 (self-reflection validation)
    BR4 (latent activator test)
R5 (three-memory) ──┬──► R7 (L1 Env consolidation)
                    ├──► BR1
                    └──► BM1 (multi-turn debugging)
                         ↓
                      BM3 (real-world tasks)
R9 (analytics) ──► BR2 (tool addiction)
                ──► BR3 (nudge measurement)
PB2 (latent refactor) ← PB1 (simplify)
PB4 (benchmark) ← PB2, PB3
## Recommended Execution Order
### Week 1: Critical Path
1. ~~D0.5~~ ✅ Meta-learning optimizer
2. **R7**: L1 environment consolidation (1h) — use discoverPiPackage() in prompt-builder
3. **BR1 validation**: Run self-reflection against known trap tasks (2h)
4. ~~PB2~~ ✅ Latent activator runtime refactor
5. ~~PB3~~ ✅ Enforcement audit
6. ⏸️ PB4: Benchmark validation (needs overnight run)
### Week 2: High Value
1. ~~R9~~ 🟡 Analytics wiring partial (metrics + A/B done; feedback loop needs more integration)
2. **BM1**: Multi-turn debugging benchmark (3-4h)
3. **BR4**: Latent activator multi-turn test (2-3h)
4. **R6**: Session recall mid-task (2-3h)
### Week 3: Cleanup
1. **D2**: Async migration (2h)
2. **D5**: Evidence pool completeness (2-3h)
3. **BM2**: Code quality benchmark (2h)
4. **H5, H6**: Cleanup tasks (2h)
5. **H8, H9**: Documentation (2h)
## Quick Status
| Track | ✅ Done | ❌ Remaining |
|-------|--------|--------------|
| D0 (Daemon) | 5/5 | 0 |
| D1 (Isolation) | 1/1 | 0 |
| D2 (Async) | 0/1 | 1 |
| D5 (Evidence) | 0/1 | 1 |
| R5 (Three-memory) | 1/1 | 0 |
| R7 (L1 Env) | 1/2 | 1 |
| R6 (Recall) | 0/1 | 1 |
| R8 (Planner) | 0/1 | 1 |
| R9 (Analytics) | 0/1 | 1 |
| BR1 (Reflection) | 0/1 | 1 (validation) |
| BR4 (Latent test) | 0/1 | 1 |
| PB1 (Simplify) | 1/1 | 0 |
| PB2 (Latent refactor) | 1/1 | 0 |
| PB3 (Enforcement) | 1/1 | 0 |
| PB4 (Benchmark) | 0/1 | 1 |
| BM1 (Multi-turn) | 0/1 | 1 |
| BM2 (Quality) | 0/1 | 1 |
| BM3 (Real-world) | 0/1 | 1 |
| H5 (Polyfill) | 0/1 | 1 |
| H6 (Error-capture) | 0/1 | 1 |
| H7 (Verify) | 1/1 | 0 |
| H8 (Docs) | 0/1 | 1 |
| H9 (README) | 0/1 | 1 |
**Total**: 8/28 done (~29%)
## Research Sources
| Paper | Finding | Applied To |
|-------|---------|------------|
| implicit-framing/main.tex | MUST → 18-67% token waste | PB1 ✅ |
| implicit-framing/main.tex | Identity framing +4pp effectiveness | PB2 |
| implicit-framing/main.tex | Listing behaviors → 79-100% compliance | PB2 |
| Layered Mutability (2604.14717) | Session isolation critical | D1 ✅ |
| Context Over Content (2604.15224) | Stakes signaling corrupts reasoning | PB3 |
| Heartbeat Scheduling (2604.14178) | Tick interval optimization | D0.5 |
| Credo (2604.14401) | Policy engine architecture | D0.2-D0.4 ✅ |
*Consolidated from BRAID-WORK-TRACKER.md + BRAID-NEXT-PROPOSAL.md + prompt-builder-refactor.md*
