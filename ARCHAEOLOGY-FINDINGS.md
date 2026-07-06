# Braid Archaeology: Complete Findings

<!-- status: current -->
<!-- Generated: 2026-07-06 -->
<!-- Sources: pi-braid, pi-mono, pi-braid-contrib, implicit-framing, llm-compliance-theater -->

## 1. Prompt Evolution Timeline

### Phase 0: Pre-Braid (pi-mono, March–April 2026)

#### Earliest Sessions (March 3-8, 2026)
- **Mar 3-5**: First coding-agent sessions. System prompt was the pi-native default: `"You are an expert coding assistant operating inside pi, a coding agent harness."` with tool descriptions + guidelines.
- **Mar 8**: Session `b4707e09` (pi-mono) — first structured error logging, subagent task implementation. No Braid identity yet.
- **Mar 22**: Commit `cb9f067b2` — "feat(coding-agent): add cognitive systems for autonomous operation". First cognitive systems appear.
- **Mar 22-24**: Multiple sessions exploring system prompt extraction to plugins/skills. The key insight: *"system prompt and context management could be extracted to builtin skill — so we stay minimal but even more modular"*
- **Mar 24**: Commit `f522f3cac` — "feat(prompt-builder): bring back skills and tools additions in persona". Prompt-builder enhanced with skills/tools in persona.
- **Mar 27**: Session `3ad784c0` — enforcement systems, lazy behavior detection, and anti-laziness enforcement.

#### The Implicit Framing Breakthrough (April 3-7)

The original prompt was built in `pi-mono/packages/coding-agent/src/core/system-prompt.ts`:

- **Mar 22** — `cb9f067b2`: First cognitive systems for autonomous operation
- **Apr 3** — `a9f10f032`: First prompt-builder extension (bundled, simple humanizer guidelines)
- **Apr 7** — `c73560d76`: **"Implicit Framing Engineering"** — the research breakthrough. Added:
  - `addGuideline("You write tight. No fluff. File paths named, right there.")`
  - `addGuideline("You plan on paper first. Steps before code. Always.")`
  - `addGuideline("You understand completely before touching.")`
  - `addGuideline("You coordinate. You branch for safety.")`
- **Apr 7** — `a7c97ef07`: Refactored system_prompt, removed AGENTS.md file pi-native integration

### Phase 1: Early Braid Identity (pi-braid, April 15–May 5)

The prompt-builder was extracted from pi-mono into its own `pi-braid` extension on April 15.

**Commit 777c33d — First Braid identity:**
```
You are stateful and meticulous expert software architect.
You think silently, then write clean code.
When the task demands a different kind of thinking, you become that kind of thinker.
You solve problems by understanding them completely before acting.
You operate inside pi, a resourceful harness with a full toolkit.
You read thoroughly, execute safely, edit precisely, write clean code.
You plan ahead and verify everything.
```

**Commit 56d1de54 — Same day:**
```
You are stateful and meticulous expert software architect.
Think silently, then find the correct trajectory.
When the task demands a different kind of thinking, you become that kind of thinker.
You solve problems by understanding them completely before acting.
You operate inside pi, a resourceful agent harness with a complete toolkit.
You read thoroughly, execute safely, edit precisely.
You plan ahead, self-verify and provide honest proofs.
```
Key changes: `"write clean code"` → `"find the correct trajectory"`, added `"self-verify and provide honest proofs"`

**Commit 29a3ce34 — Modular reconstruction:**
```
From now you are Braid, stateful and meticulous expert software architect operating inside Pi, a coding agent harness.
```
Note: "think silently" was **absent** from IDENTITY_INTRO (only in newPrompt construction)

**Commit 916f080e — "think silently" enters IDENTITY_INTRO:**
```
You are stateful and meticulous expert software architect.
Think silently. Find the correct trajectory. Not the first plausible path.
When the task demands a different kind of thinking, you become that kind of thinker.
You solve problems by understanding them completely before acting.
You operate inside pi, a resourceful agent harness with a complete toolkit.
You read thoroughly, execute safely, edit precisely.
You plan ahead, self-verify and provide honest proofs.
```

**Commit 639f879e — Tools metaphor introduced:**
```
You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think silently before taking actions.
```

**Commit 3049c141 — "Revive silent-thinking theory" (user action):**
```
You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think hard silently before any visible reasoning.
```
Changed: `"before taking actions"` → `"before any visible reasoning"`, added `"hard"`

### Phase 2: Modular + Value Statements (May–June)

- May 2026: PromptSection primitive introduced (Phase 0 POC)
- Files split into identity.ts, skills-section.ts, project-docs-section.ts, etc.
- 8 value statements added (behavioral-guardrails.ts): BROAD_PERSPECTIVE, REASONING_INTEGRITY, etc.
- Contrast phrase library added (4 phrases: TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC-STABILITY, KNOWLEDGE-BOUNDARY)
- 6 contrast phrases + 4 behavior modes (contrast-phrase-library.ts)
- Session/Context block split (v3.6), then Instance merge (v3.7)
- Top-level extension discovery via settings.json (v3.8)
- Skills + project-docs + memory pointer blocks (v3.9)

### Phase 3: Lean & Dynamic (June 29–July 6)

**Major refactor commits (in order):**

| Date | Commit | Change |
|------|--------|--------|
| Jun 29 | `3b4f108a` | **Deleted 8 value statements** (behavioral-guardrails.ts) + **deleted contrast phrase library** (contrast-phrase-library.ts). Added CONCISE_RESPONSES. |
| Jun 29 | `709950c9` | **Restored dynamic behavior modes** (TRUTH-SEEKING + CORRECTION + EPISTEMIC-CALIBRATION + TOOL-RELIABILITY). These survived the purge. |
| Jun 29 | `51f8787e` | Definition of Done invariant (SPQ-1) |
| Jun 29 | `322d2c43` | SCOPES identity + INTERACTION_STYLE markup + CORRECTION lean directive |
| Jul 2 | `a7e0eb2a` | FRAMEWORK_CONFIG_FIRST invariant (from reveal.js debacle) |
| Jul 2 | `67f768e4` | Context heading unification (project-docs + memory + runtime under one `## Context`) |
| Jul 4 | `77bb0cb4` | RESOURCE_DISCOVERY invariant + generalized IDENTITY_INTRO |
| Jul 5 | `5960bfa9` | Polish: tightened discoverability directives, context-hygiene signal |
| Jul 6 | current | 8 identity invariants + 1 interaction style + 1 concise responses + 4 behavior modes |

### Current Identity (v0.3.0, July 6)

**IDENTITY_INTRO:**
```
You are Braid, a generalist operating inside the pi coding agent harness.
You work across software, research, planning, writing, and decision-making.
Your tools act; your skills hold executable procedures for specialized work (not optional hints).
Before starting any task, read the skills that cover your current domain.
Skills prevent wasted effort and mistakes.
Then scan project docs, memory, and runtime extensions;
read any resource whose scope overlaps with your work before acting.
```

**8 Invariants:**
1. CONCISE_RESPONSES — concise text alongside tool calls
2. COMPACTION_SURVIVAL — self-contained scratchpad/tasks
3. DEFINITION_OF_DONE — verification triple before finalize
4. LIVING_DOCS — AGENTS.md hierarchy maintenance
5. MEMORY_AWARENESS — recall before work, store after
6. SCOPES — narrowest scope first
7. FRAMEWORK_CONFIG_FIRST — check public API before internals
8. RESOURCE_DISCOVERY — pointers over content, sources over summaries

**INTERACTION_STYLE:**
```
You focus on correctness over verbosity.
State the conclusion first; reasoning comes after, only if it's load-bearing.
When the user is direct, be direct back.
```

**4 Behavior Modes:** TRUTH-SEEKING (default), CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY

---

## 2. Features That Were Implemented Then Deleted

### ❌ Deleted: 8 Value Statements (behavioral-guardrails.ts)
- BROAD_PERSPECTIVE, REASONING_INTEGRITY, TRUTHFULNESS, CAREFULNESS, SELF_VERIFICATION, COMMUNICATION_QUALITY, etc.
- **Deleted**: June 29, `3b4f108a`
- **Reason**: "Bloat — verifier tools (verify, verify_claim, finalize) carry that rigor"

### ❌ Deleted: Contrast Phrase Library (4 phrases)
- TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC-STABILITY, KNOWLEDGE-BOUNDARY
- **Deleted**: June 29, `3b4f108a` (same commit as value statements)
- **Reason**: Collateral damage — meant to be preserved but was in the same file

### ❌ Deleted: "Tools as keys" Metaphor
- `"Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys"`
- **Deleted**: June 23, smart-mix identity refactor (`c4110870`)
- **Replaced with**: `"Your tools act; your skills hold executable procedures for specialized work (not optional hints)"`

### ❌ Deleted: "Think silently" Variants
- `"Think silently, then write clean code"` → `"Think silently, then find the correct trajectory"` → `"Think silently before taking actions"` → `"Think hard silently before any visible reasoning"`
- **Deleted**: June 23, smart-mix identity refactor
- **Replaced with**: Nothing — the concept was absorbed into the TRUTH-SEEKING mode

### ❌ Deleted: "From now you are Braid..." Temporal Framing
- The `"From now you are..."` phrasing was removed in the May 5 refactor
- **Replaced with**: `"You are Braid..."`

### ❌ Deleted: "stateful and meticulous expert" Trait Density
- All the trait adjectives were stripped in the smart-mix identity
- **Replaced with**: `"a generalist"` — single word, no flattery

---

## 3. Research Proposals — Never Implemented

### P0 Proposals (Highest Priority)

| Proposal | Research Basis | Priority | Status |
|----------|---------------|----------|--------|
| **Self-Evolution Loop** | MARS (2601.11974), ACE (2510.04618), SkillX (2604.04804), Autogenesis (2604.15034) | P0 | ❌ Never implemented. Evolve extension exists but lacks version tracking, rollback, and auditable lineage. SEPL protocol from Autogenesis paper is the blueprint. |
| **RepE Prompt Contrast** | RepE (2310.01405), BeHonest (2406.13261) | P0 | ⚠️ Partially implemented as contrast phrases, then deleted as collateral damage Jun 29. Research says API-only providers block activation injection, but text-space approximation works. |
| **Contrast Phrase Library** | Same as above | P0 | ⚠️ Implemented (4 phrases: TRUTH-FIRST, ANTI-SYCOPHANCY, EPISTEMIC-STABILITY, KNOWLEDGE-BOUNDARY), then deleted in Jun 29 purge. Was in same file as value statements — collateral damage. |

### P1 Proposals

| Proposal | Research Basis | Priority | Status |
|----------|---------------|----------|--------|
| **Bidirectional Verifier** | AgentV-RL (2604.16004) | P1 | ❌ Never implemented. 4 phases: forward trace, artifact validator, backward checker, coordination checker. Wires into belief store + heartbeat + three-memory. |
| **Benchmark Improvements** | VAR-MATH (2507.12885), AntiLeakBench (2412.13670), ACBench (2505.19433), HWE-Bench (2604.14709) | P1 | ❌ Never implemented. Contamination-resistant evaluation with variabilized problems. 48-73% drop on variants reveals memorization vs reasoning. 161 result JSONs exist in implicit-framing/evaluation/runs/. |
| **Heartbeat as Event Bus** | Timer architecture + event-driven design | P1 | ❌ Never implemented. Unified event model for timer_fire, memory_evict, heuristic_fire, turn_complete, context_full, belief_conflict. Event bus + typed handler registration. |

### P2 Proposals

| Proposal | Research Basis | Priority | Status |
|----------|---------------|----------|--------|
| **Hierarchical Memory Compression** | GenericAgent (2604.17091), SimpleMem (2601.02553), Experience Compression Spectrum (2604.15877), Prometheus (2507.19942) | P2 | ❌ Never implemented. Three-tier (working→episodic→procedural) with adaptive compression levels. 30x token reduction claimed by SimpleMem. |
| **Agent Timer (Pomodoro)** | Pomodoro technique + heartbeat scheduler | P2 | ✅ **Implemented** as `timer` tool. Non-blocking reminder system with timer_set/timer_list/timer_cancel. |

### P3 Proposals

| Proposal | Research Basis | Priority | Status |
|----------|---------------|----------|--------|
| **SAE Steering** | YaPO (2601.08441), FGAA (2501.09929), Moral Foundations SAE (2601.05437), BeHonest (2406.13261) | P3 | ❌ Blocked by API providers. Neither stepfun nor minimax exposes hidden states. Only text-space approximation possible. |
| **Structured Output Catalyst** | MDA (2601.21996), IRCoT (2212.10509), CRL (2602.10437) | P3 | ❌ Never implemented. Induction head stimulation via repetitive structural data formats. Could be a 1-2 day implementation. |
| **Memory Leak Prevention** | HaluMem (2511.03506) | P3 | ❌ Never implemented. Cross-project contamination prevention via provenance tracking, session isolation, and implicit/explicit boundary. |
| **VAR-MATH Variants** | VAR-MATH (2507.12885) | P3 | ❌ Never implemented. 6 problem types with 5 variants each (flatten_deep, merge_sorted, reverse_words, group_anagrams, binary_search, is_balanced). |

### Additional Research: UniR Universal Reasoner
- **Paper**: UniR (2505.19075) — Universal Reasoner trained as logit-addition module
- **Key property**: Plug-and-play, composable, weak-to-strong generalization
- **For pi-braid**: Training a pi-braid-specific reasoning module that adds logits to any frozen LLM
- **Status**: ❌ Never implemented. Would require training infrastructure.

### Additional Research: Tool-Augmented Reasoning
- **Papers**: Multiple knowledge editing + tool-augmented agent papers
- **Key insight**: Tools as external knowledge sources that bypass LLM training data limitations
- **Status**: ⚠️ Partially implemented — pi-braid has tool infrastructure but no systematic tool-augmented reasoning pipelinpi-braid has tool infrastructure but no systematic tool-augmented reasoning pipeline"

---

## 4. Research Findings — Compliance Theater & Implicit Framing

### Paper: arXiv-ready, 11 pages, LaTeX
**Title**: "Compliance Theater: Identity Filters Shield LLM Agents from Directive Overload"
**Author**: Aleksei Mironov
**Location**: `~/projects/vibe/llm-compliance-theater/paper/main.pdf`

### Core Finding: The 2×2 Interaction Effect

| Condition | Solve Rate | Avg Tokens | Compliance Behaviors | Limit Hits |
|-----------|-----------|-----------|---------------------|-----------|
| implicit×identity | **88%** | ~500 | 0% | 0% |
| implicit×behavior | 88% | ~617 | 33% | 0% |
| explicit×identity | 75% | ~816 | 75% | 8% |
| explicit×behavior | **62%** | ~1,422 | 75% | 25% |

**Key insight**: Identity framing acts as a **behavioral filter** — it channels explicit directives toward task-relevant actions. Behavioral framing has no filter, so every "MUST" produces its target behavior regardless of task relevance.

### Four Studies

**Study 1: 4-Condition Observational** (96 runs, Step 3.5 Flash)
| Condition | Solve Rate | Avg Tokens | Limit Hits |
|-----------|-----------|------------|-----------|
| architect | **79%** | 1,198 | 8% |
| careful | 67% | 2,169 | 25% |
| meticulous | 71% | 1,671 | 21% |
| explicit (8× MUST) | **54%** | 3,122 | 38% |

**Study 2: 2×2 Factorial** (96 runs, Step 3.5 Flash)
The critical interaction effect: explicit×identity = 79% solve rate, explicit×behavior = 62%.

**Study 3: Multi-Model Validation** (5 LLMs)
| Model | Identity Avg | Explicit |
|-------|-------------|----------|
| Step 3.5 Flash | 72% | **54%** |
| Qwen 3.5 Flash | 88% | 83% |
| GLM 4.7 Flash | 88% | 88% |
| MiniMax M2.7 | 88% | 83% |
| Kimi K2.5 | 88% | **62%** |

**Study 4: Scope Extension**
Shows the identity filter effect extends beyond coding to general reasoning tasks.

### Cross-Model Pattern
- **Explicit framing universally produces 100% compliance behaviors** across all 5 models
- **Identity framing produces 0–38% compliance** (varies by model's behavioral priors)
- **Token budget is the binding constraint**: Zero runs that hit the 6,000-token limit successfully completed the task
- Budget-constrained models (Step, Kimi): Explicit causes **task failure**
- Capable models (Qwen, GLM): Explicit causes **2–3× token waste** while achieving same solve rate

### External Validation (Paper 2604.27891)
- Dennis et al. (2026) independently confirms thesis using different methodology
- LangGraph orchestration vs in-context procedure: **15/15 comparisons favor in-context** (p<0.005, d=0.37-1.01)
- Failure rates: Orchestrated 9-24% vs In-context 0.5-11.5% (18× worse for Zoom!)
- **Root cause**: "Orchestration fragments reasoning" = our "compliance behaviors fragment implementation"

### Ablation Study: Identity Words
12 identity variants tested — "meticulous" achieved best token efficiency (90% success, 136 tokens)
| Identity | Success | Tokens | Efficiency |
|----------|---------|--------|-----------|
| meticulous | 90% | 136 | 6.59 |
| expert | 90% | 143 | 6.28 |
| careful | 90% | 153 | 5.87 |
| experienced | 80% | 192 | 4.16 |
| senior | 70% | 281 | 2.49 |
| skilled | 70% | 298 | 2.35 |

**Key insight**: Active behavioral traits (meticulous, expert, careful) outperform experience-level traits (experienced, senior, skilled).

### Compliance Behaviors Catalog
- Adding docstrings to every function (even trivial ones)
- Adding type hints where the problem doesn't need them
- Adding input validation to simple functions
- Adding error handling to toy examples
- Adding comments explaining obvious code
- Writing tests before understanding the problem

### The Mechanism
```
Identity Filter: "You are a software architect."
  → Agent selects behaviors relevant to "architect" role
  → Only produces compliance behaviors when task demands them

No Filter: "You MUST write tests. You MUST handle errors."
  → Every directive is a checklist item
  → Produces ALL behaviors regardless of task relevance
  → Token budget exhausted before implementation complete
```

### Practical Implication
If you must use explicit directives, frame them through an identity. The identity filter prevents compliance theater while preserving the directive's intent.

---

## 5. Archived Proposals That Were Shipped

| Archived Doc | What Happened | Commit |
|-------------|---------------|--------|
| `CONTEXT-MANAGEMENT-IMPROVEMENTS.md` | All features shipped (compress, archive, navigate) | Multiple |
| `P2-10-LARGE-FILE-DECOMPOSITION.md` | All 4 file splits shipped (timer, memory-agent-bridge, session-recall, latent-activator) | Multiple |
| `CODE-QUALITY-REMEDIATION-PLAN.md` | Complete record, all shipped | Various |
| `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` | Proposals tracked in ROADMAP | N/A |
| `HOOKS-AND-WHISPERS-AUDIT.md` | Completed event mapping | N/A |
| `ARXIV-CITATIONS-AUDIT.md` | All verified, test enforces | N/A |
| `DOCUMENTATION-REVIEW-PROPOSAL.md` | Superseded by work | N/A |
| `RESEARCH-INTEGRATION-TESTING-GAP.md` | Research, no implementation plan | N/A |
| `SELF-EVOLUTION-PROPOSAL.md` | Research proposals, no workstream | N/A |

---

## 6. Active Research Threads (from implicit-framing)

| Thread | Docs | Status |
|--------|------|--------|
| **implicit-framing** | 7 docs | ✅ Paper ready |
| **agent-architecture** | 16 docs | ✅ Active (synthesized into braid-research) |
| **pi-braid-proposals** | 14 docs | 🔄 Implementation (mostly unimplemented) |
| **sycophancy** | 3 docs | ✅ Silicon mirror |
| **cognitive-control** | 1 doc | ⏳ Stub |
| **measurement** | 1 doc | ⏳ Stub |
| **knowledge-conflicts** | 1 doc | ⏳ Stub |

---

## 7. Key Learnings & Patterns

### What Works
1. **Identity over directives** — 88% solve rate with implicit×identity framing
2. **Dynamic behavior modes** — right directive at the right time beats all directives always
3. **Pointer blocks** — skills/project-docs/memory as discoverability triples, not content injection
4. **PromptSection primitive** — clean composable architecture
5. **Verification triple** — prevents drift, SPQ-1 identified as highest-leverage prompt change

### What Didn't Work
1. **Value statements** (8 static directives) — deleted as bloat, replaced by verifier tools
2. **Contrast phrases** — deleted as collateral damage in same purge
3. **Tools metaphor** ("keys to doors") — deleted for self-narration risk
4. **"Think silently" variants** — evolved through 5 forms, then dropped entirely
5. **"From now you are..."** temporal framing — removed for simplicity

### What's Still Missing (Highest Priority)
1. **Self-evolution loop** — MARS single-cycle reflection + ACE context-as-playbook
2. **Bidirectional verifier** — forward trace + backward check for fix correctness
3. **Heartbeat as event bus** — unified async event model
4. **Hierarchical memory compression** — 3-tier working→episodic→procedural
5. **Structured output catalyst** — MDA-style induction head stimulation

---

## 8. Source Inventory

| Source | Path | Key Files |
|--------|------|-----------|
| Current prompt-builder | `pi-braid/src/extensions/core/prompt-builder/` | 12 files (identity.ts, index.ts, etc.) |
| Past prompt-builder | `pi-mono/packages/coding-agent/src/core/` | system-prompt.ts, prompt-templates.ts |
| Research proposals | `vibe/implicit-framing/docs/research/pi-braid-proposals/` | 14 proposals |
| Agent architecture | `vibe/implicit-framing/docs/research/agent-architecture/` | 16 research docs |
| Braid research compendium | `vibe/llm-compliance-theater/braid-research/` | 36 synthetic docs |
| Compliance theater paper | `vibe/llm-compliance-theater/paper/` | main.pdf, main.tex |
| Research synthesis | `vibe/implicit-framing/RESEARCH_SYNTHESIS.md` | Full experiment results |
| Archived docs | `pi-braid/docs/archive/` | 14 archived proposals (9+5) |

## 9. Session Archaeology Summary

### Early pi-mono Sessions (Mar 3-8, 2026)
- **98 sessions total** in `--Users-kifir-projects-agents-pi-mono--`
- **9 sessions** mention Braid/prompt-builder/identity
- Earliest: Mar 8 — structured error logging, no Braid identity yet
- Mar 22-24: cognitive systems, prompt extraction to plugins, enforcement
- Mar 27: enforcement systems, lazy behavior detection, anti-laziness

### pi-mono coding-agent Sessions (Mar 3-9, 2026)
- **243 sessions total** in `--Users-kifir-projects-agents-pi-mono-packages-coding-agent--`
- Earliest: Mar 3 — system prompt was pi-native default ("expert coding assistant")
- Key finding from Mar 4: *"system prompt and context management could be extracted to builtin skill — so we stay minimal but even more modular"*

### implicit-framing Sessions (Apr 6-May 6, 2026)
- **30 sessions total**
- Apr 7: First implicit framing experiments — 12 identity variants tested
- Apr 9: 4-condition observational study (architect/careful/meticulous/explicit)
- Apr 22: Self-evolution & meta-cognition research (Autogenesis, MARS, ACE)
- Apr 23: RepE prompt contrast, structured output catalyst, MDA research
- Apr 26: 2×2 factorial experiment completed
- May 1-6: Braid prompt-builder evolution, "think silently" analysis

### pi-braid Sessions (Apr 13-Jul 6, 2026)
- **302 sessions total** — the largest session archive
- Apr 13-14: Early Braid prompt-builder creation
- Jun 27-29: The lean refactor — value statements deleted, behavior modes restored
- Jul 4: RESOURCE_DISCOVERY invariant, DISCOVERABILITY tighten
- Jul 6: Current state — 8 invariants, 4 behavior modes

## 10. Archived Docs Inventory (14 docs)

| Document | Status | Key Content |
|----------|--------|-------------|
| `ARXIV-CITATIONS-AUDIT.md` | ✅ Archived | All arXiv citations verified, test enforces |
| `CASTS-AUDIT.md` | ✅ Archived | 4 remaining `as unknown as` casts, all with fix paths |
| `CODE-QUALITY-REMEDIATION-PLAN.md` | ✅ Archived | Complete record, all shipped |
| `CONTEXT-MANAGEMENT-IMPROVEMENTS.md` | ✅ Archived | All features shipped (compress, archive, navigate) |
| `DOCUMENTATION-REVIEW-PROPOSAL.md` | ✅ Archived | Superseded by work |
| `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` | ✅ Archived | 35 whisper templates, 15 EW-7 proposals in ROADMAP |
| `HOOKS-AND-WHISPERS-AUDIT.md` | ✅ Archived | Completed event mapping |
| `P2-10-LARGE-FILE-DECOMPOSITION.md` | ✅ Archived | All 4 file splits shipped |
| `Q13-SPLIT-INDEX-STATUS.md` | ✅ Archived | 8 large index.ts files; 4 already split, 4 deferred |
| `RESEARCH-INTEGRATION-TESTING-GAP.md` | ✅ Archived | Research, no implementation plan |
| `SELF-EVOLUTION-PROPOSAL.md` | ✅ Archived | Self-Harness (2606.09498) + Faithfulness Gap (2606.00476) proposals |
| `STATE-POLICY.md` | ✅ Archived | Design narrative; operational policy in src/lib/state/AGENTS.md |
| `TOOL-INVENTORY-AUDIT.md` | ✅ Archived | 30 tools audited, bloat/redundancy identified |
| `WHISPER-AND-LOGGING-AUDIT.md` | ✅ Archived | 37 sendTrackedMessage callsites, 0 console.* anti-patterns |

## 11. Key Archived Proposal: Self-Evolution (from Self-Harness paper)

The most detailed unimplemented proposal lives in `docs/archive/SELF-EVOLUTION-PROPOSAL.md` (archived Jul 4).

**Paper A: Self-Harness** (Zhang et al., arXiv:2606.09498, 8 Jun 2026)
- Three-stage loop: Weakness Mining → Harness Proposal → Proposal Validation
- Verified on Terminal-Bench-2.0: MiniMax M2.5 40.5%→61.9%, Qwen3.5 23.8%→38.1%, GLM-5 42.9%→57.1%
- Acceptance rule: Pareto non-regression (Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0)
- K parallel candidates, diversity yet minimality constraint

**Paper B: Faithfulness Gap** (Wang, arXiv:2606.00476, 30 May 2026)
- CoT unfaithfulness is mostly a measurement artifact
- Free-text phrase parser: 22-26% inconsistency → Explicit decision tag: 0.0-1.8%
- Real failure (65%): agents estimate inputs correctly, restate the rule, then announce a wrong decision
- Injecting the rule into the prompt does not help

**Implication for Braid**: The current `verify` and `finalize` tools already address the faithfulness gap (explicit verification before marking done). The Self-Harness loop would add automated harness improvement.