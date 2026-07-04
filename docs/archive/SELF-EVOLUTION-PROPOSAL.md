<!-- status: historical -->
<!-- archived: 2026-07-04. Research-backed proposals. No implementation timeline or committed workstream. Preserved for reference if research-driven improvements are revisited. -->

# Self-Evolution Proposal: From Research to Braid Improvements (Archived)

> **Scope.** A grounded analysis of two recent arXiv papers (2606.09498
> "Self-Harness" and 2606.00476 "Faithfulness Gap in LLM Agents") and
> the concrete improvements they suggest for pi-braid. Every proposal
> cites a specific file:line in this codebase. Effort is estimated in
> lines of code (LOC) and test count, not abstract complexity.
>
> **Status:** forward-looking — these are proposals, not yet shipped.
> Some proposals reference patterns braid already implements; we list
> them explicitly so we don't redo work.

---

## Part 1 — Paper Summaries

### Paper A: "Self-Harness: Harnesses That Improve Themselves"

**Source:** Zhang et al., Shanghai AI Lab, arXiv:2606.09498, 8 Jun 2026.
**Core thesis:** An LLM agent can improve its own operating harness
(system prompt, tools, runtime policy) through an iterative loop —
without human engineers or stronger external agents.

**The loop has three stages:**

1. **Weakness Mining.** Run the agent on a held-in task set under the
   current harness. Cluster failed traces by **failure signature**
   `(terminal cause, agent mechanism, causal status)` — not by outcome
   alone. The signature separates "verifier-rejected" from "agent
   misbehaved" so that two timeouts with different underlying causes
   aren't conflated.
2. **Harness Proposal.** The same model, in a proposer role, generates
   K parallel candidate edits. Each candidate is **(a) grounded in a
   specific failure cluster, (b) targeted at a declared editable
   surface, (c) minimal** (modifies only the surface needed, preserves
   unrelated harness behavior).
3. **Proposal Validation.** Each candidate is run on both held-in and
   held-out splits. **Acceptance rule:** improve ≥1 split without
   degrading the other (`Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0`). This is
   **Pareto non-regression**, not raw improvement. Trade-offs are
   rejected.

**Key design points:**

- **Diversity yet minimality.** K parallel branches explore distinct
  mechanisms; each branch is constrained to be small.
- **Verifier-grounded, not model-grounded.** Clustering is driven by
  the evaluator's verdicts, not by trace similarity. The proposer is
  exposed to structured evidence bundles, not raw logs.
- **Audit trail.** Every transition records (changed surfaces, eval
  outcomes, accept/reject decision). Harness becomes a *lineage*.
- **Bounded edits, not open-ended rewrites.** The initial harness
  declares an editable interface; only those surfaces are mutable.

**Empirical results** (Terminal-Bench-2.0, 3 model families):
- MiniMax M2.5: 40.5% → 61.9% held-out (53% relative gain)
- Qwen3.5-35B-A3B: 23.8% → 38.1% held-out (60% relative)
- GLM-5: 42.9% → 57.1% held-out (33% relative)

Different models get different edits — M2.5 learned "create required
output early"; Qwen3.5 learned "dependency precheck + retry discipline";
GLM-5 learned "persist environment across shell sessions." The harness
adapts to the model, not the other way around.

### Paper B: "Doing What They Say, Not What They Reason: Locating the Faithfulness Gap in LLM Agents"

**Source:** Wang, arXiv:2606.00476, 30 May 2026.
**Core thesis:** CoT "unfaithfulness" is mostly a measurement artifact.
The real gap is upstream of the conclusion, not downstream.

**Decomposition:** Agent decision pipeline splits into two steps:

- **reasoning → conclusion** (does the stated decision follow from the
  stated reasoning?)
- **conclusion → action** (does the agent execute the decision it stated?)

**Findings** (Texas Hold'em, 3 model families, 200-hand runs):

| Step | Inconsistency rate |
|---|---|
| Free-text phrase parser (conclusion→action) | 22–26% |
| Explicit decision tag (conclusion→action) | **0.0–1.8%** |
| Reasoning→conclusion validity | 65% rule-misapplication |

The first row is the artifact: a regex parser inferring "should raise"
from free text frequently picks up the wrong candidate action. With an
explicit `DECISION: <fold\|check\|call\|raise>` tag, inconsistency
collapses to near zero.

**The real failure (65% of errors):** agents estimate inputs correctly
and restate the rule, then announce a decision that does not follow.
In 97% of rule-misapplications, the stated rule says "raise" but the
agent chooses a passive action. Errors are **strongly directional** —
risk-averse hedging overrides quantitative reasoning. **Injecting the
rule into the prompt does not help.** GTO-constrained strategy ranked
at or near the bottom on every model.

**Implications for persona modeling:** a stated persona can be
faithfully articulated while actions are pulled toward a generic
conservative prior. Outcome-level checks miss this. Process-fidelity
probes that elicit machine-checkable conclusions are the only way to
detect persona drift.

**Recommendation:** evaluations should **target the reasoning→conclusion
step** and **elicit machine-checkable conclusions** rather than
inferring them from prose.

---

## Part 2 — What Braid Already Has

Braid is already on the path both papers describe. The point of this
audit is to identify *gaps*, not duplicate work.

### 2.1 Mapping to Self-Harness

| Paper concept | Braid implementation | File:line |
|---|---|---|
| Persistent evidence bundle | Episodes store (task, solution, outcome, toolSequence, tags, strategicSOP) | `src/extensions/memory/three-memory-stores/episodes.ts:62-80` |
| Per-session state isolation | `getExtensionState(ctx, key, factory)` | `src/lib/state/extension-state.ts` |
| Verifier-grounded outcome | `verification-judge` runs per turn, returns pass/fail | `src/extensions/enforcement/verification-judge.ts` |
| Failure detection on every turn | Turn-end hygiene + turn-outcome detector | `src/extensions/enforcement/handlers/register-turn-end-hygiene.ts:39-91` |
| Enforcement signals (typed, bounded retention) | `enforcementSignals` keyed by turn, retention=3 | `src/extensions/enforcement/signals.ts:36-50` |
| Discipline gates (regression test substrate) | `npm run ci:check` = typecheck + test + check:docs + check:doc-drift + check:deps | `scripts/check-deps.mjs`, `check-doc-drift.mjs`, `check-doc-status.mjs` |
| Verification triples before finalize | SPQ-1 (Definition of Done invariant) | shipped `51f8787e feat(prompt-builder): Definition of Done invariant` |
| Harness lineage | Git log with structured commit messages | `.git` (per-commit, audited) |
| State discoverability (resume.json on SESSION_SHUTDOWN) | `register-session-shutdown-resumption.ts` | shipped `f324849e` |
| State discoverability (whispers on SESSION_START) | `register-session-start-discoverability.ts` | shipped `f324849e` |

### 2.2 Mapping to Faithfulness Gap

| Paper concept | Braid implementation | File:line |
|---|---|---|
| Plan with explicit decisions | Scratchpad `add_plan`, `add_decision` | `src/extensions/memory/scratchpad/` |
| Decision recorded with reasoning | `add_decision({ text, rationale, ... })` | scratchpad types |
| Tool-call audit trail | Pi-core trace recording; `enforcementSignals` | `src/extensions/enforcement/signals.ts` |
| Claim verification (stated claim → evidence) | `cognitive/metacognition/handlers/claim-verification.ts` | `src/extensions/cognitive/metacognition/handlers/claim-verification.ts` |
| Goal drift detection | Topic-drift detector | `src/extensions/cognitive/topic-drift/` |
| Verification before finalize | SPQ-1 Definition of Done | shipped `51f8787e` |
| Tool provenance (which extension emitted which tool) | `lib/state/tool-provenance.ts` | shipped `111b12d8` |

### 2.3 What's missing (the gap analysis)

| Self-Harness concept | Braid has it? | Gap |
|---|---|---|
| Verifier-grounded failure *signatures* (clustered by mechanism) | ❌ | Episodes record `outcome: success\|partial\|failure` but not the **why** — no taxonomy of failure mechanisms, no clustering |
| Editable surface declaration | ❌ | DOX status markers cover docs; **code has no equivalent** — agent could in principle edit any file |
| Harness candidate lifecycle (propose → test → accept/reject) | ❌ | Git log is the de-facto record, but no structured (surface, evidence, decision) model |
| Pareto non-regression acceptance rule | ❌ | Discipline gates pass/fail, no notion of "improved one split without degrading another" — this is harness-edit framing, not doc-edit framing |
| Bounded proposal format | ❌ | No `proposeHarnessEdit` tool; the agent improvises edits via `edit`/`write` |
| Self-evolution loop driver | ❌ | No "periodic: cluster recent failures → emit proposal whisper" extension |

| Faithfulness Gap concept | Braid has it? | Gap |
|---|---|---|
| Stated intent elicitation (machine-checkable) | ⚠️ Partial | SPQ-1 covers finalize. **Generalized claim format** (e.g., `CLAIM: <text>; REASON: <text>; VERIFY: <command>`) is not in the prompt. |
| Conclusion→action consistency check | ❌ | When agent adds a plan item, we don't check the tool-call sequence actually addresses it. Topic-drift looks at *goal*, not at *plan→action* |
| Reasoning→conclusion validity | ❌ | When agent adds a decision with rationale, we don't check the rationale supports the decision |
| Process-fidelity audit log | ⚠️ Partial | enforcementSignals + git log exist; **no per-decision (claim, evidence, decision, action, verification)** log |
| "Hedging overrides quantitative" detection | ❌ | We don't have a heuristic for "stated rule + override" — but our existing `claim-verification` handler could be extended |

**Bottom line:** Braid has the *infrastructure* (scratchpad, memory, verification, discipline gates). It does not have the *wiring* that would let the agent (or a self-evolution driver) close the Self-Harness loop on its own harness.

---

## Part 3 — Concrete Proposals (P0 → P3)

Ordered by impact / cost ratio. Every proposal cites the file(s) it
would touch and a rough LOC estimate. P0 is ship-this-month; P3 is
research.

### P0 — Failure Mechanism Capture in Episodes

**Paper link:** Self-Harness §3.2 (Weakness Mining) — clustering by
`φ(r_i) = (c_i, q_i, m_i)` where `m_i` is the **abstract agent
mechanism**.

**Current state:** `Episode` shape (`src/extensions/memory/three-memory-stores/types.ts`)
has `outcome: 'success' | 'partial' | 'failure'` and a free-form
`tags: string[]` field. Free-form tags are not a mechanism taxonomy —
they're whatever string the agent or the writer felt like. The paper's
key finding is that clustering by outcome alone conflates "timeout due
to retry loop" with "timeout due to wrong file path" — both look like
failures but require different harness interventions.

**Proposal:** Add a structured `failureMechanism` field to `Episode`
with a closed enum of mechanism classes derived from the existing
enforcement signals. Initial set (extensible):

```ts
type FailureMechanism =
  | 'tool_loop'              // repeated identical failed tool calls
  | 'artifact_missing'       // never produced required output
  | 'context_overflow'       // hit usage cap before conclusion
  | 'wrong_target'           // edited wrong file/function
  | 'rule_misapply'          // stated rule, then overrode (Faithfulness Gap)
  | 'verification_skipped'   // claimed success without verifying
  | 'goal_drift'             // lost track of original task
  | 'external_dependency'    // network/external service failed
  | 'other';                 // unclassified
```

**Population strategy:** Two paths write this field.
1. The `verification-judge` (`src/extensions/enforcement/verification-judge.ts`)
   classifies its own verdict into a mechanism. The judge already
   reasons about the trace; this is a small extension.
2. The `auto-recovery` extension (`src/extensions/self/auto-recovery/`)
   can append a mechanism tag on dedup detection.

**Why P0:** Without structured mechanisms, the agent (or a self-evolution
driver) cannot cluster episodes by *intervention type* — the
Self-Harness weakness-mining stage. We already have the raw data; this
is a schema addition plus a one-place classifier.

**Files touched:**
- `src/extensions/memory/three-memory-stores/types.ts` (add field) ~10 LOC
- `src/extensions/memory/three-memory-stores/episodes.ts` (sanitize
  the new field) ~5 LOC
- `src/extensions/enforcement/verification-judge.ts` (classify verdict
  into mechanism) ~30 LOC
- `src/extensions/memory/memory-agent-bridge/index.ts` (expose
  `episodes_search` filter by `failureMechanism`) ~20 LOC
- `test/runtime/lib/test-failure-mechanism.mjs` (new) ~60 LOC
- `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (note the new field
  in §3 catalog) ~5 LOC

**Total:** ~130 LOC. **Verification:** `npm run test` (new test
included), `npm run typecheck`, plus a check-deps scan.

---

### P0 — Stated-Intent Format for Scratchpad Decisions

**Paper link:** Faithfulness Gap §4.1 (explicit decision tag reduces
inconsistency from 22-26% to 0-1.8%) and §4.2 (rule-misapplication is
the real failure).

**Current state:** `add_decision` accepts a free-text `text` and optional
`rationale`. Nothing forces the agent to surface the rule, inputs, and
override in a machine-checkable form. The Faithfulness Gap paper's
key methodological point is that **the format of the elicitation
determines whether the failure is even visible** — free-text rationale
hides rule-misapplication; explicit tags expose it.

**Proposal:** Add a structured `add_decision` variant that accepts:

```ts
add_decision({
  text: "switch to deps file",
  // Structured variant — what the paper recommends
  claim:    "EDR < sweet spot for Qwen3.5 because dependency precheck",
  rule:     "always check deps before tool-use loops",
  evidence: ["episodes.jsonl#42", "episodes.jsonl#43"],
  override: null,  // or: { reason: "task is exploratory" }
})
```

The agent can still use the free-text variant, but the structured
variant unlocks verification:
- `rule + override: null` ⇒ check that `claim` follows from `rule`
- `override: { reason }` ⇒ check that `reason` is a valid exception
  (not a re-statement of `claim`)

**Verification path:** The `cognitive/metacognition/handlers/claim-verification.ts`
handler already runs. Extend it to:
- Read the new fields from scratchpad
- Apply a lightweight "does claim follow from rule" check
  (initially: keyword overlap; later: a verification judge call)
- Emit a whisper when mismatch detected

**Why P0:** This is the cheapest possible Faithfulness Gap implementation.
The paper's *headline* finding is that the right elicitation format
collapses the apparent faithfulness gap. Braid is in a unique position
to adopt this in its own scratchpad without changing the LLM.

**Files touched:**
- `src/extensions/memory/scratchpad/types.ts` (new fields on Decision) ~20 LOC
- `src/extensions/memory/scratchpad/handlers.ts` (parse the new
  variant in `add_decision`) ~30 LOC
- `src/extensions/cognitive/metacognition/handlers/claim-verification.ts`
  (verify structured claims) ~40 LOC
- `src/extensions/memory/scratchpad/AGENTS.md` (document the variant) ~15 LOC
- `test/runtime/lib/test-structured-decision.mjs` (new) ~50 LOC

**Total:** ~155 LOC.

---

### P1 — Editable Surface Declaration for Code

**Paper link:** Self-Harness §3.3 (Harness Proposal) — "Each proposal
must be grounded in a primary failure mechanism and mapped to a
concrete editable surface." The paper's harness is *declared* as a
set of editable surfaces (`build_memory_sources`, `build_subagents`,
`build_skills`, `build_bootstrap_instruction`, etc. — see Figure 3).

**Current state:** Braid has the DOX framework
(`<!-- status: current|forward-looking|aspirational|historical -->`)
for **docs**. There is no equivalent for **code**. The agent can in
principle edit any file in the repository.

**Proposal:** Extend the DOX marker concept to code via a single
declarative file at the repo root:

```ts
// editable-surfaces.ts
export const EDITABLE_SURFACES = {
  // Self-evolution tier (P0): frequent, low-risk
  'src/lib/state/AGENTS.md':         { tier: 'P0', risk: 'low'  },
  'docs/ROADMAP.md':                 { tier: 'P0', risk: 'low'  },
  'src/extensions/*/index.ts':       { tier: 'P1', risk: 'medium' },
  'src/extensions/*/handlers/*.ts':  { tier: 'P1', risk: 'medium' },
  // Higher-risk: changes affect multiple sessions
  'src/lib/prompt-builder/*.ts':     { tier: 'P2', risk: 'high' },
  'src/loader/loader.ts':            { tier: 'P3', risk: 'critical' },
} as const;
```

**Enforcement:** A new `scripts/check-editable-surfaces.mjs` greps
git log for commits that touch files outside the declared surfaces
*and were not preceded by a surface-extension PR* (i.e., the surface
table itself was updated). Such commits fail CI.

**Why P1, not P0:** Braid's "HANDOFF" already establishes that the
agent operates within a project that *the user controls*. The surface
declaration is a *documentation* of that boundary, not a hard fence.
The paper's harness has hard editability constraints, but for braid
the constraint is more about auditability than enforcement — a future
self-evolution loop (P3 below) needs to know what's safe to touch.

**Files touched:**
- `editable-surfaces.ts` (new) ~30 LOC
- `scripts/check-editable-surfaces.mjs` (new) ~50 LOC
- `package.json` (wire into `ci:check`) ~5 LOC
- `AGENTS.md` (document the convention) ~20 LOC
- `docs/SELF-EVOLUTION-PROPOSAL.md` (this file, update with adoption) ~5 LOC

**Total:** ~110 LOC. **Verification:** manual: add a forbidden file
to a branch, run the script, confirm failure.

---

### P1 — Harness Candidate Audit Log

**Paper link:** Self-Harness §3.4 (Proposal Validation) — "For each
evaluated candidate, the system records the changed surfaces, split-wise
outcomes, evaluation repeats, proposal summary, and accept/reject
decision, making each transition in the harness lineage auditable."

**Current state:** Braid's audit trail is git log. Structured commit
messages help, but the (surface, evidence, decision) tuple is
inferred from the message, not stored.

**Proposal:** Add a `HARNESS_LOG.md` (or `.jsonl`) that records every
"candidate edit considered" — accepted or rejected — with the
(Self-Harness) tuple:

```md
## 2026-06-30 candidate: tighter verification triples before finalize
- **surface:** src/extensions/core/prompt-builder/system-prompt-directive.ts
- **evidence:** episodes#42,43 (verification_skipped mechanism × 2)
- **expected effect:** fewer finalizes without verification
- **eval held-in:** 81/81 tests pass, typecheck clean
- **eval held-out:** doc discipline gate clean, check-deps clean
- **accept?** yes — improves held-in, neutral on held-out
- **commit:** 51f8787e (SPQ-1 Definition of Done)
```

The agent (or a subagent) writes one entry per candidate. The file
becomes the human- and LLM-readable harness lineage.

**Why P1:** This is a write-tool, not a code change. A `whisper`
suggesting the agent append to this file after any discipline-gate
run would seed the practice.

**Files touched:**
- `HARNESS_LOG.md` (new, ~30 LOC seeded) — empty
- `src/extensions/enforcement/handlers/register-turn-end-hygiene.ts`
  (whisper reminder) ~10 LOC
- `AGENTS.md` (document the convention) ~15 LOC

**Total:** ~55 LOC. **Verification:** visual — confirm the log
captures candidates and is git-tracked.

---

### P1 — Pareto Non-Regression Documentation

**Paper link:** Self-Harness §3.4 (acceptance rule) — `Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0`.

**Current state:** Braid's discipline gates pass/fail. There is no
notion of "this edit improved X without hurting Y." For harness
edits, the paper's framing is a useful discipline: when proposing
a change, the agent should check whether the change degrades any
existing measurement.

**Proposal:** Document the Pareto non-regression framing in
`AGENTS.md` and `docs/SELF-EVOLUTION-PROPOSAL.md`. The discipline
gates stay unchanged. The agent's proposal format (see P1 above)
includes a "what might this regress?" line. The verification triples
(SPQ-1) already cover the gate-passing side; the framing is the
addition.

**Why P1:** This is mostly a documentation/awareness change, but
the framing changes how the agent thinks about edits. It's the
cheapest way to import the paper's central methodological insight.

**Files touched:**
- `AGENTS.md` (Pareto non-regression section) ~30 LOC
- `docs/SELF-EVOLUTION-PROPOSAL.md` (this file) — already covers it

**Total:** ~30 LOC. **Verification:** re-read the agent's next
discipline-gate-failing proposal and see whether the framing is
adopted.

---

### P2 — Plan→Action Consistency Check

**Paper link:** Faithfulness Gap §3.2 (conclusion→action consistency)
and §5 (where the gap actually is).

**Current state:** Braid's `topic-drift` detector
(`src/extensions/cognitive/topic-drift/`) catches goal drift. It does
not catch *plan* drift: when the agent adds a plan item to scratchpad
and then performs a different action.

**Proposal:** A new `plan-action-consistency` handler that fires on
`turn_end` and:

1. Reads the most recent 5 plan items from scratchpad
2. Reads the tool calls from the just-finished turn
3. Computes a similarity score (reuse `src/extensions/enforcement/similarity.ts`
   cosine helper) between plan-item text and tool-call semantic
   representation
4. If all recent tool calls have low similarity to recent plan items,
   emit a whisper: "Tool calls in this turn don't address any open
   plan items. Either mark them done, or update the plan."

**Why P2:** This is a *lightweight* version of the Faithfulness Gap
conclusion→action check, applied at the plan level rather than the
per-decision level. Plan-level is the right granularity for an agent
working over many turns.

**Files touched:**
- `src/extensions/cognitive/plan-action-consistency/index.ts` (new) ~80 LOC
- `src/extensions/cognitive/plan-action-consistency/AGENTS.md` (new) ~25 LOC
- `src/extensions/manifest.ts` (register) ~5 LOC
- `test/runtime/cognitive/test-plan-action-consistency.mjs` (new) ~60 LOC

**Total:** ~170 LOC.

---

### P2 — Claim-Rule-Decision Check (Hedging Detection)

**Paper link:** Faithfulness Gap §4.2 — 97% of rule-misapplications
are rule-says-raise-but-agent-does-something-passive. **Directional
error, not random error.**

**Current state:** `claim-verification.ts` exists and runs. It does
not currently look for the specific "stated rule, then override"
pattern.

**Proposal:** Extend `claim-verification.ts` with a "hedging detector"
that triggers on scratchpad decisions with a `rule` field. Pattern:

- `rule: "X > threshold ⇒ Y"` and `decision: "Z"` (where Z ≠ Y)
- AND the override field is missing or restates the claim

→ emit a whisper citing the Faithfulness Gap finding: "You stated
rule X but decided Z. The paper's directional-error finding suggests
risk-averse hedging; is that intentional?"

**Why P2:** This is a small extension to an existing handler. The
hard part is the *lightweight* rule→decision check; the paper's
finding is that the directional error is so common that even a
crude detector will fire often enough to be useful.

**Files touched:**
- `src/extensions/cognitive/metacognition/handlers/claim-verification.ts`
  (extend with hedging detector) ~50 LOC
- `test/runtime/cognitive/test-hedging-detector.mjs` (new) ~40 LOC

**Total:** ~90 LOC.

---

### P2 — Self-Evolution Driver Extension (skeleton only)

**Paper link:** Self-Harness §3 (the loop) — the agent runs the loop
on itself.

**Current state:** None. There is no periodic "cluster failures →
propose edits → run gates" extension.

**Proposal:** A new `src/extensions/self/evolution/` extension that,
when enabled, runs the Self-Harness loop at session boundaries:

1. **Read** recent episodes filtered by `failureMechanism`
2. **Cluster** by mechanism (the P0 enum)
3. **Whisper** a structured "weakness report" to the next session
   containing top 3 failure mechanisms with episode IDs
4. **Do not auto-edit.** Emit the report; let the agent (or user)
   decide whether to propose edits

This is the "driver" part of the loop. The proposer, validator, and
audit log are P1 / P2 above. The driver glues them.

**Why P2, not P0:** The driver is meaningless without structured
mechanisms (P0) and an audit log convention (P1). Build the parts
first, then the loop. The skeleton is small; the value depends on
the parts being there.

**Files touched:**
- `src/extensions/self/evolution/index.ts` (new) ~80 LOC
- `src/extensions/self/evolution/AGENTS.md` (new) ~30 LOC
- `src/extensions/manifest.ts` (register, `disabledByDefault: true`) ~5 LOC
- `test/runtime/self/test-evolution-driver.mjs` (new) ~50 LOC

**Total:** ~165 LOC.

---

### P3 — Cross-Session Harness Lineage Tool

**Paper link:** Self-Harness §3 (entire paper — every iteration is a
state transition in a harness lineage).

**Current state:** Git log is the lineage. To query "what harness
edits have been accepted and what was their effect?", a human has to
read commits.

**Proposal:** A new tool `harness_lineage` that:

- Reads `HARNESS_LOG.md` (P1) and git log
- Returns a structured view: (date, surface, evidence, accept?, eval
  result) per accepted candidate
- Supports filters: by surface, by mechanism, by accept/reject

This is the *query layer* for the harness lineage. Without it, the
log is write-only.

**Why P3:** This is a research tool. The value depends on having a
log worth querying (P1) and a driver that writes to it (P2). Build
the rest first.

**Files touched:**
- `src/extensions/self/evolution/lineage-tool.ts` (new) ~120 LOC
- `test/runtime/self/test-lineage-tool.mjs` (new) ~80 LOC

**Total:** ~200 LOC.

---

## Part 4 — Effort / Impact Summary

| Pri | Title | LOC | Files | Impact | Risk |
|---|---|---|---|---|---|
| **P0** | Failure mechanism capture in episodes | ~130 | 5 | High (enables clustering) | Low (additive field) |
| **P0** | Stated-intent format for scratchpad decisions | ~155 | 5 | High (Faithfulness Gap core) | Low (variant, not replacement) |
| **P1** | Editable surface declaration | ~110 | 4 | Med (auditing) | Low (declarative) |
| **P1** | Harness candidate audit log | ~55 | 3 | Med (lineage substrate) | Low (write-only log) |
| **P1** | Pareto non-regression docs | ~30 | 2 | Med (framing) | None (docs) |
| **P2** | Plan→action consistency check | ~170 | 4 | Med (catches drift) | Med (false positives) |
| **P2** | Claim-rule-decision hedging detector | ~90 | 2 | Med (Faithfulness Gap §4.2) | Med (false positives) |
| **P2** | Self-evolution driver (skeleton) | ~165 | 4 | High (loop complete) | Med (whispers only) |
| **P3** | Cross-session harness lineage tool | ~200 | 2 | Med (query layer) | Low (read-only) |

**Total:** ~1100 LOC across 9 proposals, all of which are additive.

## Part 5 — Recommended Sequence

Build in this order; each step enables the next:

1. **P0 mechanism capture** — schema + classifier. Required for P1+P2
   mechanisms-based proposals to work.
2. **P0 stated-intent decisions** — the cheapest Faithfulness Gap
   adoption; immediately useful for verification.
3. **P1 editable surfaces** + **P1 audit log** — establish the
   lineage substrate.
4. **P2 plan→action** + **P2 hedging detector** — close the
   conclusion→action loop on plan items.
5. **P2 evolution driver** — glue together, with the safety of
   whisper-only output (no auto-edit).
6. **P3 lineage tool** — when there's a log worth querying.

A focused 4-session push (one per row above) would land the P0+P1
items. P2 fits in a single session if P0+P1 are already in.

## Part 6 — What We're NOT Going to Do (and Why)

The papers suggest patterns we should *not* adopt:

- **Auto-edit on accept.** The Self-Harness paper promotes edits
  programmatically; braid's constraint is *user owns the project*,
  so the highest-tier proposal is "whisper to the user/agent, do
  not auto-apply." Auto-edit would also bypass the git log audit
  trail.
- **Model-isolated optimization.** The paper optimizes the harness
  per model. Braid's model is session-bound (whichever the user is
  running). The *learned* mechanism classes (P0 enum) are model-
  agnostic; the *proposed edits* will be model-specific. We
  structure for the former and let the agent do the latter.
- **Verifier-anchored truth for free-text reasoning.** The Faithfulness
  Gap paper's GTO-verbose strategy uses machine-checkable labels
  (EQUITY, POT_ODDS, RULE, DECISION). Braid's `add_decision` is the
  closest analog, but we should *not* force every decision into
  four labeled fields — that would be over-elicitation. The P0
  proposal adds an *optional* structured variant; the free-text
  form stays.
- **Holding out tasks for regression testing.** Self-Harness splits
  tasks into held-in and held-out. Braid has no equivalent task set
  (the "benchmark" is the user's project, not Terminal-Bench). The
  discipline gates are our regression substrate: typecheck, test,
  doc-drift, check-deps.

## Part 7 — Cross-References

- `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` — §3 catalog of all
  current whisper templates; P0 mechanism-capture proposal adds
  one new whisper surface.
- `docs/FRAGILE-HEURISTICS-INVENTORY.md` — 76-heuristic catalog.
  P2 hedging detector is a new heuristic.
- `docs/CODE-QUALITY-REMEDIATION-PLAN.md` Q1-Q15 — historical
  remediation rounds; this proposal is the next wave (R1).
- `docs/ROADMAP.md` — should be updated to include the P0 items
  from this proposal as a new P-tier section once shipped.
- `docs/ARXIV-CITATIONS-AUDIT.md` — both papers should be added to
  the audit's table once their findings are cited in code; P0+P2
  proposals add 2 more arXiv references to track.

## See also

- Session resume signal: shipped `f324849e feat(session):
  environmental discoverability on SESSION_START + resumption on
  SESSION_SHUTDOWN` — prerequisite for any P2 self-evolution driver
  to work.
- SPQ-1 Definition of Done: shipped `51f8787e feat(prompt-builder):
  Definition of Done invariant` — the verification-triple substrate
  this proposal assumes.
