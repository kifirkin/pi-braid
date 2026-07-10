<!-- status: historical -->

# pi-braid History

Consolidated project history. Sprint milestones, shipped items,
archived roadmap content, and closed research documents are preserved
here for reference.

> **Note:** The full git history was collapsed into a single initial
> commit on 2026-07-10. See `CHANGELOG.md` for per-release notes.

---

## Sprint 1 — Quick Wins (QW-1, QW-2, QW-3)

- **QW-1**: Restored contrast phrase library (4 phrases: TRUTH_FIRST, ANTI_SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY). Backed by RepE (2310.01405) and BeHonest (2406.13261).
- **QW-2**: Wired PLANNING mode to real enforcement signal (toolsSinceLastPlan counter, replaces startup-only detection).
- **QW-3**: Added COMPLETION detection on session shutdown (checks totalToolCalls > 0 && lastFinalizeNudge === -100).

## Sprint 2 — MARS + Truth-Seeking (MI-1, MI-2)

- **MI-1**: MARS upgrade to principle+procedure reflection. New `mars-reflector.ts` with two reflection types. Principles stored as heuristics, procedures as episodes.
- **MI-2**: Truth-Seeking signal for CONTRAST mode detection. Added truth_seeking_trigger signal key, wired into determineContrastMode().

## Sprint 3 — LP-1 Phase 1 + MI-3

- **LP-1 Phase 1**: Failure trace collector + weakness miner wired into heartbeat evolver. Collects from tool-loop-detector, error-tracking, validation failures. Clusters by type+tool, computes severity.
- **MI-3**: Structured Output Catalyst for tool results (format-tool-result.ts).

## Sprint 4 — LP-1 Phase 2+3 + LP-2

- **LP-1 Phase 2**: Harness proposer — generates K=3 candidate edits per actionable weakness cluster. Test: 22 assertions.
- **LP-1 Phase 3**: Harness validator — LLM-as-judge validator with Pareto acceptance rule. Test: 32 assertions.
- **LP-2**: Bidirectional Verifier — forward tracer (import-graph analysis), backward checker (LLM-as-judge), coordination checker (stale derived files). Test: 54 assertions.

## Sprint 5 — LP-3 + SI-1 + pi-ai compat + polish

- **LP-3**: Memory Leak Prevention — cross-project session isolation with provenance tracking (projectId on every memory entry, project-scoped recall filtering, cross-project conflict detection).
- **SI-1**: Heartbeat as Unified Event Bus — migrated ad-hoc events to typed event bus (10 typed event types, 14+ emitter sites, 8 listener sites).
- **pi-ai v0.80 compat**: Models holder infrastructure (global-state.ts getModels/setModels, models-init.ts initModels), lazy-resolve with compat fallback.
- **Polish**: Evaluation extraction to pi-braid-evaluation, session log mining (2,399 sessions), project root cleanup, ROADMAP consolidation (2,582→28 lines), config cleanup, docs consolidation.

---

## Archived ROADMAP content

The following sections were consolidated from the original ROADMAP.md
(2,582 lines, marked `forward-looking`). All items below are shipped
or superseded unless noted.

### Code quality remediation (6 rounds, Q1–Q15)

All shipped. See `../pi-braid-evaluation/docs-archive/CODE-QUALITY-REMEDIATION-PLAN.md`.

### Cast cleanup (CASTS-AUDIT)

Original: 10 casts (4 documented + 6 missed). All resolved.
See `../pi-braid-evaluation/docs-archive/CASTS-AUDIT.md`.

### Tool inventory (30→25 tools)

Most cut/merge recommendations shipped. Current state in `extensions/manifest.ts`.
See `../pi-braid-evaluation/docs-archive/TOOL-INVENTORY-AUDIT.md`.

### Large file decomposition (P2-10)

All 4 file splits shipped.
See `../pi-braid-evaluation/docs-archive/P2-10-LARGE-FILE-DECOMPOSITION.md`.

### Enforcement whisper audit (EW-7 proposals)

15 proposals. All tracked in ROADMAP §4. Most shipped.
See `../pi-braid-evaluation/docs-archive/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md`.

### 36 deep review findings

4 critical, 12 medium, 20 low. All addressed across sprints 3–5.

### Autonomous remediation passes (v1.0–v3.9 + SPQ-1)

Multiple passes: unused imports, unused locals, module-level let violations,
missing error handling, stale logger patterns, doc status markers, silence
violations, class→type conversions, ts-expect-error justifications,
unused catch clauses, async/await patterns, as-cast deduplication.

---

## Fragile Heuristics Inventory (closed)

**76 heuristics classified A/B/C/D.** All 17 A-class (accuracy-critical)
and 12 B-class (categorical) replacements shipped via `tierPolicy: "always-llm"`
and `tierPolicy: "fallback-only"` in `text-classifier.ts`. The heuristic
fallback functions remain in `critic-registry.ts` as inert legacy code.

**Key learnings**: Hand-coded heuristics (regex, string-match, keyword-map)
are bad practice. Replace with LLM critic or classifier calls. The
text-classifier's three-tier fallback (heuristic → utility model → session
model) provides a clean migration path.

## Critic Consolidation (P0-B, closed)

**31 named classification prompts** in `critic-registry.ts` were consolidated
into batched structured-output calls. Phase 1 (Claim Verification: 3→1)
shipped 2026-07-04. All groups now use tiered fallback with utility model
as primary, session model as fallback.

## Braid Archaeology (closed)

**Prompt evolution timeline, lost features, research findings.** Traces
pi-braid's lineage from pi-mono (March 2026) through the current codebase.
Key findings:

- **Prompt evolution**: 4 major rewrites from March–June 2026, each
  reducing token count and increasing specificity. The identity-framing
  approach (descoped, anti-sycophancy, contrast-based) outperforms
  explicit directives.
- **Lost features**: 6 features were implemented then deleted (value
  statements, explicit behavior modes, tool-specific instructions, etc.).
  Most deletion was intentional (collapsing complexity).
- **Research findings**: Identity framing beats explicit directives
  (documented in all 4 prompt versions). Compliance theater and implicit
  framing are distinct failure modes with different mitigations.
- **Active research threads**: Implicit framing detection, compliance
  pressure measurement, contrast-based identity stability.

## Improvement Proposals (closed)

**All 11 proposals shipped.** Derived from the archaeology report, organized
by impact/effort:

- **Quick wins** (<2h): QW-1 (contrast phrases), QW-2 (PLANNING mode),
  QW-3 (COMPLETION detection) — all shipped.
- **Moderate** (2-6h): MI-1 (MARS reflection), MI-2 (Truth-Seeking),
  MI-3 (Structured Output Catalyst) — all shipped.
- **Large** (1-3d): LP-1 Phase 1-3 (Self-Harness Loop), LP-2 (Bidirectional
  Verifier), LP-3 (Memory Leak Prevention) — all shipped.
- **Strategic** (3-5d): SI-1 (Heartbeat Event Bus) — shipped.

## D-57: Enforcement Whisper Audit (closed)

**Audit of all 35 enforcement whisper templates.** Key findings:

1. **Tool descriptions are the right surface for usage instructions.**
   The agent reads them on every tool call. Runtime whispers add noise.
2. **Runtime detection is only justified for emergent patterns.** Error
   bursts, tool loops, context usage, orphan chains — these cannot be
   predicted.
3. **Safety nets are valid.** Missing-verification and context-usage
   signals are safety nets that fire infrequently.
4. **State tracking should be preserved even when whispers are removed.**
   Cooldown counters and analytics fields feed `determineContrastMode()`
   and MARS analysis.

**Final tally**: 21 whispers removed, 14 retained (3 for emergent patterns,
6 as safety nets, 5 for state tracking). 12 files touched.

---

## Key shipped architecture decisions

- **No module-level `let`** for stateful data. Use `getExtensionState(ctx, key, factory)`.
- **Event bus** over `pi.emit`/`pi.events.on` for cross-extension communication.
- **Models holder** over direct compat import for LLM access.
- **Project-scoped memory** with provenance tracking for cross-project isolation.
- **S-MMU-style context lifecycle** (proposals, compaction, rotation).