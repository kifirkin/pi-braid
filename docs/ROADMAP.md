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

### P0-1: Prompt review & soul.md

**Why P0:** Every prompt, guideline, and tool description in braid encodes assumptions about what braid is. If those assumptions are inconsistent, no amount of feature work fixes the agent's behavior. The identity blocks are currently behavioral directives ("do X, do Y") — not a character. The prompts don't guard against the same patterns of mistakes LLMs make (recency bias, confirmation bias, pattern matching over reasoning). This must be settled before any prompt-level work.

**Scope:** Audit every prompt in the system against a consistent philosophical framework:

| Prompt | Location | Lines | Current weakness |
|--------|----------|-------|-----------------|
| Identity blocks (5) | `identity.ts` | ~1500 chars | Behavioral directives, not character |
| Tools section | `prompt-builder/index.ts` | ~80 lines | Redundant with tool descriptions |
| Guidelines | `prompt-builder/index.ts` | ~20 lines | Generic, no strategy |
| think tool | `handlers/think.ts` | ~50 lines (schema) | Parameter-heavy, no "when to use" |
| verify tool | `handlers/verify.ts` | ~30 lines | Overlaps with finalize |
| hypothesize tool | `handlers/hypothesize.ts` | ~20 lines | Good promptSnippet, weak description |
| finalize tool | `handlers/finalize.ts` | ~30 lines | Good overall |
| verification judge | `enforcement/verification-judge.ts` | ~100 lines | False positive pattern documented |
| context_compress | `context-compress.ts` | ~20 lines | Good pipeline description |
| context_navigate | `context-navigate.ts` | ~20 lines | Good, but no "when to use vs compress" |
| context_inspect | `context-inspect.ts` | ~20 lines | Good |
| Skills (7) | `skills/*/SKILL.md` | varies | Uneven quality |

**Method:**
1. Write `soul.md` — a grounding document that defines braid's philosophy. Not what to do, but why. Core principles: truth-first epistemology, minimalism (pi way), precision over speed, identity over directives.
2. Review every prompt against soul.md. Flag inconsistencies.
3. Rewrite identity blocks as character traits, not rule checklists.
4. Rewrite tool descriptions with "when to use" guidance, not just "what it does."
5. Add cognition tool guidelines: "Use think for exploration, verify for confirmation, hypothesize for debugging, finalize for closure."

**Deliverable:** `docs/soul.md` + updated `identity.ts` + updated tool descriptions.

---

## P1 — Ship this session

### P1-1: Context navigation pipeline (system prompt + tool availability guards)

**Why P1:** This is the highest-impact change for day-to-day session quality. The agent needs a proper context navigation pipeline in the system prompt, with tool availability guards matching pi-core's native pattern. See `docs/CONTEXT-NAVIGATION-PIPELINE.md` for the full design.

**Core loop:**
```
context_navigate(action='tag', name='checkpoint-N')  → save position
context_navigate(action='checkout', target='<tag>')    → jump to checkpoint
context_compress(action='archive', beforeTag='<tag>')  → free space
context_inspect(detail='quick')                        → verify health
```

**Implementation (single file: `prompt-builder/index.ts`):**
- Add context tool availability checks: `hasContextNavigate`, `hasContextCompress`, `hasContextInspect`
- Add pipeline guidelines block gated on those checks (pi-core pattern)
- Update each context tool's `description` with "when to use" framing

**Deep research questions (in `docs/CONTEXT-NAVIGATION-PIPELINE.md`):**
- Can navigate replace agent-initiated compaction?
- Tagging discipline design (good tags vs bad tags)
- Integration with deferred tool loading
- Integration with heartbeat whisper

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

---

## Companion documents

- [`docs/soul.md`](soul.md) — **proposed.** Braid's philosophical foundation. Not yet written.
- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)
- [`CHANGELOG.md`](../CHANGELOG.md) — release notes

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Reprioritized into P0-P3 + BACKLOG structure on 2026-07-16.
Every shipped item verified: 42/42 tests pass, typecheck clean.