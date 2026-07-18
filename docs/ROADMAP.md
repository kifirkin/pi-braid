<!-- status: current -->

# pi-braid Improvement Roadmap

**Status:** Reprioritized 2026-07-16. P0 = philosophical foundation first, everything else derives from it.

**Priority key:**
- **P0** — Must be right before anything else works. If these are wrong, everything built on top is wrong.
- **P1** — Ships this session. Highest-impact, lowest-risk work.
- **P2** — Next session. Requires P0 to be settled first.
- **P3** — Deferred. Valuable but not urgent.
- **BACKLOG** — Research needed before scoping.
- **SHIPPED** — Done, but may need follow-up.

---

## P0 — Philosophical foundation (must be right first)

### P0-1: System prompt structure research — evidence-based session mining

**Why P0:** Every prompt, guideline, and tool description in braid encodes assumptions about what braid is. If those assumptions are inconsistent, no amount of feature work fixes the agent's behavior. The identity blocks, guidelines, and tool descriptions are the agent's operating system — they need to be structured for clarity, not just stuffed with directives.

**2026-07-17 update — Methodology pivot:** The original approach (synthetic A/B testing with subagents and standardized task sets) was discarded. Rationale: synthetic tasks create artificial scenarios that don't reflect real usage patterns. The real signal is in the existing session corpus — 334 sessions, 327MB, spanning April 13 to July 17, 2026. This corpus naturally captures multiple prompt versions.

**CORRECTED timeline (from actual git history, not ROADMAP estimates):**

| Period | Sessions | Prompt version | Key commits |
|--------|----------|----------------|-------------|
| Apr 13 – Jun 12 | 209 | Original prompt-builder | Evolving identity, 17+ directives inline |
| Jun 13 – Jun 22 | 15 | Identity extracted | `46fb6fb` — extract identity into separate file |
| Jun 23 – Jul 1 | 14 | Identity refined (11→8) | `c411087` — 11→8 values, CONCISE_RESPONSES |
| Jul 2 – Jul 15 | 49 | **SCOPES + INTERACTION_STYLE** | `322d2c4`, `77bb0cb`, `aefefc6`, `1399480` |
| Jul 16+ | 17 | 17→5 identity blocks + guidelines + pipeline | `a891693a`, `e3e6e43b`, `53f97c8e` |

**Note:** The ROADMAP's estimated dates (~Jun 10 for identity, ~Jun 20 for guidelines, ~Jul 1 for pipeline) were aspirational. The actual changes all landed on Jul 16-17. The most significant behavioral improvement correlates with the **Jul 2-4 commits** (SCOPES identity, INTERACTION_STYLE, CORRECTION lean directive, behavioral-verification philosophy), which reduced user correction rate by 62% (10.9% → 4.1%).

**Status: COMPLETED.**

### Key findings

**1. User correction rate dropped 62% after Jul 2-4 identity changes**

The SCOPES identity + INTERACTION_STYLE + CORRECTION lean directive + behavioral-verification philosophy (commits `322d2c4`, `77bb0cb`, `aefefc6`, `1399480`) reduced user correction rate from 10.9% to 4.1%. This is the single most impactful prompt intervention to date.

| Prompt version | User correction rate | Sessions |
|----------------|---------------------|----------|
| Original (Apr 13 – Jun 12) | 2.7-10.9% (variable) | 209 |
| Identity extracted (Jun 13-22) | 6.1-9.6% | 15 |
| Identity refined (Jun 23 – Jul 1) | 10.9-15.8% (peak) | 14 |
| SCOPES + INTERACTION_STYLE (Jul 2-15) | **4.1-5.0%** | 49 |
| 17→5 identity blocks (Jul 16+) | 5.2% (n=15) | 17 |

**2. Frequent identity changes cause temporary confusion**

The Jun 22-29 period (15.8% correction rate) was the most active period of prompt development — behavior modes added/removed, identity values fluctuating, directives changing rapidly. Correction rates spike during churn, then normalize after changes settle.

**3. Verification pass rate has been 100% since Jun 08**

This is the **test pass rate** (npm test, npm run typecheck), not the judge verdict rate. The verification judge itself outputs "fail" verdicts regularly (4 times in July sessions alone) — it's catching real issues, not being lenient. The judge is the most reliable component and should NOT be reframed.

**4. Internal prompts are hybrids, not pure directive lists (CORRECTED)**

| Prompt | File | True style |
|--------|------|------------|
| Verification judge | `enforcement/verification-judge.ts` | **Pure directive** |
| Input polisher | `core/input-polisher/consolidated-input-critic.ts` | **Hybrid** |
| Backward checker | `lib/verification/backward-checker.ts` | **Hybrid** |
| Claim critic | `lib/ai/consolidated-claim-critic.ts` | **Hybrid** |
| Harness proposer | `lib/harness/harness-proposer.ts` | **Hybrid** |
| Harness validator | `lib/harness/harness-validator.ts` | **Hybrid** |
| Session analyze | `memory/session-recall/analyze.ts` | **Hybrid** |
| Session query | `memory/session-recall/query.ts` | **Identity-framed** |
| Fresh eyes (think) | `cognitive/metacognition/handlers/think.ts` | **Identity-framed** |

6 of 9 are hybrids (identity opening + directive body). Only 2 are genuinely identity-framed throughout (session query, fresh eyes). The fresh eyes prompt is the best example of pure identity framing.

**5. WORK_ETHIC block causes over-explanation (⚠️ risky fix)**

The INTERACTION_STYLE block reduced tone-mismatch corrections by ~50%. The remaining over-explanation is in the WORK_ETHIC block (6 merged directives). Proposed trim to 3 sentences — but this is risky: the thoroughness directives prevent sloppy mistakes. **Must A/B test before applying.**

**6. Context hygiene has 3 dead thresholds**

`USAGE_WHISPER_SOFT` (40%), `USAGE_WHISPER_ADVISORY` (50%), and `USAGE_WHISPER_WARNING` (60%) are defined in `context-thresholds.ts` but never used by any handler. The enforcement jumps from 30K tokens straight to 75%+ usage. See P3-5 for the proposed progressive cascade.

**7. Tool output pruning mechanism does not exist**

The tool loop detector (`tool-loop-detector.ts`) detects loops at 16+ consecutive same-tool calls but does NOT prune old tool results. The agent accumulates all tool outputs. See P3-6 for the proposed mechanism.

### Proposed prompt diff (WORK_ETHIC trim — untested, proceed with caution)

**Current (6 directives, ~120 words):**
```
WORK_ETHIC: You are methodical and precise. Every concrete identifier must be quoted from source. Guessing a name is a correctness error. Before calling finalize, every done item must carry a verification triple. Before non-trivial work, recall from past sessions via memory. After work producing a reusable insight, store it in memory. Focus on correctness over verboity. State the conclusion first; reasoning comes after, only if it's load-bearing.
```

**Proposed (3 sentences, ~60 words):**
```
WORK_ETHIC: You are methodical and precise. Verify before finalizing, recall from memory before non-trivial work, and store reusable insights. Be concise unless the user asks for details — state the conclusion first, then the reasoning only if it's load-bearing.
```

### Raw data

Full session mining data (correction rates, tool usage patterns, self-correction analysis, enforcement whisper density, verification pass/fail rates by week, and qualitative deep dives) is available in the archived report at `docs/RESEARCH-prompt-structure.md`.

### Methodology

**Indirect evidence mining:** Rather than synthetic A/B testing, the session corpus (334 sessions, Apr 13 – Jul 17) was mined for indirect behavioral signals:

| Signal | What it reveals | How to detect |
|--------|----------------|---------------|
| **User corrections** | Where the prompt led the agent astray | Patterns: "no", "actually", "that's not right", "I meant" |
| **Agent self-corrections** | Prompt-induced confusion | Patterns: "actually, let me...", "wait", "on second thought" |
| **Tool usage patterns** | What the prompt prioritizes | Tool call frequency, selection bias |
| **Verification outcomes** | Quality trends | Pass/fail rate per prompt version |
| **Compaction patterns** | Context management behavior | compress:checkout ratio, threshold at compress |

**Limitations:**
- Small post-change cohort (Jul 16+ has only 17 sessions)
- Confounding variables (task complexity, user mood, model changes)
- Pattern matching noise (~70% precision on correction regex)
- Session sampling (20 per week, not full 334)

**Deliverable:** This P0-1 section in ROADMAP.md contains the consolidated findings. The detailed raw data (correction rate tables, weekly breakdowns, signal extraction methodology, qualitative deep dives, methodology notes and future work) is archived in `docs/RESEARCH-prompt-structure.md`.

---

### P0-2: Philosophical deepening of identity blocks

**Status: SHIPPED 2026-07-17.**

**Why:** P0-1 proved identity framing works (62% reduction in user corrections). The next step was to deepen the framing — not just consolidate directives into identity blocks, but ground those blocks in the philosophical principles discovered during the pi/braid research.

**Philosophical principles (from 2026-07-08 presentation research):**

| Principle | Source | Maps to identity block |
|-----------|--------|----------------------|
| Pi is a minimal harness — every 'no' is an open door | pi's "shape of No" philosophy | IDENTITY_INTRO |
| Braid is the metacognitive layer: verification, memory, reasoning, self-improvement | braid's 5 pillars | IDENTITY_INTRO |
| Systematic over hacky | braid pillar #3 | WORK_ETHIC |
| Verify before done | braid pillar #1 | WORK_ETHIC, SELF_MANAGEMENT |
| Memory as workspace | braid pillar #4 | SELF_MANAGEMENT |
| Truth-seeking over agreeableness | braid pillar #2 | EPISTEMIC_STANCE |

**Evolution path (system prompt identity):**

```
Jun 29: 17 standalone directives → 5 identity blocks (behavioral-guardrails.ts deleted)
  ↓
Jul 16: 5 identity blocks refined (COMMUNICATION merged, CONCISE_RESPONSES merged)
  ↓
Jul 17: 5 identity blocks philosophically deepened, trimmed ~55% word count
         (515 words → 230 words, principled framings, not directive lists)
```

**What changed (identity.ts, Jul 17):**

| Block | Before | After | Key change |
|-------|--------|-------|------------|
| IDENTITY_INTRO | "You are Braid, a generalist operating inside the pi coding agent harness." | + "a minimal harness designed to be extended, not bloated. You add the metacognitive layer: verification, memory, reasoning, and self-improvement." | Added pi's philosophy + braid's purpose |
| WORK_ETHIC | 6 directives, ~120 words | 2 principled sentences, ~50 words | Replaced directive list with "systematic over hacky" + "verify before done" |
| SELF_MANAGEMENT | 6 directives, ~140 words | 3 principled sentences, ~54 words | Replaced directive list with "memory as workspace" framing |
| COMMUNICATION | 3 sentences, ~65 words | 2 sentences, ~41 words | Tightened, removed redundancy |
| EPISTEMIC_STANCE | 5 sentences, ~110 words | 3 principled sentences, ~51 words | Added "truth-seeking over agreeableness" framing, trimmed |

**Total reduction:** 515 words → 230 words (~55% reduction, with added philosophical depth)

**Risk assessment:** Lower risk than P0-1's WORK_ETHIC trim proposal. The trim is paired with principled framing (every block now names the principle it embodies), so the agent trades explicit directives for a coherent philosophical framework. The verification judge, enforcement signals, and verifier tools provide the procedural safety net that the directives previously covered.

**Verification:** Typecheck clean, 42/42 tests pass. Full session test recommended.

---

## P1 — Ship this session

### P1-4: Post-cycle auto-tag + inspect + advisory on yield

**Status: SHIPPED 2026-07-18.**

**Why P1:** After a cycle of work (35+ tool-call turns for 2 user messages), the agent yields with a text-only response. The accumulated tool results stay in context, silently filling the window until the percentage thresholds react. This adds a **structural** hygiene pass at the natural cycle boundary — before the problem reaches 40%.

**Design (minimal risk, zero data loss):**
- Trigger: text-only yield turn after 2+ preceding work turns (edit/write/finalize)
- No archiving or compaction — only tag + inspect + whisper
- 10-turn cooldown to prevent thrashing
- Suppressed during error bursts

**What it does:**
1. Auto-tags the position as `cycle-{turn}` via `sessionManager.setLabel()`
2. Lightweight session inspection: counts assistant/tool/user messages, estimates old tool results (age > 3)
3. Whispers a brief hygiene advisory: suggests `context_compress(action="compact")` when >5 old tool results, or `context_inspect(detail="prune")` when >20 assistant messages

**Implementation:**
- New file: `src/extensions/enforcement/handlers/register-post-cycle-hygiene.ts`
- Priority 1 (lowest — runs after verification judge, analysis handlers, and turn-end-hygiene)
- State: `lastPostCycleHygieneTurn` in `ContextHygieneState`
- Wired via `handler-registry.ts` after `registerTurnEndHygiene`

**Verification:** 42/42 tests pass, typecheck clean, doc checks clean.

**Status: SHIPPED.**

**2026-07-17:** Pipeline guidelines with tool-availability guards added to `prompt-builder/index.ts` (`contextNavigationGuidelines()`).
**2026-07-18:** Tool descriptions updated with "when to use" situational framing (context_navigate, context_compress, context_inspect, context_proposals). Heartbeat policies.ts and context-hygiene.ts modernized from stale old names (context_tag/context_checkout/context_archive) to modern equivalents with pipeline-specific messaging at each threshold. Resources block moved out of Instance section to just before skills XML block.

Verification: All 42 tests pass, typecheck clean.

### P1-2: Compaction speaker attribution

**Status: SHIPPED 2026-07-17.**

**Why P1:** The agent misattributes its own questions as the user's after compaction. This compounds over multiple cycles and degrades conversation quality.

**Three compaction paths, three levels of control:**

1. **`context_compress` tool** (agent-initiated) — agent controls `summary`. Fix: write summaries with explicit speaker labels (`<user>...</user>` / `<agent>...</agent>`).
2. **Auto-compact** (pi-core, threshold) — braid can't control format. Fix: listen to `session_compact` and emit re-attribution whisper.
3. **Overflow force-compact** (pi-core, critical) — same as #2.

**Action:**
1. Update `context_compress` tool to write speaker-labeled summaries
2. Add `session_compact` listener for re-attribution whisper
3. Test all three paths

### P1-3: Session resume flooding

**Status: SHIPPED 2026-07-17.**

**Why P1:** `pi --session <id>` triggers full SESSION_START → discoverability bundle fires again because `globalThis` is process-local. The agent sees the same bundle it already saw before the session was interrupted.

**Fix implemented:** Per-project disk-persisted shown-signals via `~/.pi/agent/braid/shown-signals.json`. When a new process starts for the same project, previously shown discoverability signal types are loaded from disk and skipped. The old `isSignalShown/markSignalShown` (process-global `globalThis`, survives `/reload` only) is complemented by the new `isProjectSignalShown/markProjectSignalShown` (disk-persisted, survives process restart).

**Verification:** 42/42 tests pass, typecheck clean.

## P2 — Next session

### P2-1: Input polisher extraction & identity improvement

**Why P2:** The input polisher is a standalone extension with no braid-specific dependencies. Extraction is straightforward. The identity improvement (proactive user input validation) is a research question that benefits from P0 being settled.

**Extraction to contrib:**
- Dependencies: `llm-call.ts`, `model-resolver.ts`, `language-hint.ts`, `extension-state.ts`, `logger.ts`, `input-critic.ts`, `consolidated-input-critic.ts`
- All replaceable with standalone equivalents or contrib's own logger

**Identity improvement (research):**
- Detect when user input could contain mistakes that invert expectations
- What patterns? (dangerous commands, contradictory requirements, underspecified destructive ops)
- Braid's role: nudge vs block vs ask
- Second stage in input polisher or new lightweight extension

### P2-2: Verification judge deeper fix

**Status: SHIPPED 2026-07-17.**

**Why P2:** The immediate fix (git history context) is shipped but the deeper problem (50-entry tool log window) remains. The judge only sees the last 30 tool log entries, missing early verification evidence on long sessions.

**Fix implemented (hybrid approach):**
- Added `verificationHistory` field to `JudgeContext` — extracts ALL verification-relevant commands (`npm test`, `tsc`, `npm run build`, `jest`, `vitest`) with their output results from the FULL turn history (up to 50 turns), not just the last 30 entries.
- The judge sees both: the last 30 tool log entries (for recent context) AND the full verification history (for definitive verification evidence).
- The system prompt instructs the judge to prefer the VERIFICATION HISTORY section over the TOOL EXECUTION LOG when both are present.

**Verification:** 42/42 tests pass, typecheck clean.

---

## P3 — Deferred

### P3-1: Pi-core compatibility refactoring

**Deferred:** Valuable (reduces prompt bloat via deferred tool loading) but requires P0 identity to be stable first — changing tool descriptions mid-review creates churn.

- Deferred tool loading via `pi.setActiveTools()` (cut active tools from 20→10)
- Version gate for polyfills (replace `as any` patterns)
- `/braid-status` command

### P3-2: Contrib extraction (Tier 1)

**Deferred:** workspace_snapshot + timer extraction. Non-urgent, existing tools work fine in braid.

### P3-3: Scratchpad real-time cross-instance sync

**Deferred:** Designed but not implemented. Requires concurrent access patterns to be tested.

### P3-4: Forward-looking proposals

**Deferred:** Finalization practices, skill discovery, skill quality audit. All require P0 identity to settle first.

### P3-5: Context hygiene progressive thresholds

**Status: SHIPPED 2026-07-18.**

**Why P3:** The infrastructure already exists (3 thresholds in `context-thresholds.ts` were only used by the heartbeat module, not the enforcement pipeline). Wiring them in is low-risk, but the real value requires P0 identity to be stable (context hygiene messages are part of the agent's experience). P0 is now stable.

**Research finding:** `USAGE_WHISPER_SOFT` (40%), `USAGE_WHISPER_ADVISORY` (50%), and `USAGE_WHISPER_WARNING` (60%) are defined in `context-thresholds.ts` and used by the heartbeat context-hygiene module and context-lifecycle policy engine, but were **not wired into the enforcement pipeline** (turn-end-handler.ts, register-turn-end-hygiene.ts, getContextNudgeMessage). The enforcement jumped from 30K/75K token thresholds straight to 75%/80% percentage thresholds, skipping the 40-60% range entirely.

**Cascade now wired in all 3 enforcement paths:**
- 40%: Soft whisper — gentle suggestion to inspect candidates
- 50%: Firm advisory — consider archive, tag position first
- 60%: Hard warning — stronger language, full pipeline
- 75%: Forceful critical — same as before
- 80%: Compact-medium — same as before
- 90%: Auto-compact with pre-save safety net — same as before

**Implementation:**
1. Wired thresholds into `register-turn-end-hygiene.ts` (enforcement whisper)
2. Wired thresholds into `turn-end-handler.ts` (session signals)
3. Wired thresholds into `getContextNudgeMessage()` in `context-hygiene-state.ts`
4. Decreased `contextCheckInterval` from 34 to 15 turns
5. Token-based checks (30K/75K at 8-turn interval) remain as the earlier warning

**Verification:** 42/42 tests pass, typecheck clean, doc checks clean.

### P3-6: Periodic redundant tool output pruning

**Why P3:** Novel mechanism that requires careful design. Low risk technically (pruning old tool results is safe), but the cadence and retention policy need tuning.

**Research finding:** The tool loop detector (`tool-loop-detector.ts`) detects loops at 16+ consecutive same-tool calls but does NOT prune old tool results from context. The agent accumulates all tool outputs over time.

**Proposed mechanism:**
- Add a tool-call counter per turn
- When threshold reached (20-30 calls), prune oldest tool results
- Retain last 10 tool results as a floor
- 1-turn cooldown between prunes

---

## SHIPPED (maintain)

### Session analysis tools (batch, analyze, stats)
**Commit:** 36a0a724, 69dbb6bf, 9b8e1d28
**Status:** Working. No maintenance needed.

### Verification judge immediate fix (git history context)
**Commit:** 2dde7f72
**Status:** Working. Deeper fix deferred to P2-2.

### Enforcement whisper dedup (per-signal)
**Commit:** f4fdb40a
**Status:** Fix #1 shipped. Option #4 (audit other whisper families) in BACKLOG.

### Session resume flooding (P1-3)
**Commit:** ac33d44a, 38af313d
**Status:** Per-project disk-persisted shown-signals. 42/42 tests pass.

### Verification judge deeper fix (P2-2)
**Commit:** (pending)
**Status:** Hybrid verification history — full session verification commands + last 30 tool log entries. 42/42 tests pass.

### System architecture deep dive
**Status:** Complete. Key findings documented in HISTORY.md.

### pi-core 0.80.8 → 0.80.9 compatibility
**Status:** Verified. No breaking changes. Documented in CHANGELOG.

### Skills section polish (line counts + name-description XML)
**Commit:** (pending)
**Status:** Upper Resources block now groups skills by directory with precise line counts per SKILL.md. Lower `<available_skills>` XML reduced to just name + description (XML wrapping kept for safety against bad description content; location and line counts moved to the upper block as clean plain text). System prompt size reduced from ~18,979 chars to ~16,720 chars. 42/42 tests pass.

---

## BACKLOG (research needed)

### Finalize tool self-contradiction (unpersisted learnings vs. no-tool-calls)

**Observation:** The `finalize` tool's output contains a direct contradiction:

```
📚 4 unpersisted learning(s). Call memory_store(...) now to preserve them across sessions

[ok] Auto-proceed to next task.

IMPORTANT: DO NOT call any tools after this message.
```

The tool instructs the agent to call `memory_store` (a tool call), then immediately forbids tool calls. The agent cannot comply with both directives. This creates a structural problem:

- If the agent obeys the first instruction: it violates the no-tool-calls directive.
- If the agent obeys the second: unpersisted learnings are lost on shutdown.
- If the agent calls `memory_store` *before* finalize: it can't know what learnings finalize will report.

**Possible resolutions (research needed):**
1. **finalize auto-persists learnings** — add a `memory_store` call inside finalize's implementation so the tool does both steps atomically.
2. **Drop the unpersisted-learnings block** — memory_store is the agent's responsibility; finalize shouldn't nag about it.
3. **Soft vs. hard constraints** — make "no tool calls" a guideline (SHOULD NOT) rather than an absolute (MUST NOT), so the agent can persist learnings on the finalize turn.

**Research needed:** Which resolution best aligns with braid's philosophy and practical agent behavior?

### Full Braid critical review
Subagent-assisted audit of every subsystem, skill, doc, and convention. High effort, high reward. Requires P0 identity as reference.

### Braid-whisper hint investigation
Hints fire on every `/reload` with generic advice. Determine if they provide value or should be removed.

### System prompt visibility
The fully constructed prompt is invisible (not in session files, not in RPC). Add debug endpoint or whisper dump.

### Enforcement whisper dedup audit (option #4)
Audit heartbeat, three-memory-stores, tool-loop, and enforcement whisper families for the same dedup pattern.

### Multi-agent coordination research
Concurrent scratchpad access, conflict resolution, cross-instance communication. Requires scratchpad sync (P3-3) to be implemented first.

### System prompt structure research (P0-1)
Session-mining investigation into optimal prompt structure: identity framing vs directive lists, guideline density, ordering effects (guidelines before tools), and context navigation pipeline effectiveness. See P0-1 for the session-mining methodology. High value: could produce measurable improvements in agent behavior across all tasks.

---

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)
- [`CHANGELOG.md`](../CHANGELOG.md) — release notes

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Reprioritized into P0-P3 + BACKLOG structure on 2026-07-16.
Every shipped item verified: 42/42 tests pass, typecheck clean.