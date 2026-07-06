# Braid Improvement Proposals — From Archaeology to Action

<!-- status: forward-looking -->
<!-- Generated: 2026-07-06 -->
<!-- Sources: 11-section archaeology report, ROADMAP.md, current source audit -->

> **What this is**: Concrete, actionable improvements derived from the Braid
> archaeology (ARCHAEOLOGY-FINDINGS.md). Each proposal cites specific file
> paths, estimated effort, and verification criteria. Proposals that
> intersect with existing ROADMAP items are flagged.
>
> **Priority key**: Impact/Effort ratio (high = do first).

---

## Quick Wins (< 2 hours each)

### QW-1: Restore Contrast Phrase Library (Collateral Damage Recovery)

**Impact**: High — 4 research-backed behavioral steering phrases, deleted as
collateral damage in the Jun 29 purge. They were in the same file as the
8 value statements (behavioral-guardrails.ts) which were intentionally deleted;
the contrast phrases were not intended for removal.

**What to do**:
1. Create `src/extensions/core/prompt-builder/contrast-phrases.ts` with the 4 phrases:
   - `TRUTH_FIRST`: "Your primary obligation is TRUTHFULNESS, not agreeableness..."
   - `ANTI_SYCOPHANCY`: "You are an objective analyst. State what you believe..."
   - `EPISTEMIC_STABILITY`: "Confidence calibration: Only express high confidence..."
   - `KNOWLEDGE_BOUNDARY`: "Distinguish between what you KNOW and what you INFER..."
2. Wire into `prompt-builder/index.ts` as a `linesSection("contrast-phrases", ...)` 
   rendered before the behavior-mode section.
3. Write a test that asserts the 4 constants exist and are exported.

**Effort**: ~1 hour (create file, wire into index.ts, test)
**Verification**: `npm test` passes, grep for each constant name in system prompt
**Research backing**: RepE (2310.01405), BeHonest (2406.13261)
**ROADMAP intersection**: None — this is a new item

### QW-2: Wire PLANNING Mode to a Real Enforcement Signal

**Impact**: Medium — PLANNING mode exists in `behavior-modes.ts` and
`determineContrastMode()` but only fires during first 3 turns if
`startupPlanShown` is true. It's essentially dormant after turn 3.

**What to do**:
- Add a signal in `turn-end-handler.ts` that detects when the agent has made
  3+ tool calls without setting a scratchpad goal (beyond the startup phase).
- Set `startupPlanShown` (or a new `planningTriggered` flag) in enforcement
  state when this pattern is detected.
- This catches the "tool-calling-without-direction" pattern at any turn.

**Effort**: ~1.5 hours (modify turn-end-handler.ts, add state field, test)
**Verification**: In a test session, make 4 tool calls without `scratchpad(action="set_goal")` → PLANNING mode activates
**ROADMAP intersection**: None — new item

### QW-3: Add COMPLETION Mode Whisper on Session Shutdown

**Impact**: Medium — COMPLETION mode exists and fires when work is done
without `finalize`, but there's no whisper on session shutdown itself.

**What to do**:
- Add a `session_shutdown` handler in `behavior-modes.ts` or
  `prompt-builder/index.ts` that checks if any significant work was done
  (file edits, tool calls) without a corresponding `finalize`.
- Emit `enforcement_signals { contrastMode: "COMPLETION" }` if so.

**Effort**: ~1 hour (add event handler, check for un-finalized work)
**Verification**: `git log --oneline -1` shows the new handler
**ROADMAP intersection**: None — new item

---

## Moderate Improvements (2-6 hours each)

### MI-1: Upgrade MARS Reflector to Full Principle+Procedure Reflection

**Impact**: **High** — Current `mars-reflector.ts` (210 lines) is a statistical
tool-usage analyzer, not a MARS implementation. The real MARS paper
(2601.11974) uses two reflection types: principle-based (abstract normative
rules) and procedural (step-by-step strategies). The current code only does
frequency analysis.

**What to do**:
1. Rename current `mars-reflector.ts` → `tool-usage-analyzer.ts` (accurate name)
2. Create new `mars-reflector.ts` implementing:
   - **Principle reflection**: After task completion, extract "what general rule
     should I follow to avoid errors?" → store as heuristic
   - **Procedure reflection**: After successful task, extract "what specific steps
     led to success?" → store as episodic memory
3. Wire into `turn-end-handler.ts` — fire on task completion, not every turn
4. Connect to `evolver.ts` — feed extracted principles as heuristic candidates

**Effort**: ~4-6 hours (rename, implement two reflection types, wire, test)
**Verification**: After task completion, `memory action=episodes_search` finds
procedure entries; `heuristics_list` shows principle entries
**Research backing**: MARS (2601.11974), ACE (2510.04618)
**ROADMAP intersection**: Overlaps with DR-M-1 (MARS lookback) which is shipped;
this goes beyond what's in the roadmap

### MI-2: Add Truth-Seeking Signal to CONTRAST Mode Detection

**Impact**: Medium — The TRUTH-SEEKING mode is the default but has no
dedicated signal. The `determineContrastMode()` function falls through to
default when no anomalies are detected. But the TRUTH-SEEKING directives
(references are claims, verify state) are only active by default — they're
never explicitly triggered.

**What to do**:
- Add a `gt_check` or `probe_trigger` signal in `signals.ts` that surfaces
  when the agent encounters a potential contradiction between context
  claims and actual state.
- Wire this to the `verify_claim` tool or `conflict_qa` tool — when the
  agent uses these tools, briefly surface TRUTH-SEEKING mode explicitly
  (confirming the correct epistemic stance).

**Effort**: ~2 hours (add signal key, wire to verify_claim/conflict_qa calls)
**Verification**: After calling `verify_claim`, the system prompt shows
"## Active Mode: Truth-Seeking"
**ROADMAP intersection**: None — new item

### MI-3: Structured Output Catalyst for Tool Results ✅ SHIPPED

**Commit**: (pending — see `git log` in this session)

**Implementation**:
- `src/lib/utils/format-tool-result.ts` — `formatToolResult()` utility that
  prepends `TOOL: <name>\nSTATUS: success|error\nRESULT: <summary>\n---`
  to tool output text blocks.
- `src/extensions/enforcement/handlers/register-tool-result-formatting.ts` —
  `tool_result` event handler using pi-core's middleware chaining to modify
  content before delivery to the agent.
- Opt-in via `structuredToolOutput: true` in pi settings.json. Disabled by
  default to preserve existing behavior.

**Research backing**: MDA (2601.21996), IRCoT (2212.10509), CRL (2602.10437)
**ROADMAP intersection**: None — new item

---

## Large Projects (1-3 days each)

### LP-1: Self-Harness Loop (Automated Harness Improvement)

**Impact**: **Highest** — The Self-Harness paper (2606.09498) shows 53-60%
relative improvement on held-out tasks. The blueprint is concrete:
Weakness Mining → Harness Proposal → Proposal Validation with Pareto
non-regression. pi-braid already has the infrastructure (evaluation
framework, prompt-builder, enforcement signals).

**What to do**:
1. **Weakness Mining**: Create a module that clusters failed evaluation
   traces by failure signature (terminal cause, agent mechanism, causal
   status). Use existing `evaluation/` benchmark infrastructure.
2. **Harness Proposal**: The same model (in a proposer role) generates K
   parallel candidate edits to the system prompt, tool descriptions, or
   behavior modes. Each candidate is (a) grounded in a specific failure
   cluster, (b) targeted at a declared editable surface, (c) minimal.
3. **Proposal Validation**: Run each candidate on held-in + held-out splits.
   Acceptance rule: `Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0` (Pareto non-regression).
4. **Audit Trail**: Every transition records (changed surfaces, eval
   outcomes, accept/reject decision). Harness becomes a lineage.

**Effort**: ~2-3 days full-time (3 modules + integration + tests)
**Verification**: After a Self-Harness cycle, one improvement is accepted
and the held-out score does not regress
**Research backing**: Self-Harness (2606.09498), MARS (2601.11974), ACE (2510.04618)
**ROADMAP intersection**: None — entirely new, but `evolver.ts` is a prototype

### LP-2: Bidirectional Verifier (Forward Trace + Backward Check)

**Impact**: High — The HWE-Bench failure mode (agent fixes RTL but misses
generated file) is a known pattern. The bidirectional verifier catches it
before the agent claims done.

**What to do**:
1. **Forward Trace**: Before editing, trace `problem → possible causes →
   candidate files`. Validate that the selected file is root cause, not
   symptom. Wire into `edit` tool pre-execution hook.
2. **Backward Check**: After fix, trace `fix → expected behavior change →
   does this propagate to the symptom?`. Wire into `verify` tool.
3. **Coordination Checker**: Track `derived-from` relationships. After fix,
   check if derived files are also updated.

**Effort**: ~1.5-2 days (4 phases, integration with existing tools, tests)
**Verification**: A test case where fixing RTL without updating the
generated file triggers a coordination warning
**Research backing**: AgentV-RL (2604.16004), HWE-Bench (2604.14709)
**ROADMAP intersection**: None — new item

### LP-3: Memory Leak Prevention — Cross-Project Session Isolation

**Impact**: Medium-High — HaluMem (2511.03506) shows memory hallucinations
at three stages: extraction, updating, propagation. Cross-project
contamination is a real failure mode.

**What to do**:
1. **Provenance tracking**: Every memory entry carries a `projectId` (from
   `ctx.cwd` or a project hash). On retrieval, filter by current project.
2. **Explicit/Implicit boundary**: The system prompt gets a oneliner:
   *"Memory entries are tagged by project. Only retrieve entries from the
   current project unless explicitly asked."*
3. **Conflict detection**: When a new memory conflicts with an existing one
   from a different project, surface the conflict rather than silently
   overwriting.

**Effort**: ~1.5 days (provenance schema, retrieval filter, conflict detection)
**Verification**: Memory stored in project A does not appear in `memory
action=recall_search` when working in project B
**Research backing**: HaluMem (2511.03506), SimpleMem (2601.02553)
**ROADMAP intersection**: None — new item

---

## Strategic Initiatives (3-5 days each)

### SI-1: Heartbeat as Unified Event Bus

**Impact**: High — The heartbeat scheduler is already an event bus. Making
it explicit unlocks composable, typed event handling across all extensions.

**What to do**:
- Define typed event types (`AgentEvent` union: timer_fire, memory_evict,
  heuristic_fire, turn_complete, context_full, belief_conflict, etc.)
- Create `EventBus` interface with `on<T>()`, `emit()`, `once()`, `off()`
- Migrate current ad-hoc event emission (timer, memory, context-manager,
  enforcement) to the typed bus
- Keep backward compatibility with existing `pi.events.on()`

**Effort**: ~3-4 days (type definitions, bus implementation, migration of
6+ extensions, test)
**Verification**: All existing events still fire; new typed handlers work
**Research backing**: None (architecture pattern)
**ROADMAP intersection**: None — new

---

## Priority Matrix

| ID | Proposal | Impact | Effort | I/E Ratio | Type |
|----|----------|--------|--------|-----------|------|
| QW-1 | Restore Contrast Phrases | High | 1h | ★★★★★ | Quick win |
| QW-2 | Wire PLANNING mode | Medium | 1.5h | ★★★★ | Quick win |
| QW-3 | COMPLETION on shutdown | Medium | 1h | ★★★★ | Quick win |
| MI-1 | Upgrade MARS | High | 4-6h | ★★★★ | Moderate |
| MI-2 | Truth-Seeking signal | Medium | 2h | ★★★ | Moderate |
| MI-3 | Structured Output Catalyst | Medium | 3-4h | ★★★ | Moderate |
| LP-1 | Self-Harness Loop | Highest | 2-3d | ★★★★ | Large |
| LP-2 | Bidirectional Verifier | High | 1.5-2d | ★★★ | Large |
| LP-3 | Memory Leak Prevention | Medium-High | 1.5d | ★★★ | Large |
| SI-1 | Heartbeat Event Bus | High | 3-4d | ★★ | Strategic |

---

## Implementation Order (Recommended)

**Sprint 1** (highest I/E, can be done in one session):
1. QW-1: Restore contrast phrases (~1h) — quick win, collateral damage fix
2. QW-2: Wire PLANNING mode to real signal (~1.5h) — dormant feature activation
3. QW-3: COMPLETION whisper on shutdown (~1h) — session hygiene

**Sprint 2** (moderate effort, high impact):
4. MI-1: Upgrade MARS to full principle+procedure reflection (~4-6h)
5. MI-2: Add Truth-Seeking signal to CONTRAST detection (~2h)

**Sprint 3** (large projects, start with LP-1):
6. MI-3: Structured Output Catalyst (~3-4h) ✅ SHIPPED
7. LP-1: Self-Harness Loop (~2-3d) — the highest-impact unimplemented proposal
8. LP-2: Bidirectional Verifier (~1.5-2d)

**Sprint 4** (remaining):
9. LP-3: Memory Leak Prevention (~1.5d)
10. SI-1: Heartbeat Event Bus (~3-4d)

---

## Items Explicitly NOT Recommended

| Archaeology Finding | Why Not |
|---------------------|---------|
| Restore 8 value statements | Intentionally deleted — verifier tools carry that rigor better |
| Restore "think silently" | Research inconclusive, user preference varied |
| Restore tools metaphor | Removed for self-narration risk |
| SAE Steering | Blocked by API providers — no hidden state access |
| Benchmark improvements | 161 result JSONs exist but no evaluation infrastructure |
| VAR-MATH variants | Useful but depends on benchmark infrastructure |
| RepE activation injection | Blocked by API providers — only text-space approximation possible |