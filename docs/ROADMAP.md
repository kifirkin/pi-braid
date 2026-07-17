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

**2026-07-17 update — Methodology pivot:** The original approach (synthetic A/B testing with subagents and standardized task sets) was discarded. Rationale: synthetic tasks create artificial scenarios that don't reflect real usage patterns. The real signal is in the existing session corpus — 333 sessions, 327MB, spanning April 21 to July 17, 2026. This corpus naturally captures multiple prompt versions:

| Period | Prompt version | Key change |
|--------|---------------|------------|
| ~Apr 21 – ~Jun 10 | Original | 17 standalone directives, no identity section, guidelines inline |
| ~Jun 10 – ~Jun 20 | Consolidated identity | 5 identity blocks under `## Identity` heading (a891693a) |
| ~Jun 20 – ~Jul 1 | Guidelines extracted | Guidelines moved before tools, separate sub-functions (e3e6e43b) |
| ~Jul 1 – Jul 16 | Pipeline added | Context navigation pipeline with tool-availability guards (53f97c8e) |
| Jul 16+ | Current | Pipeline wisdom embedded in code, checkout auto-summary |

Each version boundary is a natural experiment. The corpus lets us compare the same user (you) interacting with the same agent (braid) under different prompt structures, and infer what works from indirect behavioral signals.

**Current state (post 2026-07-16 session):**
- Identity blocks consolidated from 17 directives to 5 character traits under `## Identity` heading
- Guidelines extracted into separate section before tools (pi-core pattern)
- Context navigation pipeline guidelines added with tool-availability guards
- Tool descriptions updated with "when to use" framing
- Each guideline family is a separate sub-function (file tools, communication, context navigation)
- Pipeline wisdom embedded in tool implementations (nextStep in details)
- Checkout auto-summary with smart content selection

**Methodology — indirect evidence mining instead of A/B testing**

Rather than running synthetic tasks, we mine the session corpus for indirect signals that reveal prompt structure effectiveness:

| Signal | What it reveals | How to detect |
|--------|----------------|---------------|
| **User corrections** | Where the prompt led the agent astray | Patterns: "no", "actually", "that's not right", "I meant", user rewrites the agent's output |
| **User tone shifts** | Friction points, frustration, impatience | Patterns: shortened responses, directive tone, repetition of same request, "just do X", dismissive language |
| **Agent self-corrections** | Prompt-induced confusion, uncertainty | Patterns: "actually, let me...", "wait", "on second thought", backtracking, abandoned tool chains |
| **Agent tool usage patterns** | What the prompt prioritizes (or doesn't) | Tool call frequency, tool selection bias, unnecessary bash vs targeted tool usage, premature task switching |
| **Agent planning depth** | Whether the prompt encourages structured thinking | `think` tool usage frequency, scratchpad detail level, plan item granularity, verification before action |
| **Verification judge outcomes** | Quality trends over time | Pass/fail rate per prompt version, false positive rate, types of failures caught vs missed |
| **Compaction patterns** | Context management behavior | compress:checkout ratio, agent-initiated compress frequency, context threshold at compress time |
| **Task completion patterns** | What the prompt enables vs hinders | Session length, turns-to-completion, abandoned tasks, multi-step task success rate |

**Research questions (reformulated for session mining):**

1. **Does guidelines-before-tools improve agent behavior?** Compare sessions before vs after commit e3e6e43b. Look for: reduction in unnecessary bash calls, more targeted tool selection, fewer user corrections about tool misuse. The natural experiment: the same agent, same user, same project — only the prompt structure changed.

2. **Does identity framing beat directive lists?** Compare sessions before vs after commit a891693a (17 directives → 5 identity blocks). Look for: fewer user corrections about agent behavior, fewer agent self-corrections, smoother task progression. The archaeology finding says identity works — but does the session data confirm it?

3. **What is the optimal guideline density?** The prompt went from ~0 guidelines (inline) to ~12 (3 families) to ~8 (condensed). Compare cohorts. Look for: correlation between guideline density and user correction rate, agent self-correction rate, task completion rate. Too many guidelines create cognitive load; too few leave gaps.

4. **Does the context navigation pipeline reduce agent-initiated compaction?** Compare sessions before vs after commit 53f97c8e. Measure compress:checkout ratio. Does the pipeline actually change behavior, or is it just documentation?

5. **What's the relationship between prompt structure and session quality?** Across all 333 sessions, can we predict session quality (user satisfaction, task completion, verification pass rate) from prompt structure? This is the meta-question that ties everything together.

**Analysis pipeline:**

1. **Cohort definition** — Tag each session by the prompt version active at its timestamp. Build 4-5 cohorts.

2. **Signal extraction per cohort** — For each cohort, run:
   - `session action=analyze` with targeted questions (did the user correct the agent? how many times? what kind?)
   - `session action=batch` for pattern matching on specific signals (correction phrases, tool usage patterns, compaction events)
   - `session action=search` for keyword-based signal discovery
   - Episodes search for recurring patterns

3. **Cross-cohort comparison** — Compare signal frequencies across cohorts. Which prompt version has the lowest correction rate? Highest task completion rate? Best verification outcomes?

4. **Signal correlation** — Do multiple signals agree? (e.g., lower correction rate + higher task completion + better verification = strong evidence). Do they conflict? (e.g., fewer corrections but more abandoned tasks = prompt makes agent less assertive, which is bad).

5. **Qualitative deep dive** — For the most and least effective prompt versions, read representative sessions. What does the interaction *feel* like? The quantitative signals tell you what happened; the qualitative tells you why.

6. **Synthesis** — What specifically worked? (e.g., "identity blocks reduced corrections about tone by 40%" not "identity framing is better"). The deliverable is actionable findings, not philosophy.

**Success criteria:**
1. Each prompt version cohort has at least 20 analyzable sessions (enough for signal comparison)
2. At least 3 signals show statistically distinguishable differences between cohorts
3. At least 1 actionable finding that directly informs a prompt improvement (not "identity is better" but "the WORK_ETHIC block causes agent to over-explain — trim to 2 sentences")
4. Findings are grounded in specific session excerpts, not abstract reasoning
5. The research produces a concrete prompt diff that improves the next session

**Extension — braid's internal system prompts review:**

P0-1's scope extends beyond the agent system prompt to braid's own internal prompts. These 9 prompts are themselves subject to the same quality concerns — they're directive lists where identity framing might work better:

| Prompt | File | Current style |
|--------|------|---------------|
| Verification judge | `enforcement/verification-judge.ts` | Directive list — "Evaluate whether..." |
| Input polisher | `core/input-polisher/consolidated-input-critic.ts` | Directive list — "Polish user input..." |
| Session analyze | `memory/session-recall/analyze.ts` | Directive list — "You are analyzing..." (partial identity) |
| Session query | `memory/session-recall/query.ts` | Directive list — "You are analyzing..." (partial identity) |
| Fresh eyes (think) | `cognitive/metacognition/handlers/think.ts` | Identity-framed — "You are a sharp, critical thinker..." |
| Backward checker | `lib/verification/backward-checker.ts` | Directive list — "Check if..." |
| Claim critic | `lib/ai/consolidated-claim-critic.ts` | Directive list — "Evaluate truthfulness..." |
| Harness proposer | `lib/harness/harness-proposer.ts` | Directive list — "Generate test harness..." |
| Harness validator | `lib/harness/harness-validator.ts` | Directive list — "Validate test harness..." |

**Research questions for internal prompts:**

1. **Does identity framing improve internal prompt effectiveness?** The fresh eyes prompt (identity-framed) is the outlier — does it produce better output than the directive-list prompts? If so, can we reframe the others?

2. **What's the relationship between internal prompt quality and agent behavior?** If the verification judge's prompt is weak, it produces false positives/negatives, which degrades the agent's feedback loop. The internal prompts are the agent's operating system — they need the same care as the surface prompt.

3. **Can the session corpus reveal internal prompt issues?** Verification judge false positives (like flagging documentation-only changes as unverified) are visible in sessions. The rate of such false positives across prompt versions is measurable.

**Methodology:** The same session-mining approach applies. The verification judge's output is visible in sessions — we can measure its false positive rate, the types of issues it flags, and how its behavior changed across versions. The other internal prompts are less visible externally but can be evaluated through their outputs (analysis quality, suggestion quality, etc.).

**Deliverable:** Research report in `docs/RESEARCH-prompt-structure.md` containing:
- Cohort definitions and session counts
- Signal extraction methodology and raw results
- Cross-cohort comparison with signal agreement analysis
- Representative session excerpts for each finding
- Actionable prompt diff with expected impact
- Updated prompt based on findings
- **Addendum: Internal prompts audit** — current state of each internal prompt, assessment of directive-list vs identity-framing effectiveness, recommended reframes for top 3 candidates

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