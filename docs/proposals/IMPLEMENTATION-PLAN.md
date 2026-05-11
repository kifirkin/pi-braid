# pi-braid Unified Implementation Plan

**Date**: 2026-05-08
**Status**: Meticulous codebase audit complete — every proposal cross-referenced against actual source
**Base commit**: `8f1883fe` (develop branch)

---

## How to read this plan

Each proposal from `IMPROVEMENT-PROPOSALS-INVENTORY.md` is listed with:
- **Status**: What the audit found in the actual codebase
- **Implementation delta**: What's truly missing (or already done)
- **Effort**: Estimated work
- **Dependencies**: What needs to exist first

---

## 🔴 P0 — Critical Path

### P0.1 SELF-EVOLUTION-META-COGNITION-PROPOSAL

**Source**: `proposals/SELF-EVOLUTION-META-COGNITION-PROPOSAL.md`
**Codebase audit**: PARTIALLY IMPLEMENTED → **NOW IMPLEMENTED**
- ✅ MARS reflector (`src/lib/mars-reflector.ts`) — wired in enforcement `handler-registry.ts`
- ✅ 3-tier SOP extraction on finalize (`src/extensions/core/metacognition/handlers/finalize.ts` lines 40-56)
- ✅ Dreamer module (`heartbeat-scheduler/modules/dreamer.ts`) — reflection + consolidation
- ✅ Belief-policy-engine, three-memory-stores — all wired
- ✅ Consolidation channel (`src/lib/consolidation-channel.ts`) — called by heartbeat
- ✅ **Self-evolution loop wired**: tool_end trajectory enrichment → SOP extraction → consolidation scoring → hint persistence → prompt injection
- ✅ **Consolidated hints**: High-scoring SOPs written to `~/.pi/agent/braid/consolidated-hints.jsonl` (20-hint cap, 30-day TTL)
- ✅ **Prompt injection**: Top 3 learned patterns injected as "Learned Patterns" section
- ✅ **Trajectory enrichment**: tool_end listener collects toolName + success/failure per step

**Remaining (P3)**:
- ❌ SOP → skill conversion (requires pi API support for dynamic skill registration)
- ❌ SOP validation against re-execution (requires benchmark harness)

**Effort**: DONE (1 day)
**Deps**: None

---

### P0.2 NUDGE QUALITY AUDIT

**Source**: `external/NUDGE-QUALITY-RESEARCH.md`
**Codebase audit**: MOSTLY DONE → **NOW IMPLEMENTED**
- ✅ Judge prompt: neutral framing (NOT "enforcement judge")
- ✅ 7-dimension schema includes `compliancePattern` dimension
- ✅ Nudge formatting: uses questions not directives
- ✅ **Score-based contradiction detection** (replaced severity labels per 2604.15224)
- ✅ **Positive reinforcement** when all 7 dimensions ≥90 (`"## Reasoning Looks Solid"`)
- ✅ Severity labels kept in interface for backward compat but no longer used for decision-making

**Effort**: DONE (0.5 days)
**Deps**: None

---

## 🟡 P1 — High Value

### P1.1 DYNAMIC SKILL LOADING

**Source**: `external/SKILL-LOADING-RESEARCH.md`
**Codebase audit**: PARTIALLY DONE → **PHASE 1 DONE**
- ✅ **SKILL_TRIGGERS keyword map** for all 15 skills with cwd patterns and project context keywords
- ✅ **scoreSkillRelevance()** scoring by cwd patterns + project context keywords
- ✅ **MAX_VISIBLE_SKILLS=7** limit with hidden count message
- ✅ **reconstructProjectContextSection()** returns contents for skill scoring
- ❌ Phase 2: Mid-session skill loading/unloading (blocked by pi API — skills loaded once at prompt build)
- ❌ No skill effectiveness tracking (needs P1.4 benchmark infrastructure)

**Implementation delta**:
1. **Audit token cost**: Measure how many tokens all 13 skills add to prompt (~1300 lines)
2. **Design skill metadata**: Add `trigger` and `deactivateOn` fields to skill interface
3. **Implement heartbeat-triggered activation**: Wire skill loading to heartbeat events (task_start, failure_detected, context_threshold)
4. **Add skill effectiveness tracking**: Track activations, success rates, token cost per skill
5. **Implement skill unloading**: Check if pi API supports `unloadSkill()` or equivalent

**Effort**: 3-4 days
**Deps**: P0.1 (SOP extraction provides effectiveness data)

---

### P1.2 PROMPT-GAP-ANALYSIS FIXES

**Source**: `external/prompt-gap-analysis.md`
**Codebase audit**: PARTIALLY DONE → **NOW IMPLEMENTED**
- ✅ SYCOPHANCY_RESISTANCE emitted
- ✅ STAKES_AWARENESS emitted
- ✅ Sycophancy-detector extension exists
- ✅ **Epistemic stability**: `EPISTEMIC_STABILITY` constant added to prompt-builder
- ✅ **Behavioral drift detection**: `behavioral-drift.ts` module using Jensen-Shannon divergence

**Effort**: DONE (1 day)
**Deps**: None

---

### P1.3 CONTEXT MANAGEMENT: DENSITY & PROVENANCE

**Source**: `external/CONTEXT-MANAGEMENT.md`
**Codebase audit**: PARTIALLY DONE → **NOW IMPLEMENTED**
- ✅ Semantic compression exists
- ✅ Context-density library exists
- ✅ 6 semantic unit types
- ✅ Priority system
- ✅ TTL/source/tags on memory_store (already existed)
- ✅ Evidence pool provenance (already existed)
- ✅ **Auto-trigger compaction**: When density stays below 40% for 3+ consecutive ticks, triggers `ctx.compact()` (20-turn cooldown)
- ✅ **Freshness scoring**: Memory recall applies 7-day half-life decay to penalize stale memories
- ❌ Adaptive compression ratios (ratio adapts via `determineCompressionLevel()` but not density-based)

**Effort**: DONE (1 day)
**Deps**: None

---

### P1.4 BENCHMARK CONTAMINATION & VARIANT INTEGRATION

**Source**: `external/BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md`, `external/BENCHMARK-SATURATION.md`, `proposals/VAR-MATH-VARIANTS.md`
**Codebase audit**: PARTIALLY DONE
- ✅ Variant generation exists (`evaluation/run-variants.mjs`, `evaluation/variant-tasks.mjs`)
- ✅ SDK harnesses exist (BM1-3, BR1, BR4, PB4 all migrated to JS SDK)
- ✅ 144/144 saturation finding documented and confirmed
- ❌ **No synthetic problem generation**: Variants are hand-written, not procedurally generated
- ❌ **No multi-instance evaluation**: Benchmarks don't require consistency across variants
- ❌ **No cross-bench comparison reports**: No automated comparison between configs across variant sets
- ❌ **No contamination detection framework**: No automated check for training data overlap

**Implementation delta**:
1. Build synthetic problem generator: parameterize problem templates with random seeds
2. Add multi-instance scoring: require 3/3 or 5/5 consistent solves across variants
3. Build cross-bench comparison pipeline: automated report comparing no-bash vs baseline vs braid-full vs braid-research
4. Add train-data overlap check: hash key problem patterns and compare against known training corpora

**Effort**: 3-4 days
**Deps**: SDK harnesses already exist

---

## 🔵 P2 — Medium

### P2.1 EXTENSION GROUP DOCUMENTATION

**Source**: `external/COUPLING.md`, `external/CLEANUP-PLAN.md`
**Codebase audit**: DONE → **NOW UPDATED**
- ✅ Group-level docs exist (`docs/extensions/{cognitive,core,heartbeat,memory,prompt,tools}.md`)
- ✅ Updated to reflect all implemented changes (behavioral drift, auto-compaction, freshness scoring, dynamic skills, score-based judging, consolidated hints)
- ✅ Individual extension docs exist (37 docs)
- ✅ Individual lib docs exist (`docs/lib/*.md`) — 20 docs

**Implementation delta**:
Create 6 group-level docs covering:
1. `docs/modules/cognitive.md` — enforcement + reasoning + verification + topic-drift + sycophancy-detector + cognitive-systems
2. `docs/modules/core.md` — polyfill + metacognition + scratchpad + preprocessor
3. `docs/modules/heartbeat.md` — heartbeat-scheduler + analytics
4. `docs/modules/memory.md` — context-manager + context-lifecycle + session-recall + three-memory-stores
5. `docs/modules/prompt.md` — prompt-builder
6. `docs/modules/tools.md` — healthcheck + timer + latent-activator + observatory + diff + system-monitor + research

**Effort**: 1 day
**Deps**: None

---

### P2.2 HARDEN SEMANTIC COMPRESSION

**Source**: `proposals/HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md`
**Codebase audit**: PARTIALLY DONE
- ✅ Semantic unit classification exists (6 types)
- ✅ Priority system exists (0-4)
- ❌ **Adaptive ratios not implemented**: Compression ratio is fixed, doesn't adapt to information density
- ❌ **Compression metadata for retrieval scoring**: No structured output describing what was preserved
- ❌ **Full consolidation loop not wired**: Episodic → semantic → procedural cascade not automated

**Implementation delta**:
1. Add adaptive ratio calculation based on `context-density.ts` signal/noise ratio
2. Add metadata output to semantic compression: `{ units_preserved: [...], units_collapsed: [...], units_dropped: [...] }`
3. Wire compression metadata → heartbeat density tracking → adaptive ratio next cycle
4. Automate memory cascade: after compression, push preserved units → episodic → semantic → procedural

**Effort**: 2 days
**Deps**: P1.3 (density monitoring)

---

### P2.3 BIDIRECTIONAL VERIFIER PHASE 2

**Source**: `proposals/BIDIRECTIONAL-VERIFIER-PROPOSAL.md`
**Codebase audit**: PHASE 1 DONE ONLY
- ✅ verify_claim tool exists
- ✅ verify_decomposition tool exists  
- ✅ Verification judge prompt exists
- ❌ **Backward verification missing**: After file edit, no check that dependent files are still valid
- ❌ **File dependency graph missing**: No tool to analyze which files depend on a changed file
- ❌ **Derived-file check injection**: Not wired into tool_end for automated check after edits

**Implementation delta**:
1. Build file dependency analysis tool (import graph scanning)
2. Wire backward verification into `tool_end`: after edit, check dependent files
3. Add `verify_backward` tool for explicit backward verification requests

**Effort**: 2 days
**Deps**: None

---

### P2.4 TOOL COVERAGE (bash replacement)

**Source**: `external/ToolCoverageProposal.md`
**Codebase audit**: NOT STARTED
- ❌ No `delete`, `move`, `copy`, `mkdir`, `permissions` tools
- ❌ No `run`, `test` tools (only `repl` exists)
- ❌ No `tree`, `locate` tools
- ✅ `read`, `write`, `edit`, `grep`, `find`, `ls` already built-in
- ✅ `diff` tool exists (as `file_diff`)
- ✅ `system_monitor` tool exists

**Implementation delta**:
Build Category 1 (file operations) and Category 4 (code analysis) tools first:
1. `delete` — with confirmation, no glob bypass
2. `move` — atomic move with backup
3. `copy` — recursive with exclude patterns
4. `diff` (file comparison) — exists as `file_diff`
5. `git_log` — safe, limited output

**Effort**: 3-4 days per tool (1-2 tools per sprint)
**Deps**: None (standalone)

---

### P2.5 DREAMER ACTIVATION TESTING

**Source**: `proposals/00-WORKER-TASKS.md`
**Codebase audit**: PARTIALLY DONE
- ✅ Dreamer module exists (`heartbeat-scheduler/modules/dreamer.ts`)
- ✅ Active state tracking with `shouldActivate()` + `activate()` paths
- ✅ 11 unit tests for dreamer paths
- ❌ **Not all worker-task patterns automated**: The dreamer fires but its output isn't always actionable

**Implementation delta**:
Complete remaining worker-task patterns from `00-WORKER-TASKS.md`

**Effort**: 1 day
**Deps**: P1.1 (skill loading provides effectiveness data for dreamer refinement)

---

## 🟢 P3 — Nice to Have

### P3.1 ABLATION STUDY EXECUTION

**Source**: `external/ABLATION_STUDY.md`
**Codebase audit**: FRAMEWORK EXISTS, NEVER RUN
- ✅ All instrumentation exists (think metrics, task metrics)
- ✅ Framework design documented
- ❌ **Study never executed**: No empirical validation of think() depth/utility model effects

**Implementation delta**:
Run the 2×2 factorial study (baseline × quick × deep × utility × combined) across 50 tasks

**Effort**: 0.5 days (compute time)
**Deps**: P1.4 benchmark infrastructure

---

### P3.2 OPENMYTHOS LOOP COMPARISON

**Source**: `external/OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md`
**Codebase audit**: NOT STARTED
- ❌ No cross-turn carry experiments
- ❌ No workspace belief accumulation

**Implementation delta**:
Design and run "cross-turn carry" comparison between pi-braid (external persistence) and OpenMythos (loop-based)

**Effort**: 2 days (research + experiments)
**Deps**: P1.4 (need experimental harness)

---

### P3.3 UNIR REASONING MODULES

**Source**: `external/TOOL-AUGMENTED-REASONING-EXTENDED.md`
**Codebase audit**: NOT STARTED
- ❌ No trained UniR modules for tool composition, fault localization, etc.
- ❌ Requires GPU compute and training infrastructure

**Implementation delta**:
Design training pipeline. Define reward functions. Train on pi-braid task traces.

**Effort**: 5+ days (requires GPU)
**Deps**: P1.4 (need benchmark tasks as training data)

---

### P3.4 LATENT SPACE STEERING (SAE)

**Source**: `proposals/SAE-STEERING-PROPOSAL.md`
**Codebase audit**: CORRECTLY ABANDONED
- ✅ Obsoleted by RepE Prompt Contrast (as documented in proposals/README.md)
- ❌ API providers (stepfun/minimax) don't expose activations/logprobs
- ❌ Would need open model provider (Llama/Ollama)

**Implementation delta**: None — correctly abandoned. RepE Prompt Contrast is the right approach for API-only providers.

---

## 📋 Summary — Priority Matrix

```

ID    | Proposal                          | Effort | Deps | Current State
------|-----------------------------------|--------|------|-----------------------
P0.1  | Self-evolution full loop          | DONE   | —    | ✅ 100% (loop closed)
P0.2  | Nudge quality audit               | DONE   | —    | ✅ 100% (score-based)
P1.1  | Dynamic skill loading             | Phase1 | —    | 🟢 Phase 1 done (top-7)
P1.2  | Prompt-gap fixes (epistemic loop) | DONE   | —    | ✅ 100% (all 3 gaps)
P1.3  | Density + provenance on context   | DONE   | —    | ✅ 100% (auto-compact + freshness)
P1.4  | Benchmark contamination/variants  | 3-4d   | —    | 🟡 30% (harnesses exist)
P2.1  | Extension group docs              | DONE   | —    | ✅ 100% (all 6 updated)
P2.2  | Harden semantic compression       | 2d     | P1.3 | 🟡 50% (classification done)
P2.3  | Bidirectional verifier Phase 2    | 2d     | —    | 🟡 25% (Phase 1 done)
P2.4  | Tool coverage (bash replacement)  | 3-4d/t | —    | 🔴 0% (not started)
P2.5  | Dreamer worker-task automation    | 1d     | P1.1 | 🟡 40% (dreamer exists)
P3.1  | Ablation study execution          | 0.5d   | P1.4 | 🟡 90% (design exists)
P3.2  | OpenMythos loop comparison        | 2d     | P1.4 | 🔴 0% (not started)
P3.3  | UniR reasoning modules            | 5d+    | P1.4 | 🔴 0% (GPU needed)
P3.4  | SAE steering                      | —      | —    | ✅ Obsoleted

```

## Already Implemented (proposals fully addressed)

These proposals' recommendations are already in the codebase. No action needed:

| Proposal | What's Done |
|----------|-------------|
| NUDGE-FATIGUE.md | Nudge dedup (50-turn cooldown, action tracking, identity framing) |
| OVERFLOW-INVESTIGATION.md | Proactive token monitoring at 70/80/90% via heartbeat |
| CONTEXT-TERMINOLOGY.md | Established naming: compaction vs archive vs finalize |
| BRAID-NEXT-PROPOSAL.md | D0-D5, R5-R9, BR1-BR4, PB1-PB4, BM1-BM3 — all implemented |
| OVERNIGHT-RESULTS.md | All bug fixes + 4 new extensions from v0.13.0 sprint |
| DEAD-EXTENSION-CLEANUP.md (most) | enforcement commands, loop commands, feedback-whitelist all removed |
| DOC-AUDIT.md | Per-doc verdicts already applied |
| FEATURE-AUDIT.md (parts) | prompt_preview tool makes prompt-builder observable |
| ABLATION_STUDY.md | Framework exists, instrumentation in place (just needs execution) |

## Partially in Progress

These have uncommitted changes in the working tree (tool description polish):

| Area | What's Being Done |
|------|-------------------|
| Tool descriptions | First sentence now includes "what it does + when to use" for all tools |
| Prompt visibility | `prompt_preview` tool for debugging prompt issues |
| prompt-builder | `firstSentence()` extraction + condensed tool listing |

---

_Generated by Braid — 2026-05-08_
_Codebase audit against `8f1883fe` (develop branch)_