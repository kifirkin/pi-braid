# pi-braid Improvement Proposals — Complete Inventory

**Date**: 2026-05-08
**Status**: Discovery complete — synthesis of proposals from three research directories
**Scanner**: Braid (this agent)

---

This document catalogs **every improvement proposal** for pi-braid found across three
source directories, cross-referenced against what's already in `docs/proposals/`.
Each entry includes a summary, source location, current implementation status,
and its relevance to active braid development.

---

## Source Legend

| Tag   | Location                                                                        |
| ----- | ------------------------------------------------------------------------------- |
| `[B]` | `braid/docs/` — already in pi-braid's docs                                      |
| `[A]` | `implicit-framing/pi-braid/docs/` — pi-braid clone snapshot                     |
| `[C]` | `llm-compliance-theater/braid-research/` — compliance theater research worktree |
| `[D]` | `implicit-framing/docs/research/` — implicit-framing research docs              |

---

## Tier 0: Active Proposals (already in braid)

These are already in `braid/docs/proposals/`. Status is per `proposals/README.md`.

| #   | Proposal                                                     | Source                                  | Status                     | Summary                                                                                                                                  |
| --- | ------------------------------------------------------------ | --------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **CONTRAST-PHRASE-LIBRARY.md**                               | [B] proposals/                          | ✅ FULLY IMPLEMENTED       | 4 behavioral modes (TRUTH-SEEKING, CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY) with per-scenario toggle via enforcement signals |
| 2   | **REPE-PROMPT-CONTRAST-PROPOSAL.md**                         | [B] proposals/                          | ✅ FULLY IMPLEMENTED       | RepE-style contrast vectors injected as identity phrases in prompt-builder                                                               |
| 3   | **HEARTBEAT-AS-EVENT-BUS.md**                                | [B] proposals/                          | ✅ FULLY IMPLEMENTED       | Unified event bus with 7 consumer handlers + observatory integration                                                                     |
| 4   | **MEMORY-LEAK-PREVENTION-AND-IMPLICIT-EXPLICIT-BOUNDARY.md** | [B] proposals/                          | ✅ FULLY IMPLEMENTED       | Cross-project memory isolation with deriveProjectId(), contamination signals                                                             |
| 5   | **AGENT-TIMER-POMODORO.md**                                  | [B] proposals/                          | ✅ FULLY IMPLEMENTED       | Non-blocking timers with heartbeat integration                                                                                           |
| 6   | **STRUCTURED-OUTPUT-CATALYST.md**                            | [B] proposals/                          | ❌ ABANDONED               | TOOL_RESULT/STATUS/DATA blocks confused weaker LLMs                                                                                      |
| 7   | **SELF-EVOLUTION-META-COGNITION-PROPOSAL.md**                | [B] proposals/, [C] self-evolution/     | 🔴 NOT STARTED             | Full self-evolution loop: mars-reflector + SOP extraction + consolidation channel (P0)                                                   |
| 8   | **SELF-EVOLUTION-RESEARCH-SYNTHESIS.md**                     | [B] proposals/, [C] self-evolution/     | 🔴 NOT STARTED             | Theoretical foundation for self-evolution (research only)                                                                                |
| 9   | **SAE-STEERING-PROPOSAL.md**                                 | [B] proposals/, [C] agent-architecture/ | 🔴 NOT STARTED (obsoleted) | SAE steering — obsoleted by RepE Prompt Contrast (API providers don't expose activations)                                                |
| 10  | **HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md**              | [B] proposals/                          | 🟡 PARTIAL                 | Compaction done; missing semantic classification, adaptive ratios, compression metadata                                                  |
| 11  | **BIDIRECTIONAL-VERIFIER-PROPOSAL.md**                       | [B] proposals/, [C] agent-architecture/ | 🟡 PARTIAL                 | Phase 1 (verify tool) done; missing backward verification + file dependency graph                                                        |
| 12  | **BENCHMARK-IMPROVEMENTS-PROPOSAL.md**                       | [B] proposals/, [C] agent-architecture/ | 🟡 PARTIAL                 | SDK harnesses exist; missing multi-turn loop, BM3 suite, variant generation                                                              |
| 13  | **VAR-MATH-VARIANTS.md**                                     | [B] proposals/, [C] agent-architecture/ | 🟡 PARTIAL                 | Eval infra exists; missing variant generation + cross-bench comparison reports                                                           |
| 14  | **CONSOLIDATION-CHANNEL-PHASE3-PROPOSAL.md**                 | [B] proposals/                          | 🟡 PARTIAL                 | Phase 1-2 infra done; full consolidation loop not wired                                                                                  |
| 15  | **00-WORKER-TASKS.md**                                       | [B] proposals/                          | 🟡 PARTIAL                 | Core extensions exist; not all worker-task patterns automated                                                                            |

---

## Tier 1: Braid Clone Docs (recovered from archive snapshot)

These were written in the `implicit-framing/pi-braid/` worktree (a fork/clone of braid) and
contain proposals, analyses, and audits not present in the main braid repository.

### 1.1 BRAID-NEXT-PROPOSAL.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/BRAID-NEXT-PROPOSAL.md`
**Size**: ~10KB, 328 lines
**Type**: Development roadmap

**Summary**: Maps remaining work across four tracks — Archive Recovery (D0-D5),
System Improvements (R5-R9, H5-H7), Behavior Research (BR1-BR4), and Benchmarking
(BM1-BM3). Each item has priority, effort, dependencies, and status. Most items
have been completed since this was written (April 22), but the proposal contains
implementation details useful for future regression checking.

**Key remaining items from this proposal**:

- D5 Evidence Pool: XoT two-stage reasoning (classify + whisper) — now done
- D1 Session Isolation: enforcement state singletons still use `let` statements
- R5 Three-Memory: proactive recall before think(), memory injection into prompt
- Compression metadata for retrieval scoring
- BM2/BM3 SDK harnesses (some done in JS, Python pending deletion)

**Value for braid**: Historical reference — most items are now complete. Useful for
auditing what was proposed vs what was actually implemented.

---

### 1.2 BR1-TRAP-TASKS.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/BR1-TRAP-TASKS.md`
**Size**: ~5.6KB, 132 lines
**Type**: Validation suite

**Summary**: Defines 6 trap tasks testing self-reflection infrastructure: tool spiral
trap, error persistence trap, over-read trap, conflicting evidence trap, rabbit hole
trap, and confidence miscalibration trap. Each has expected behavior, validation
criteria, and the infrastructure component under test (MARS reflector, belief-policy-engine,
enforcement, heartbeat dreamer, latent-activator).

**Key insight**: These traps test whether the agent recognizes when it's off-track.
They validate the same infrastructure that SELF-EVOLUTION-META-COGNITION-PROPOSAL
wants to build on.

**Value for braid**: Immediate — can be used as regression tests before/after
self-evolution implementation.

---

### 1.3 CONTEXT-MANAGEMENT.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/CONTEXT-MANAGEMENT.md`
**Size**: ~11.6KB, 257 lines
**Type**: Research-driven improvement proposal

**Summary**: Deep analysis of context management gaps. Identifies four root causes:
(1) count-based thresholds instead of density-based, (2) no information density
monitoring, (3) no provenance on memory injections, (4) structural compression
not semantic. Maps to research papers: SimpleMem (30x token reduction with semantic
compression), GenericAgent (information density determines performance), Experience
Compression Spectrum (adaptive levels for different temporal scales).

**Key proposals**:

- Semantic unit classification (code blocks, tool results, reasoning)
- Hybrid compression strategy: semantic for dense context, count-based for sparse
- Per-memory TTL and source tags for provenance
- Density-based triggers instead of hard token limits

**Value for braid**: Research-backed — directly actionable for improving
HIERARCHICAL-MEMORY-COMPRESSION's remaining work items.

---

### 1.4 CONTEXT-TERMINOLOGY.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/CONTEXT-TERMINOLOGY.md`
**Size**: ~3.2KB, 52 lines
**Type**: Terminology reference

**Summary**: Defines the distinction between compaction (automatic system process),
context_archive (manual agent action), finalize (session rotation), and context_prune
(rule-based cleanup). Includes naming rationale and event flow diagram.

**Value for braid**: Low — already established practice. Useful as a reference doc.

---

### 1.5 COUPLING.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/COUPLING.md`
**Size**: ~9.5KB, 105 lines
**Type**: Architecture map

**Summary**: Event flow diagram showing how 35 extensions connect through 13 event types.
Shows listener counts per event (session_start: 11, session_shutdown: 8, agent_end: 7,
etc.) and per-module coupling.

**Key finding**: The `cognitive` module has 28 TS files but no group-level doc.
Same for `core` (9 files), `heartbeat` (2 files), `memory` (16 files).

**Value for braid**: Architectural reference — useful when refactoring extension
event wiring.

---

### 1.6 DEAD-EXTENSION-CLEANUP.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/DEAD-EXTENSION-CLEANUP.md`
**Size**: ~7.9KB, 166 lines
**Type**: Cleanup plan

**Summary**: Three-phase cleanup proposal: Phase 1 (vestigial commands — enforcement-on/off,
loop-status/reset/help, feedback-whitelist commands), Phase 2 (over-tooled extensions —
plan_with_budget, check_budget/set_budget, preprocessor tools), Phase 3 (dead code —
evolve extension cleanup, watchdog review). Some items already done.

**Items still pending**:

- `plan_with_budget`, `check_budget`, `set_budget` tools — verbose, rarely used
- `preprocessor_config`, `preprocessor_stats` — exposes internals
- `enforcement-on/off/stats` commands — debugging artifacts

**Value for braid**: Actionable cleanup — Phase 1 items are zero-risk removals.

---

### 1.7 FEATURE-AUDIT.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/FEATURE-AUDIT.md`
**Size**: ~8.8KB, 132 lines
**Type**: Feature value assessment

**Summary**: Honest categorization of all 53 tools and 31 commands across 13 modules.
Scores tools as HELPFUL (think, hypothesize, finalize, memory, context tools, codebase_tree),
MIXED (plan_with_budget, activate_behavior, heartbeat_status, feedback commands),
or FRUSTRATING (all of `prompt` module — unobservable; enforcement commands — debugging
artifacts; loop commands — same).

**Key insight**: The `prompt` module (prompt-builder + prompt-guardian) is unobservable
infrastructure — if it corrupts the system prompt, the agent acts strangely with no
way to debug why.

**Value for braid**: Strategic — guides which tools to invest in vs deprecate.

---

### 1.8 NUDGE-FATIGUE.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/NUDGE-FATIGUE.md`
**Size**: ~3.6KB, 86 lines
**Type**: Bug analysis + fix

**Summary**: Root cause analysis of 50+ identical rotation nudges across 50+ turns.
Agent ritualistically obeyed (memory_store → context_tag → finalize) but rotation
never happened because "Task incomplete". Three-layer fix: deduplication gate
(per-turn), action cooldown (50 turns OR 5 min after rotation action), identity-framed
language ("You are managing a long session" instead of "The session is getting large").

**Key research grounding**: Implicit framing (compliance directives → letter-satisfying),
Repetition Blindness (Crick & Koch, 2003), Nudge Saturation (Thaler & Sunstein, 2008).

**Value for braid**: Already implemented in nudge dedup — useful as design reference.

---

### 1.9 NUDGE-QUALITY-RESEARCH.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/NUDGE-QUALITY-RESEARCH.md`
**Size**: ~28.3KB, 488 lines
**Type**: Deep research

**Summary**: The deepest research doc in the archive. Analyzes how enforcement,
think FRESH_EYES, and latent-activator produce slop themselves. Root causes:
(1) Enforcement uses directive framing — opposite of what research says works,
(2) Think utility model has no tool state context, (3) No self-audit loop,
(4) Judge lacks compliance-theater awareness, (5) Nudges reference agent speech,
not actual code state.

**Key findings**:

- `"You are an enforcement judge"` IS compliance theater framing
- Judge 6-dimension schema has NO compliance behavior detection dimension
- `"## JUDGE VERDICT: FAIL"` labels reinforce compliance thinking
- Severity labels (high/medium/low) trigger compliance checking
- No positive reinforcement — "pass" verdicts get no message

**Proposed fix**: Rephrase judge prompt from directive ("You are an enforcement judge")
to identity ("You are a sharp, critical thinker"). Add compliance-theater awareness
dimension. Replace severity labels with contextual descriptions.

**Value for braid**: Critical — the enforcement system needs a nudge quality audit.
Recommend implementing the proposed fixes.

---

### 1.10 OVERFLOW-INVESTIGATION.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/OVERFLOW-INVESTIGATION.md`
**Size**: ~4.3KB, 122 lines
**Type**: Root cause analysis

**Summary**: Three-layer overflow system (heartbeat monitor → compaction → rotation)
but fundamentally reactive not proactive. Compaction shrinks window on retry
(20K → 12K → 7K → 4K), creating a death spiral. Fix: proactive token monitoring
at 70%/80%/90% thresholds via heartbeat policy.

**Value for braid**: Already implemented — useful for understanding design rationale.

---

### 1.11 PYTHON-TO-JS-MIGRATION.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/PYTHON-TO-JS-MIGRATION.md`
**Size**: ~7.9KB, 235 lines
**Type**: Migration plan

**Summary**: Migration of evaluation infrastructure from Python to SDK-based JS.
BM1, BR4, BR1 harnesses migrated. Established SDK patterns for model registration,
session creation, prompt execution, and result extraction. Pending: BM2, comprehensive
suite, smoke tests, stability tests.

**Value for braid**: SDK patterns are already in use — the migration patterns doc
is useful reference for future evaluation work.

---

### 1.12 CLEANUP-PLAN.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/CLEANUP-PLAN.md`
**Size**: ~5.5KB, 141 lines
**Type**: Doc cleanup plan

**Summary**: Audit of 101 active docs with recommendations: DELETE 7 (superseded),
MERGE/ARCHIVE 7 (overlapping), ADD 6 extension group docs for cognitive, core,
heartbeat, memory, prompt, tools modules. Extension group docs are still missing.

**Value for braid**: The extension group docs are still undocumented — actionable.

---

### 1.13 DOC-AUDIT.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/DOC-AUDIT.md`
**Size**: ~7.0KB, 161 lines
**Type**: Documentation audit

**Summary**: Audits 43 active docs, 49 archived, 3 proposals, 3 research docs for
redundancy and completeness. Verdict: all archives KEEP, proposal BIDIRECTIONAL-VERIFIER
not started, RepE Prompt Contrast partially done (60%), SAE Steering obsoleted.

**Value for braid**: Documentation completeness reference.

---

### 1.14 OVERNIGHT-RESULTS.md

**Source**: [A] `docs/.archive-old/top-level-cull-2026-04-29/OVERNIGHT-RESULTS.md`
**Size**: ~6.0KB, 129 lines
**Type**: Sprint results

**Summary**: Results from the v0.13.0 overnight sprint: 6 critical bug fixes
(activatePolicyEngine never called, tool tracking local→persistent, 5 trigger bugs),
4 new extensions (verification, topic-drift, planner, analytics), enforcement
refinement (compact JSON output), and 85+ tests passing.

**Value for braid**: Historical sprint record — useful for changelog context.

---

### 1.15 ABLATION_STUDY.md

**Source**: [A] `docs/.archive-old/ABLATION_STUDY.md`
**Size**: ~7.7KB, 277 lines
**Type**: Experimental design

**Summary**: Rigorous 2×2 factorial ablation study design for think() tool improvements.
Tests depth parameter (quick/deep) × utility model (on/off) across 50 tasks
(40% simple, 40% medium, 20% complex). Includes instrumentation, statistical
analysis plan, and sample tasks.

**Key metrics**: Accuracy (>95% target), Token Cost (minimize), Latency (minimize),
Brier Score (<0.1), ECE (<0.1).

**Value for braid**: Experimental framework — can be run against current think()
implementation to validate improvements.

---

### 1.16 WHAT-IS-MISSING.md

**Source**: [A] `docs/WHAT-IS-MISSING.md`
**Size**: ~25.4KB, 457 lines (full file)
**Type**: Master gap analysis

**Summary**: The master status tracker from the pi-braid clone. Covers Phase 0 (D0-D5
archive recovery), Phase 1 (R5-R9 system improvements), Phase 2 (BR1-BR4 behavior
research), Phase 3 (PB1-PB4 prompt-builder), Phase 4 (BM1-BM3 benchmarking), plus
codebase health checks. Most items marked DONE.

**Key open items** (from this doc):

- R5 three-memory: recall before think() not wired
- Compression metadata for retrieval scoring
- Benchmark contamination detection framework

**Value for braid**: Most comprehensive status document — supersedes individual
gap items in other proposals when cross-referenced with current braid state.

---

### 1.17 SKILL-LOADING-RESEARCH.md

**Source**: [A] `docs/SKILL-LOADING-RESEARCH.md`
**Size**: ~4.8KB, 155 lines
**Type**: Research proposal

**Summary**: Proposes dynamic skill loading based on Heartbeat-Driven (2604.14178)
and SkillX (2604.04804) papers. Three tiers: hierarchical organization (strategic/
functional/atomic), heartbeat-scheduled activation (triggered by task phase), and
execution feedback loop (track success rate, deactivate low-effectiveness skills,
extract new skills from completions).

**Key research questions**:

- Can skills be unloaded mid-session? (Check pi API for unloadSkill)
- Can heartbeat trigger skill activation? (Heartbeat already runs in pi-braid)
- Can execution feedback update skill content? (SkillX shows this is possible)
- What's the performance cost of loading all 13 skills? (~1300 lines in prompt)

**Value for braid**: High — directly actionable. Current loading is all-at-start
keyword-matching. Dynamic scheduling would reduce token cost and improve relevance.

---

## Tier 2: Compliance Theater Research (from llm-compliance-theater)

These are deeper research documents from the compliance theater project,
exploring latent space manipulation, benchmark integrity, and emergence.

### 2.1 BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md

**Source**: [C] `agent-architecture/BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md`
**Size**: ~15.9KB, 351 lines
**Type**: Research synthesis

**Summary**: Two-part synthesis finding: (1) Most LLM benchmarks are contaminated —
VAR-MATH shows 48-73% score drop on variabilized instances. Smaller models are
more dependent on memorization. (2) SAE-based latent steering (YaPO) works for
behavioral control — but requires activation access, unavailable on API-only providers.

**Key proposals for braid**:

- Synthetic problem generation for contamination-free evaluation
- Parameterized benchmarks with random seeds at evaluation time
- Multi-instance evaluation (VAR-MATH approach — require consistency across variants)
- Since SAE steering is blocked by API providers, stick with RepE-style prompt contrast

**Value for braid**: High for benchmark design; confirms prompt contrast over SAE.

---

### 2.2 BENCHMARK-SATURATION.md

**Source**: [C] `agent-architecture/BENCHMARK-SATURATION.md`
**Size**: ~6.6KB, 163 lines
**Type**: Empirical analysis

**Summary**: 144/144 runs (4 configs × 2 providers × 6 problems × 3 trials) all pass
at 100%. Zero differentiation between no-bash, baseline-bash, braid-full, and
braid-research configs. Standard benchmark problems are completely saturated.
Solution: VAR-MATH-style variant problems with structural variants of the same skill.

**Key finding**: pi-braid extensions provide zero measurable benefit on standard
tasks — they only differentiate on harder, variant problems.

**Value for braid**: Essential — justifies the VAR-MATH variant generation approach
already partially in proposals.

---

### 2.3 EMERGENCE-VIA-STRUCTURED-REASONING.md

**Source**: [C] `agent-architecture/EMERGENCE-VIA-STRUCTURED-REASONING.md`
**Size**: ~20.0KB, 513 lines
**Type**: Deep research

**Summary**: The meta-question: how can think() push an LLM beyond training data?
Identifies four mechanisms: (1) Constraint-Driven Synthesis — explicit non-negotiable
constraints force novel compositions, (2) Cross-Domain Analogy — forcing transfer
of solution primitives across domains, (3) Recursive Decomposition — breaking novel
problems into known sub-problems, (4) Counterfactual Reasoning — what-if exploration.

**Key architectural insight**: "The training data provides primitives, constraints,
patterns. The harness provides search procedure, memory, selection pressure.
Emergence happens at the intersection of novel constraint sets + systematic search."

**Value for braid**: Theoretical foundation for why think() and the architecture work.
Useful for designing harder benchmark tasks.

---

### 2.4 LATENT-SPACE-AND-NOVEL-CAPABILITY.md

**Source**: [C] `agent-architecture/LATENT-SPACE-AND-NOVEL-CAPABILITY.md`
**Size**: ~27.9KB, 656 lines
**Type**: Deep research

**Summary**: Deep dive on steering question (can we modify LLM behavior via
activations — yes, clearly) vs novel capability question (can we make LLM do
something genuinely new — more nuanced). Covers RepE (LAT + contrast vectors),
BeHonest (3-dimension honesty benchmark), YaPO (sparse SAE steering), UniR
(Universal Reasoner plug-and-play module).

**Key proposal**: UniR is the most practically relevant for pi-braid — train
reasoning modules for tool composition, fault localization, multi-turn coherence,
and anti-sycophancy. Add logits to ANY frozen LLM without fine-tuning.

**Value for braid**: Research reference — UniR path is high-value but requires
training infrastructure.

---

### 2.5 LATENT-SPACE-EMERGENT-NOVEL-CAPABILITY.md

**Source**: [C] `agent-architecture/LATENT-SPACE-EMERGENT-NOVEL-CAPABILITY.md`
**Size**: ~14.3KB, 400 lines
**Type**: Research synthesis

**Summary**: Earlier version of the latent space synthesis. More focus on specific
papers (Moral Foundations, Persona Control, FGAA) and less on UniR.

**Value for braid**: Supplementary to LATENT-SPACE-AND-NOVEL-CAPABILITY.md.

---

### 2.6 OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md

**Source**: [C] `agent-architecture/OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md`
**Size**: ~7.5KB, 199 lines
**Type**: Architecture comparison proposal

**Summary**: Compares OpenMythos's looped transformer architecture (persistent loop
state, self-referential updates, experience compression into latent representations)
vs pi-braid's external persistence (belief store, heartbeat, three-memory).
Proposes experiments: "cross-turn carry" tasks, workspace belief accumulation,
compression-resume cycle.

**Key question**: Is there a qualitative difference between external persistence
and internal (loop-based) persistence?

**Value for braid**: Research — informs whether pi-braid should pursue loop-like
internal state or stay with external scaffolding.

---

### 2.7 prompt-gap-analysis.md

**Source**: [C] `agent-architecture/prompt-gap-analysis.md`
**Size**: ~10.3KB, 257 lines
**Type**: Gap analysis

**Summary**: Audits current prompt-builder output against research findings.
Identifies 4 gaps: (1) Sycophancy resistance — no prompt-level defense against
social-pressure override (paper 2604.19117), (2) Stakes signaling in enforcement
whispers — judge prompts use consequence framing that corrupts reasoning
(2604.15224, ΔV = -9.8pp), (3) Epistemic control loop — no instruction for
self-monitoring of reasoning stability (2604.14881), (4) Behavioral drift
self-awareness — no detection when agent behavior changes over time.

**Value for braid**: High — directly actionable for prompt-builder improvement.
Gaps 1 and 2 are concrete fixes.

---

### 2.8 REPE-DEEP-SYNTHESIS.md

**Source**: [C] `agent-architecture/REPE-DEEP-SYNTHESIS.md`
**Size**: ~20.7KB, 590 lines
**Type**: Deep synthesis

**Summary**: Complete RepE framework deep dive: LAT reading method (3 steps:
design stimulus → collect activations → PCA), three control methods (reading vector,
contrast vector, LoRRA). Key finding: Honesty is LINEAR in residual stream —
+18.1pp TruthfulQA with contrast vectors. LAT probe detects lies even when model
outputs false info.

**Value for braid**: Research reference — explains why prompt contrast works.

---

### 2.9 TOOL-AUGMENTED-REASONING-EXTENDED.md

**Source**: [C] `agent-architecture/TOOL-AUGMENTED-REASONING-EXTENDED.md`
**Size**: ~19.3KB, 514 lines
**Type**: Deep research

**Summary**: Extended analysis of UniR (Universal Reasoner) — the most practically
relevant paper for pi-braid capability enhancement. UniR trains a reasoning module
R(x) that outputs logits, added to ANY frozen LLM: P_final = softmax(L + β·R(x)).
Key properties: plug-and-play, composable (math + code = combined), weak-to-strong
generalization, no base model fine-tuning.

**pi-braid application**: Train UniR modules for tool composition (did the tool call
solve the sub-problem?), fault localization (did editing this file fix the bug?),
multi-turn coherence (is current plan consistent?), anti-sycophancy (truth over
agreeableness).

**Also covers**: Knowledge editing (ROME, MEMIT, WILTE), Retrieval-Augmented
Generation limitations, Agent-V RL for tool-use agents.

**Value for braid**: High — UniR is the most promising research avenue for
capability enhancement. But requires training infrastructure (GPU compute).

---

### 2.10 ToolCoverageProposal.md

**Source**: [C] `agent-architecture/ToolCoverageProposal.md`
**Size**: ~9.1KB, 268 lines
**Type**: Tool replacement proposal

**Summary**: Proposes replacing `bash` with 25 safe, specific tools across 5
categories: file operations (delete, move, copy, mkdir, permissions), code execution
(repl, run, test), search & discovery (tree, locate), code analysis (analyze_imports,
analyze_complexity, diff, git_log, git_blame), system info (pwd, echo, env, date,
system_info).

**Why remove bash**: Security (arbitrary code execution), compliance theater
(echo '...' > file when edit fails), observability (opaque), consistency
(shell-specific quirks).

**Value for braid**: Reference design — not immediately actionable (bash removal
is a major breaking change), but the specific tool designs (delete with confirm,
run with explicit interpreter, test with auto-detection) are good patterns.

---

### 2.11 NEW_PAPERS_20260419.md

**Source**: [C] `agent-architecture/NEW_PAPERS_20260419.md`
**Size**: ~10.4KB, 296 lines
**Type**: Paper survey

**Summary**: Survey of 30+ arXiv papers from April 2026. Key papers for pi-braid:
BeHonest (2406.13261 — 3-dimension honesty metric), LNE-Blocking (2509.15218 —
disruption for contamination detection), Teach2Eval (2505.12259 — teaching as
evaluation), HWE-Bench (2604.14709 — 3 failure modes for RL agents),
AgentPulse (2604.24021 — multi-signal agent evaluation).

**Value for braid**: Literature reference — many papers now incorporated into
existing proposals.

---

### 2.12 NEW_PAPERS_20260423.md

**Source**: [C] `agent-architecture/NEW_PAPERS_20260423.md`
**Size**: ~12.7KB, 284 lines
**Type**: Paper survey

**Summary**: Follow-up survey: SimpleMem (2601.02553 — 30x semantic compression),
GenericAgent (2604.17091 — information density > context length), Experience
Compression Spectrum (2604.15877 — adaptive levels), Layered Mutability
(2604.14717 — session isolation), Credo (2604.14401 — belief systems), AgentOS
(2602.20934 — three-layer memory).

**Value for braid**: These papers directly informed context management and memory
improvements.

---

## Tier 3: Implicit Framing Research (from implicit-framing docs)

### 3.1 AGENT-CODEBASE-MAINTENANCE.md

**Source**: [D] `research/agent-architecture/AGENT-CODEBASE-MAINTENANCE.md`
**Size**: ~7.5KB, 173 lines
**Type**: Maintenance strategy

**Summary**: Strategies for maintaining large codebases as an agent. Covers
dependency graph analysis, dead code detection, testing patterns, and incremental
refactoring approaches. Recommends codebase_graph tool for finding orphans,
dead-ends, cycles, and high-fan-in hubs.

**Value for braid**: Procedural — useful as a skill reference for maintenance tasks.

---

### 3.2 HUGE-CODEBASE-MAINTENANCE.md

**Source**: [D] `research/agent-architecture/HUGE-CODEBASE-MAINTENANCE.md`
**Size**: ~13.3KB, 298 lines
**Type**: Maintenance strategy

**Summary**: Extended version of codebase maintenance for very large (>100K file)
codebases. Covers scope narrowing, selective reading, impact analysis, and
change management. Less relevant to pi-braid's ~100 file codebase.

**Value for braid**: Low — pi-braid is not a huge codebase.

---

## Summary: Actionable Items for Braid

### 🔴 High Priority (directly actionable)

| Item                                   | Source                        | What to Do                                                                                               |
| -------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Nudge quality audit**                | [A] NUDGE-QUALITY-RESEARCH.md | Rephrase judge prompt from directive to identity framing; add compliance dimension to 6-dimension schema |
| **Skill loading dynamic scheduling**   | [A] SKILL-LOADING-RESEARCH.md | Audit token cost of all skills; design heartbeat-triggered activation                                    |
| **Sycophancy resistance gap**          | [C] prompt-gap-analysis.md    | Add prompt-level sycophancy defense to prompt-builder                                                    |
| **Epistemic control loop gap**         | [C] prompt-gap-analysis.md    | Add self-monitoring of reasoning stability to prompt-builder                                             |
| **BR1 trap tasks as regression suite** | [A] BR1-TRAP-TASKS.md         | Validate self-evolution implementation against 6 trap types                                              |
| **Vestigial command cleanup**          | [A] DEAD-EXTENSION-CLEANUP.md | Remove enforcement-on/off/stats, loop-status/reset/help, feedback-whitelist commands                     |

### 🟡 Medium Priority

| Item                                          | Source                           | What to Do                                                                          |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| **Extension group docs**                      | [A] COUPLING.md, CLEANUP-PLAN.md | Add group-level docs for cognitive (28 files), core (9), heartbeat (2), memory (16) |
| **Over-tooled extension pruning**             | [A] DEAD-EXTENSION-CLEANUP.md    | Consider removing plan_with_budget, check_budget, set_budget, preprocessor tools    |
| **Context management density-based triggers** | [A] CONTEXT-MANAGEMENT.md        | Add information density monitoring instead of hard token limits                     |
| **Feature audit recommendations**             | [A] FEATURE-AUDIT.md             | Document which tools to invest in vs deprecate in ROADMAP                           |

### 🔵 Research Reference

| Item                               | Source                                             | Relevance                                            |
| ---------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| UniR tool-composition modules      | [C] TOOL-AUGMENTED-REASONING-EXTENDED.md           | Requires GPU training — long-term                    |
| Benchmark contamination framework  | [C] BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md | Design parameterized benchmarks with random seeds    |
| OpenMythos loop comparison         | [C] OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md           | Architecture research — cross-turn carry tasks       |
| Benchmark saturation               | [C] BENCHMARK-SATURATION.md                        | 100% saturation confirms need for variant generation |
| Emergence via structured reasoning | [C] EMERGENCE-VIA-STRUCTURED-REASONING.md          | Theoretical foundation for think()                   |
| Ablation study framework           | [A] ABLATION_STUDY.md                              | Run against current think() implementation           |
| Nudge fatigue design reference     | [A] NUDGE-FATIGUE.md                               | Dedup patterns for future nudge systems              |

---

## File Inventory: What Was Found Where

```
braid/docs/ (current)                                   21 proposals + 46 docs
└── proposals/                                          16 proposals
                                                        5 implemented, 1 abandoned,
                                                        2 not started, 7 partial

implicit-framing/pi-braid/docs/ (clone snapshot)        19 files + archive
├── WHAT-IS-MISSING.md                                  Master gap analysis
├── SKILL-LOADING-RESEARCH.md                           Dynamic skill research
└── .archive-old/
    ├── (root)                                          7 historical docs
    │   ├── ABLATION_STUDY.md                           Think() ablation design
    │   └── (6 more v0.5-v0.9 era docs)
    └── top-level-cull-2026-04-29/                      16 docs (audit/research)
        ├── BRAID-NEXT-PROPOSAL.md                      Dev roadmap
        ├── BR1-TRAP-TASKS.md                           Regression test suite
        ├── CONTEXT-MANAGEMENT.md                       Context improvement research
        ├── NUDGE-QUALITY-RESEARCH.md                   Deep nudge audit (28KB)
        ├── DEAD-EXTENSION-CLEANUP.md                   Cleanup plan
        ├── FEATURE-AUDIT.md                            Tool value audit
        ├── COUPLING.md                                 Extension coupling map
        └── (9 more docs)

llm-compliance-theater/braid-research/                  30 research docs
├── agent-architecture/                                 28 docs
│   ├── BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md  Contamination + steering
│   ├── BENCHMARK-SATURATION.md                         100% saturation finding
│   ├── EMERGENCE-VIA-STRUCTURED-REASONING.md           Why think() works
│   ├── LATENT-SPACE-AND-NOVEL-CAPABILITY.md           28KB deep dive
│   ├── OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md            Loop comparison
│   ├── prompt-gap-analysis.md                          Prompt-builder gaps
│   ├── REPE-DEEP-SYNTHESIS.md                          RepE full framework
│   ├── TOOL-AUGMENTED-REASONING-EXTENDED.md            UniR + knowledge editing
│   ├── ToolCoverageProposal.md                         Bash replacement design
│   ├── NEW_PAPERS_20260419.md / 23.md                  Paper surveys
│   └── (16 more overlap with braid proposals)
└── self-evolution/                                     2 docs (overlap)

implicit-framing/docs/research/                         18 docs
├── agent-architecture/                                 17 docs
│   ├── AGENT-CODEBASE-MAINTENANCE.md                   Maintenance strategy
│   ├── HUGE-CODEBASE-MAINTENANCE.md                    Large codebase strategy
│   └── (15 docs overlapping with compliance-theater)
├── pi-braid-proposals/                                 14 proposals (overlap)
└── (other research threads)
```

---

**Unique proposals now copied into `braid/docs/proposals/`:**

| File                                           | Source      | New Path              |
| ---------------------------------------------- | ----------- | --------------------- |
| NUDGE-QUALITY-RESEARCH.md                      | [A] archive | `proposals/external/` |
| BR1-TRAP-TASKS.md                              | [A] archive | `proposals/external/` |
| CONTEXT-MANAGEMENT.md                          | [A] archive | `proposals/external/` |
| SKILL-LOADING-RESEARCH.md                      | [A] root    | `proposals/external/` |
| BENCHMARK-CONTAMINATION-AND-LATENT-STEERING.md | [C]         | `proposals/external/` |
| BENCHMARK-SATURATION.md                        | [C]         | `proposals/external/` |
| EMERGENCE-VIA-STRUCTURED-REASONING.md          | [C]         | `proposals/external/` |
| LATENT-SPACE-AND-NOVEL-CAPABILITY.md           | [C]         | `proposals/external/` |
| prompt-gap-analysis.md                         | [C]         | `proposals/external/` |
| TOOL-AUGMENTED-REASONING-EXTENDED.md           | [C]         | `proposals/external/` |
| ToolCoverageProposal.md                        | [C]         | `proposals/external/` |
| OPENMYTHOS-LOOP-ANALYSIS-PROPOSAL.md           | [C]         | `proposals/external/` |
| REPE-DEEP-SYNTHESIS.md                         | [C]         | `proposals/external/` |
| ABLATION_STUDY.md                              | [A] archive | `proposals/external/` |
| WHAT-IS-MISSING.md                             | [A] root    | `proposals/external/` |
| COUPLING.md                                    | [A] archive | `proposals/external/` |
| FEATURE-AUDIT.md                               | [A] archive | `proposals/external/` |
| DEAD-EXTENSION-CLEANUP.md                      | [A] archive | `proposals/external/` |
| NUDGE-FATIGUE.md                               | [A] archive | `proposals/external/` |
| OVERFLOW-INVESTIGATION.md                      | [A] archive | `proposals/external/` |
| CONTEXT-TERMINOLOGY.md                         | [A] archive | `proposals/external/` |
| PYTHON-TO-JS-MIGRATION.md                      | [A] archive | `proposals/external/` |
| CLEANUP-PLAN.md                                | [A] archive | `proposals/external/` |
| DOC-AUDIT.md                                   | [A] archive | `proposals/external/` |
| OVERNIGHT-RESULTS.md                           | [A] archive | `proposals/external/` |
| BRAID-NEXT-PROPOSAL.md                         | [A] archive | `proposals/external/` |

---

_Generated by Braid — 2026-05-08_
