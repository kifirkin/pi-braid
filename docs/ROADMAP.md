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

### P0-1: System prompt structure research (replaces soul.md)

**Why P0:** Every prompt, guideline, and tool description in braid encodes assumptions about what braid is. If those assumptions are inconsistent, no amount of feature work fixes the agent's behavior. The identity blocks, guidelines, and tool descriptions are the agent's operating system — they need to be structured for clarity, not just stuffed with directives.

**2026-07-16 update:** Soul.md approach deemed excessive. The goal is empirical research into prompt structure, not philosophical grounding. What matters: does the structure measurably improve agent behavior? Pi's philosophy ("primitives, not features", minimal core, identity-driven) provides a design direction, but the structure must be validated experimentally.

**Current state (post 2026-07-16 session):**
- Identity blocks consolidated from 17 directives to 5 character traits under `## Identity` heading
- Guidelines extracted into separate section before tools (pi-core pattern)
- Context navigation pipeline guidelines added with tool-availability guards
- Tool descriptions updated with "when to use" framing
- Each guideline family is a separate sub-function (file tools, communication, context navigation)

**Grounding research questions:**

1. **Does guidelines-before-tools improve agent behavior?** pi-core's native pattern puts guidelines before tools. Braid now matches this. Hypothesis: guidelines seen first prime the agent's approach before the tool listing creates option bias. Test: A/B comparison with old ordering using standardized task set.

2. **Does identity framing beat directive lists?** The archaeology finding suggests identity framing ("You are...") outperforms explicit directives ("Do X..."). Hypothesis: the 5 identity blocks produce better behavioral coverage than the original 17 directives. Test: measure behavioral compliance in standardized scenarios with both prompt versions.

3. **What is the optimal guideline density?** Too many guidelines create cognitive load; too few leave gaps. Hypothesis: 8-12 guidelines organized into 3 families (file tools, communication, context navigation) is the sweet spot. Test: vary guideline count and measure agent task completion quality.

4. **Does the context navigation pipeline reduce agent-initiated compaction?** Hypothesis: with clear pipeline guidelines and nextStep details, the agent uses navigate instead of compress. Test: measure compress:checkout ratio before and after pipeline introduction.

**Experimental design:**

1. **Baseline capture:** Run a standardized task set (10 tasks across 3 domains) with the current prompt. Record: task completion rate, tool usage patterns, turns-to-completion, verification judge pass rate.

2. **Variant A — Structure:** Identity → Guidelines → Tools (current). Same content, different ordering. Measure against baseline.

3. **Variant B — Density:** Strip guidelines to 5 essentials. Measure against baseline.

4. **Variant C — Identity reframe:** Rewrite identity blocks as pure character (no behavioral directives). Move all behavioral content to guidelines. Measure against baseline.

5. **Analysis:** For each variant, compute: behavioral compliance (did the agent follow the guidelines?), tool efficiency (right tool for the job?), output quality (verification judge pass rate).

**Success criteria:**
1. At least one variant shows statistically significant improvement over baseline on verification judge pass rate
2. Tool efficiency improves (fewer unnecessary bash calls, more targeted tool usage)
3. Agent-initiated compress calls drop by >50% with pipeline structure
4. Results are reproducible across 3+ trials per variant

**Deliverable:** Research report in `docs/RESEARCH-prompt-structure.md` + updated prompt based on findings.

---

## P1 — Ship this session

### P1-1: Context navigation pipeline (system prompt + tool availability guards)

**Why P1:** This is the highest-impact change for day-to-day session quality. The agent needs a proper context navigation pipeline in the system prompt, with tool availability guards matching pi-core's native pattern. The pipeline wisdom is embedded in the tool implementations themselves: each tool's `details` output includes `nextStep` suggestions for the pipeline (tag → archive → inspect), and the heartbeat whisper suggests pipeline-specific actions at context thresholds.

**Core loop:**
```
context_navigate(action='tag', name='checkpoint-N')  → save position
context_navigate(action='checkout', target='<tag>')    → jump to checkpoint
context_compress(action='archive', beforeTag='<tag>')  → free space
context_inspect(detail='quick')                        → verify health
```

**When to use which tool:**

| Situation | Tool | Action |
|-----------|------|--------|
| Starting complex work | `context_navigate` | `action='tag', name='before-<task>'` |
| Context > 50% | `context_compress` | `action='archive', beforeTag='last-checkpoint'` |
| Context > 70% | `context_compress` | `action='compact', keep=10` |
| Lost in history | `context_navigate` | `action='log'` then `action='checkout'` |
| Before risky operation | `context_navigate` | `action='tag', name='before-<op>'` |
| After any checkpoint | `context_inspect` | `detail='quick'` |
| Session feels bloated | `context_inspect` | `detail='prune'` then act on candidates |

**Implementation (single file: `prompt-builder/index.ts`):**
- Add context tool availability checks: `hasContextNavigate`, `hasContextCompress`, `hasContextInspect`
- Add pipeline guidelines block gated on those checks (pi-core pattern)
- Update each context tool's `description` with "when to use" framing

**Implementation order:**
1. Add context tool availability checks + pipeline guidelines to `toolsSection()` in `prompt-builder/index.ts`
2. Update `context_navigate` description with "when to use" framing
3. Update `context_compress` description with "when to use" framing
4. Update `context_inspect` description with "when to use" framing
5. Update heartbeat whisper with pipeline-specific suggestions at 50%/70%/85% thresholds
6. Run typecheck + tests (42/42)
7. Commit: `feat: add context navigation pipeline with tool availability guards`
8. Test: run a full session using only navigate, no agent-initiated compress

**Deep research findings:**

1. **Can navigate replace agent-initiated compaction?** — Hypothesis: with proper tagging discipline, the agent can always jump back to a known-good state, eliminating the need for agent-initiated `context_compress`. Only pi-core auto-compact and overflow force-compact remain. Needs testing: track tags per session, monitor whether agent hits auto-compact threshold.

2. **Tagging discipline** — Good tags describe what you're about to do (`before-refactor-X`), not what you've done (`checkpoint-3`). Bad tags are meaningless names (`tag-1`, `tag-2`) or generic labels that get overwritten. Guideline: "Tags should describe what you're about to do, not what you've done."

3. **Deferred tool loading interaction** — If context tools are deferred, pipeline guidelines are hidden until the agent activates them. Chicken-and-egg problem: the agent needs to know about context tools before they're active. Solution: keep `context_navigate` always active, defer only `context_compress` and `context_inspect`.

4. **Heartbeat whisper integration** — The heartbeat whisper fires at context thresholds. It should suggest specific pipeline actions:
   - At 50%: "Consider: context_navigate(action='tag', name='before-cleanup') then context_compress(action='archive', beforeTag='before-cleanup')."
   - At 70%: "Consider: context_compress(action='compact', keep=10)."
   - At 85%: "Context critical. Use context_navigate(action='checkout') to a recent checkpoint, or context_compress(action='compact', keep=5)."

**Open questions:**
1. Should the pipeline live in `identity.ts` (as a "Context Manager" trait) or `toolsSection()` (as guidelines)? Decision: toolsSection — the pipeline is a strategy, not a character trait.
2. Should the heartbeat whisper use `triggerTurn: true` at critical levels (85%)? Currently `triggerTurn: false` (advisory), but at 85% the agent might not see it before a crash.
3. Should `context_proposals` be part of the pipeline? No — proposals are about auto-generated suggestions, not agent-initiated navigation.

**Success criteria:**
1. Agent tags before every major operation in a session
2. Agent uses `context_navigate(action='checkout')` to explore branches instead of letting context grow
3. Agent-initiated `context_compress` calls drop by >80%
4. Context stays below 70% without agent-initiated compaction
5. Pipeline is documented in the system prompt with tool-availability guards
6. All 42 tests pass, typecheck clean

**Deliverable:** `prompt-builder/index.ts` changes + updated tool descriptions + heartbeat whisper integration.

### P1-2: Compaction speaker attribution

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

**Why P1:** `pi --session <id>` triggers full SESSION_START → discoverability bundle fires again because `globalThis` is process-local. The agent sees the same bundle it already saw before the session was interrupted.

**Proposed fixes:**
1. Persist `shownSignals` to disk (append-only JSONL) so they survive restart
2. Or: skip discoverability bundle entirely on resume
3. Or: reduce to single line ("Resuming session. Use scratchpad for prior state.")

**Action:**
- Investigate: how does `pi --session` trigger SESSION_START vs fresh start?
- Implement fix: persist shown signals, or skip bundle on resume

### P1-2: Compaction speaker attribution

**Why P1:** The agent misattributes its own questions as the user's after compaction. This compounds over multiple cycles and degrades conversation quality.

**Three compaction paths, three levels of control:**

1. **`context_compress` tool** (agent-initiated) — agent controls `summary`. Fix: write summaries with explicit speaker labels (`<user>...</user>` / `<agent>...</agent>`).
2. **Auto-compact** (pi-core, threshold) — braid can't control format. Fix: listen to `session_compact` and emit re-attribution whisper.
3. **Overflow force-compact** (pi-core, critical) — same as #2.

**Action:**
1. Update `context_compress` tool to write speaker-labeled summaries
2. Add `session_compact` listener for re-attribution whisper
3. Test all three paths

---

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

**Why P2:** The immediate fix (git history context) is shipped but the deeper problem (50-entry tool log window) remains. Requires P0 identity to be settled (judge should embody braid's truth-first epistemology).

**Deeper investigation:**
- Multi-round analysis: if tool log too long, request more context in second round
- Chunked analysis: split into chunks, analyze each, aggregate
- Hybrid: git history + tool log excerpts + sliding window
- Track false positive rate

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

### System architecture deep dive
**Status:** Complete. Key findings documented in HISTORY.md.

### pi-core 0.80.8 → 0.80.9 compatibility
**Status:** Verified. No breaking changes. Documented in CHANGELOG.

---

## BACKLOG (research needed)

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
Empirical investigation into optimal prompt structure: identity framing vs directive lists, guideline density, ordering effects (guidelines before tools), and context navigation pipeline effectiveness. See P0-1 for full experimental design. High value: could produce measurable improvements in agent behavior across all tasks.

---

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)
- [`CHANGELOG.md`](../CHANGELOG.md) — release notes

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Reprioritized into P0-P3 + BACKLOG structure on 2026-07-16.
Every shipped item verified: 42/42 tests pass, typecheck clean.