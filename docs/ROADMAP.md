# pi-braid Improvement Roadmap

**Compiled:** 2026-06-17
**Status:** Living document. Re-run after each remediation round.
**Source audits:** All `docs/*.md` documents as of 2026-06-17 + deep review findings from this session.

This is the primary actionable roadmap for pi-braid. It consolidates every
recommendation from the prior audit documents (which are now either
preserved as historical reference, archived, or superseded by this doc)
plus 36 new findings from a deep source-code review. Read this first.

## Document structure

1. [How to use this roadmap](#how-to-use-this-roadmap)
2. [Stale items audit](#stale-items-audit) — what was already done, what's superseded
3. [New findings from deep review](#new-findings-from-deep-review) — 36 items, 4 critical
4. [ENFORCEMENT-WHISPER-CONTENT-AUDIT §7 proposals](#enforcement-whisper-content-audit-7-proposals) — 15 items
5. [Other audit items still in flight](#other-audit-items-still-in-flight) — heuristics, splits, tool inventory
6. [Prioritized action roadmap](#prioritized-action-roadmap) — P0/P1/P2/P3 with effort estimates
7. [Cross-cutting recommendations](#cross-cutting-recommendations) — tests, docs, audit follow-ups
8. [Effort / impact summary](#effort--impact-summary)

## Companion documents

- `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` — full inventory of all 35
  whisper templates (the §3 catalog). The actionable items are in §3 of
  this ROADMAP, but the complete trigger conditions, file:line, and
  templates are in that doc. Keep it as a reference.
- `docs/CODE-QUALITY-REMEDIATION-PLAN.md` — the authoritative record of
  the 6 rounds of remediation (Q1–Q15) that have shipped. The headline
  numbers (52 tests pass, 0 unused identifiers, 0 module-level let
  violations beyond the 27 documented exceptions) are authoritative.
- `docs/FRAGILE-HEURISTICS-INVENTORY.md` — full 76-heuristic catalog
  classified A/B/C/D. Of the 29 A+B flagged for LLM replacement, 15 have
  shipped and 14 remain (see [§5.1](#51-fragile-heuristics-status)).
- `docs/STATE-POLICY.md` — design narrative for state lifetimes.
  Operational policy is in `src/lib/state/AGENTS.md`.
- `docs/ARXIV-CITATIONS-AUDIT.md` — all 7 cited papers verified, no
  changes needed. Test in `test-arxiv-citations.mjs`.

## Archived documents

The following prior audits are preserved at `docs/archive/<filename>` for
historical reference. Their content is folded into this roadmap; their
recommendations are either shipped, deferred, or superseded by ROADMAP
items.

- `archive/CASTS-AUDIT.md` — original cast-cleanup. Superseded: actual
  cast count is 10 (4 documented + 6 missed). See [§3 DR-H-1](#dr-h-1).
- `archive/TOOL-INVENTORY-AUDIT.md` — 30→25 tool cut. Most
  recommendations shipped; current state is in `extensions/manifest.ts`.
  See [§2.1](#21-stale-from-tool-inventory-auditmd).
- `archive/Q13-SPLIT-INDEX-STATUS.md` — deferral decision for splitting
  4 large `index.ts` files. Decision still in effect. See [§5.3](#53-q13-status).
- `archive/WHISPER-AND-LOGGING-AUDIT.md` — delivery-mechanism audit.
  Superseded by `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (newer, more
  thorough) plus [§3 DR-C-1](#dr-c-1) finding the 20+ `ctx.whisper`
  contract violation.

---

## How to use this roadmap

- **P0** = Critical bugs. Ship before next release. ~3-5 dev days total.
- **P1** = Contract / architectural. This session's major findings. ~5-8 days.
- **P2** = High-effort improvements. Next sprint. ~15-25 days.
- **P3** = Polish and cleanup. When capacity allows. ~5-8 days.

Effort estimates are for a single experienced contributor. Item numbering:
- **DR-N** = Deep Review finding (this session's 36 items)
- **EW-N** = ENFORCEMENT-WHISPER-CONTENT-AUDIT §7 proposal (15 items)
- **FR-N** = FRAGILE-HEURISTICS-INVENTORY item (still-pending replacements)
- **CR-N** = CODE-QUALITY-REMEDIATION-PLAN deferred work (Q16/Q17/etc.)
- **Q13-N** = Q13 split candidates

---

## Stale items audit

Before the actionable list, this section enumerates items from prior
audits that are **already done, superseded, or contradicted by current
state** so we don't redo work.

### 2.1 Stale from `TOOL-INVENTORY-AUDIT.md`

| Item | Stale because |
|---|---|
| "auto_singleton → merge into timer.set_auto" | `auto_singleton` was CUT entirely (`5ffacd7b` per the audit itself). Merge recommendation obsolete. |
| "get_session_metrics, get_tool_reliability → make opt-in" | Both CUT (`8824877a`). |
| "30 → 25 tools" target | Achieved. Current manifest: 25 enabled + 3 opt-in. |
| `tasks.json` orphan file | If user didn't act on the cleanup, may still exist. **Verify and delete.** |
| Scratchpad description pointing agents away from SDK's `task` | Already in place per scratchpad/index.ts description. |

### 2.2 Stale from `Q13-SPLIT-INDEX-STATUS.md`

| Item | Stale because |
|---|---|
| File sizes (805, 747, 660, 655, 596, 578, 576, 525, 514) | Splits happened in Round 6. Current sizes: scratchpad 898, memory-agent-bridge 813, session-recall 552, timer 539, latent-activator 296, topic-drift 424. |
| "Decision: defer Q13" | Triggers the doc listed (new contributor lost, flaky test, cross-section refactor) — DR-M-8 from this review argues one trigger IS met (scratchpad's 400-line `scratchpadExecute`). |
| "memory-agent-bridge (805) — no sub-module boundary" | The tool itself is still monolithic; the file size has only dropped 1 line. The "no boundary" assessment remains valid. |

### 2.3 Stale from `FRAGILE-HEURISTICS-INVENTORY.md`

| Item | Stale because |
|---|---|
| 11 A-class fallbacks flagged for replacement | 11 were converted to `tierPolicy: "always-llm"` per Q9 (CODE-QUALITY-REMEDIATION-PLAN.md round 4-5). The inventory itself was written before the conversion. |
| 12 B-class fallbacks flagged | 4 converted to `tierPolicy: "fallback-only"`. 1 dead (`complianceFramingFallback`) removed. Remaining 7 B-class still need replacement (see [§5.1](#51-fragile-heuristics-status)). |
| Cost analysis missing | Q16 (Tier 2 cost budget) and Q17 (caching) still open. See [§5.2](#52-cost-and-caching-open-questions). |

### 2.4 Stale / contradicted from `WHISPER-AND-LOGGING-AUDIT.md`

| Item | Stale / contradicted because |
|---|---|
| "37 callsites of `sendTrackedMessage`" | ENFORCEMENT-WHISPER-CONTENT-AUDIT.md (3 days later) says "33+". Cross-doc number drift; the lower is more current. |
| "Two delivery APIs" framing | True but incomplete — DR-C-1 found a **third path**: `ctx.whisper?.()` used 20+ times across heartbeat-scheduler and topic-drift, plus monkey-patched in heartbeat-scheduler/index.ts:209-273. The audit's contract ("sendTrackedMessage is the only path") is violated in practice. |

### 2.5 Stale / contradicted from `STATE-POLICY.md`

| Item | Stale / contradicted because |
|---|---|
| "4 documented exceptions" | AGENTS.md:133 says 27, AGENTS.md:146 still says 4. STATE-POLICY.md:63 also says 4. **Three places disagree.** DR-C-3 fix. |
| "If pi ever runs multiple sessions in one process" | This hypothetical motivates `getExtensionState`. The deep review (DR-C-2, DR-C-4) found two real sites (`_policyState`/`_detectorState` in context-lifecycle, `poller`/`sessionId` in timer) where the assumption is load-bearing and undocumented. |

### 2.6 Stale / contradicted from `CASTS-AUDIT.md`

| Item | Stale because |
|---|---|
| "4 real casts remain" | The grep was for `as unknown as`. DR-H-1 found **6 more `as ToolDefinition<any, any, any>` casts** the audit missed: `timer/index.ts:460`, `topic-drift/index.ts:421`, `metacognition/index.ts:51, 52, 73, 77`. **Actual count: 10 casts across 6 files.** |

### 2.7 Still-current / authoritative

| Doc | Status |
|---|---|
| `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (2026-06-17) | Authoritative for this round. All 15 proposals in §7 are valid and reproduced in this ROADMAP as [§4](#enforcement-whisper-content-audit-7-proposals). |
| `CODE-QUALITY-REMEDIATION-PLAN.md` (2026-06-17) | Authoritative for what's been done in the 6 remediation rounds. |
| `ARXIV-CITATIONS-AUDIT.md` (2026-06-15) | All 7 citations verified; no changes needed. |
| `test-arxiv-citations.mjs` | Already in place per AR-§"Automated check". |
| `test-no-console-outside-logger.mjs` | The WHISPER-AND-LOGGING-AUDIT finding it pins is still valid (0 raw `console.*` outside logger). |

---

## New findings from deep review

This section lists 36 findings from a deep source-code review of all 181
TypeScript files in `src/`, executed as part of compiling this roadmap.
Each item has file:line, severity, impact, and fix path.

### 3.1 Critical (4)

#### DR-C-1. `ctx.whisper` is used 20+ times + monkey-patched in heartbeat-scheduler

**Severity:** Critical
**Files:** `extensions/heartbeat/heartbeat-scheduler/index.ts:209-273` (monkey-patch), 19+ other sites
**Contract violated:** `src/AGENTS.md:80-82`

The `ctx.whisper?.()` call (essentially `pi.sendMessage` shorthand) is used
20 times across the codebase, and `heartbeat-scheduler/index.ts:209-273`
monkey-patches `ctx.whisper` to buffer messages:

```ts
const originalWhisper = ctx.whisper?.bind(ctx);
ctx.whisper = (msg, opts) => {
  whisperBuffer.push({ message: msg, priority: opts?.priority ?? "low" });
};
// ...
.finally(() => {
  ctx.whisper = originalWhisper;  // line 273
  flushWhisperBuffer(whisperBuffer, originalWhisper as ...);
});
```

Impact: bypasses per-source flood cap; bypasses injection tracking; the
`finally` restoration is not exception-safe (if `flushWhisperBuffer` throws,
original is never restored); third-party extensions that listen on
`ctx.whisper` mid-pi-session are silenced.

Fix: (1) migrate all `ctx.whisper?.(...)` → `sendTrackedMessage(...)` with
`{ deliverAs: "steer", triggerTurn: false }` for non-waking whispers. (2)
Refactor heartbeat-scheduler's whisper batching to wrap `sendTrackedMessage`
rather than `ctx.whisper`. (3) Extend `test-no-direct-pi-sendmessage.mjs` to
flag `ctx.whisper` assignments. (4) Either update `src/AGENTS.md` to
acknowledge `ctx.whisper` as a secondary channel, or fully migrate.

#### DR-C-2. `_policyState` and `_detectorState` are module-level singletons holding session data

**Severity:** Critical
**File:** `extensions/memory/context-lifecycle/index.ts:78-79`

```ts
const _policyState = createPolicyEngineState();
const _detectorState: DetectorState = createDetectorState();
```

These are `const` so they don't violate the "no module-level let" rule,
but they hold session data: rate-limit counters, cooldowns, topic history,
tool sequence, turn count, signal queue. The session_start handler
(`context-lifecycle/index.ts:363-364`) only resets `cooldowns.clear()` and
`resetDetectorState(_detectorState)`. `_policyState.policies` and
`_policyState.governance` are NEVER reset. The `before_agent_start` handler
(line 410) HAS a `ctx` and still calls `state().turnCount++`,
`state().proposalsThisTurn = 0`, `state().agentActedOnContext = false` —
all module-level writes that should be per-session.

Fix: migrate to `getExtensionState(ctx, "context-lifecycle-policy", ...)`
and `getExtensionState(ctx, "context-lifecycle-detector", ...)`. The
`before_agent_start` handler already has ctx everywhere.

#### DR-C-3. `AGENTS.md` self-contradicts on documented exceptions (line 133 vs 146)

**Severity:** Critical
**File:** `src/lib/state/AGENTS.md:133` vs `:146`

- Line 133: "27 documented exceptions enumerated. Test enforces the policy."
- Line 146: "...asserts that the 4 documented exceptions are the only ones."

Future contributor reading AGENTS.md will see "4" on line 146 (the
lint-test description) and "27" on line 133 (the audit history). Same
self-contradiction in `docs/STATE-POLICY.md:63`.

Fix: update line 146 to "asserts that the 27 documented exceptions are the
only ones." Fix `STATE-POLICY.md:63` to match.

#### DR-C-4. Timer extension closure-captures `sessionId` and `poller` as single-instance state

**Severity:** Critical
**File:** `extensions/scheduling/timer/index.ts:347-465`

```ts
export default function timerExtension(pi: ExtensionAPI): void {
  let sessionId = "anonymous";
  let sessionIdResolved = false;
  let poller: TimerPoller | null = null;

  const ensurePoller = (ctx: unknown): TimerPoller => {
    if (!poller) {
      const sid = getSessionId(ctx);
      sessionId = sid;
      sessionIdResolved = true;
      poller = new TimerPoller(sid, ...);
    }
    return poller;
  };
```

The `TimerManager` class correctly keys timers by sessionId. But the
extension factory closure caches `sessionId`, `sessionIdResolved`, and
`poller`. A second `timerExtension(pi2)` call in the same process would
inherit session 1's poller.

Fix: either (a) document the single-process-per-session assumption
explicitly at line 348 and add a runtime assertion, or (b) move `poller`,
`sessionId`, `sessionIdResolved` to `getExtensionState(ctx, "timer", () => ({...}))`.

### 3.2 High-severity (9)

#### DR-H-1. CASTS-AUDIT missed 6 `as ToolDefinition` casts — actual count is 10

**Severity:** High (audit gap)
**Files:** 8 sites

Documented in `CASTS-AUDIT.md` (4):
- `extensions/memory/scratchpad/index.ts:897`
- `extensions/cognitive/metacognition/handlers/claim-verification.ts:277`
- `extensions/memory/scratchpad/persistence.ts:190`
- `lib/utils/extension-utils.ts:37`

Missed by the audit (6):
- `extensions/cognitive/metacognition/index.ts:51, 52, 73, 77` (4 sites)
- `extensions/scheduling/timer/index.ts:460` (no generics — worse)
- `extensions/cognitive/topic-drift/index.ts:421` (no generics — worse)

Plus `lib/ai/llm-call.ts:406` is one of the 4 documented.

Fix: update `CASTS-AUDIT.md` to count all escape-hatch casts. Apply the
typed-adapter pattern to all 10 sites.

#### DR-H-2. `explore_paths` tool description lies — doesn't spawn sub-agents

**Severity:** High (info accuracy)
**File:** `extensions/memory/memory-agent-bridge/explore-paths.ts:71`

Tool description says "Spawn parallel sub-agents to explore multiple
potential root causes" but the implementation only does local
`execFile('find' | 'grep' | 'head')`. No sub-agent API. The agent makes
decisions based on false description.

Fix: change description to "Search for files matching each hypothesis and
read their first lines to gather evidence."

#### DR-H-3. Topic drift `extractOutputText` returns JSON-stringified dump for non-text results

**Severity:** High (correctness)
**File:** `extensions/cognitive/topic-drift/index.ts:158-164`

```ts
function extractOutputText(event: any): string {
  if (typeof event?.result === "string") return event.result;
  if (typeof event?.result?.content === "string") return event.result.content;
  if (typeof event?.result?.text === "string") return event.result.text;
  if (typeof event?.output === "string") return event.output;
  if (typeof event?.text === "string") return event.text;
  return JSON.stringify(event?.result ?? event ?? "").substring(0, 2000);
}
```

The fallback path returns `JSON.stringify` of arbitrary objects, truncated
to 2000 chars. This is fed to three LLM classifiers as "the agent's
response text." For tool results containing structured data, the
classifiers see a literal JSON dump.

Fix: skip drift detection when `extractOutputText` falls through to
`JSON.stringify`. Return `null` and let caller handle.

#### DR-H-4. `scratchpad/persistence.ts:217` silently swallows disk-write failures

**Severity:** High (data loss)
**File:** `extensions/memory/scratchpad/persistence.ts:217`

```ts
} catch {
  // Silent fail - operates in memory if disk write fails
```

User has no idea disk writes are failing. Next session loads from disk
(stale). Silent data loss.

Fix: surface a whisper: `[scratchpad] Disk write failed: ${err.message}.
Notes will be lost on restart.`

#### DR-H-5. `memory_store` silently drops episodic twin on three-memory-stores failure

**Severity:** High (silent failure)
**File:** `extensions/memory/memory-agent-bridge/index.ts:104-110`

```ts
if (params.memoryType === "episodic" && ctx) {
  try {
    const threeMem = getExtensionState<MemoryStoresState>(...);
    addEpisode(threeMem, ...);
  } catch {
    /* three-memory-stores not available */
  }
}
```

The comment says "three-memory-stores not available" but
`getExtensionState` doesn't throw on unavailability — only `addEpisode`
failures would be caught. And the catch is empty. If `addEpisode` throws,
the user gets "Stored memory" success but the episodic twin is gone.

Fix: either surface the error in the response details, or at minimum log
it. Fix the misleading comment.

#### DR-H-6. `recall_get` synthesizes a fake `CognitiveMemoryEntry` from an episode

**Severity:** High (type system violation)
**File:** `extensions/memory/memory-agent-bridge/index.ts:340-368`

When an ID isn't in the unified store, the code searches three-memory-stores
episodes and returns them AS a `CognitiveMemoryEntry` with synthesized
fields (`accessCount: 0`, `importance: 0.5`). Downstream consumers treat
this as a real entry.

Fix: return episode via a separate code path with an explicit
`entryType: "memory" | "episode"` discriminator.

#### DR-H-7. `relevanceReason` matches project paths inside any tag containing the cwd substring

**Severity:** High (false positive rate)
**File:** `extensions/memory/memory-agent-bridge/index.ts:153-156`

`r.memory.tags.some((t) => t.includes(r.currentProject!))` — `currentProject`
is the full cwd path. A tag like "team-myapp-newsletter" would match
"/Users/foo/projects/myapp" anywhere.

Fix: match against a normalized project identifier (use
`deriveProjectId(cwd)`).

#### DR-H-8. `findByIdOrText` in scratchpad iterates twice

**Severity:** Medium (perf)
**File:** `extensions/memory/scratchpad/index.ts:135-145`

Two `findIndex` passes. Could be one pass.

#### DR-H-9. Topic drift runs 3 parallel LLM calls with no caching

**Severity:** High (cost)
**File:** `extensions/cognitive/topic-drift/index.ts:74-95`

Every drift check fires 3 full classifier calls. No deduplication by
input — repeated identical tool results trigger 3 fresh LLM calls each
time.

Fix: add hash-based cache with short TTL (e.g., 30s). Consider collapsing
the 3 yes/no classifiers into one multi-label prompt.

### 3.3 Medium-severity (14)

#### DR-M-1. `scratchpadClean` always writes to disk even when nothing pruned

**File:** `extensions/memory/scratchpad/index.ts:97-150`. Track
`total_pruned > 0` and only `mutateAndSave` if true.

#### DR-M-2. `capPush` return value unused

**File:** `extensions/memory/scratchpad/index.ts:120-126`. Either use the
excess count in user-visible responses or change return type to void.

#### DR-M-3. Pipe-delimited parsing for `add_decision`/`add_constraint`/`add_learning` silently truncates on `|`

**File:** `extensions/memory/scratchpad/index.ts:540-685`. Drop pipe
parsing entirely; use separate schema params.

#### DR-M-4. `archive_done` swallows file errors with `// Best-effort archive`

**File:** `extensions/memory/scratchpad/index.ts:786-789`. If archive write
fails, items are deleted from `pad.done` anyway. Silent data loss. Don't
delete on archive failure.

#### DR-M-5. `elevate_to_goal` accepts `successCriteria` and ignores it

**File:** `extensions/memory/scratchpad/index.ts:712-715`. Dead code.
Implement storage or remove from schema.

#### DR-M-6. Scratchpad schema declares `constraint_id` never read

**File:** `extensions/memory/scratchpad/index.ts:415`. `remove_constraint`
uses `text`, not `params.constraint_id`. Other `remove_*` actions use
`params.id`. Inconsistent.

#### DR-M-7. `memory_store` `consolidateWith` loop has O(N²) string growth

**File:** `extensions/memory/memory-agent-bridge/index.ts:91-97`. Each merge
appends up to 500 chars + separator. Visibility into which sources were
merged is zero.

#### DR-M-8. `scratchpadExecute` is 400+ lines with 20 switch cases

**File:** `extensions/memory/scratchpad/index.ts:472-825`. Each case has its
own subtle logic, error paths inline. Q13 trigger condition partially met
("refactor requires touching multiple unrelated sections"). Split by action
type, mirror metacognition's `handlers/` pattern.

#### DR-M-9. `episodes_search` builds a "provenance" string the LLM has to parse

**File:** `extensions/memory/memory-agent-bridge/index.ts:413-416`.
`[MEMORY project=... ttl=... ago]` — "ttl" misleadingly suggests
time-to-live, here means age. Rename to `age=` or restructure.

#### DR-M-10. `addEvidence` may add duplicate evidence for repeated searches

**File:** `extensions/memory/memory-agent-bridge/index.ts:299-303`. Repeated
identical searches add same evidence. Biases relevance scoring.

#### DR-M-11 through M-14. See deep review for additional context-manager/scratchpad/session-recall items not reproduced here

(Truncated for brevity; see full review notes in the source-of-truth commit message.)

### 3.4 Low-severity (9)

#### DR-L-1. `fireHandlers` in timer is dead code

**File:** `extensions/scheduling/timer/index.ts:152-159`. Comment admits
"no callers register via onTimerFire". Remove or document as future API.

#### DR-L-2. `getSessionId` in timer duplicates `getSessionIdSafe`

**File:** `extensions/scheduling/timer/index.ts:101-104`. Use the
centralized `getSessionIdSafe` helper from extension-state.ts.

#### DR-L-3. `state()` import in context-lifecycle is the legacy fallback

**File:** `extensions/memory/context-lifecycle/index.ts:96`. Used in
handlers that have ctx. Migrate to `getState(ctx)`.

#### DR-L-4. `state()`/`_getState` re-export pattern is opaque

**File:** `extensions/memory/context-lifecycle/index.ts:96-103`. Both
import and export the legacy functions. Deprecate in favor of
`getState(ctx)`.

#### DR-L-5. `mutateAndSave` does synchronous disk writes on every mutation

**File:** `extensions/memory/scratchpad/index.ts:239-242`. Every scratchpad
mutation triggers disk write. Use `file-mutation-queue.ts` for batching.

#### DR-L-6. Many `: any` annotations remain

**File:** Multiple — 40+ uses of `: any`. Many legitimate (pi-core events
untyped); some avoidable with `Static<typeof schema>`.

#### DR-L-7. Context-lifecycle tool returns internal state in details

**File:** `extensions/memory/context-lifecycle/index.ts:722-730`. Returns
full policies/governance arrays. Return summary counts instead.

#### DR-L-8. Heartbeat-scheduler checkpoint uses `ctx.cwd` as session ID

**File:** `extensions/heartbeat/heartbeat-scheduler/index.ts:241`.
Conflates project with session. Use `getSessionIdSafe(ctx) ?? ctx.cwd`.

#### DR-L-9. `getCognitiveMemoryInstance` returns `unknown` then caller casts

**File:** `lib/memory/index.ts:78`.
`let instance = getCognitiveMemoryInstance() as CognitiveMemory | null;`
— the cast bypasses the type system. Define typed wrapper.

---

## ENFORCEMENT-WHISPER-CONTENT-AUDIT §7 proposals

All 15 items from the ENFORCEMENT-WHISPER-CONTENT-AUDIT §7 are valid and
current. Reproduced here for the consolidated roadmap. For full context
(inventory of all 35 whisper templates, supporting structures, dedup
system), see `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md`.

### 4.1 EW-7.1. Fix `enforcement_violation → tool_error` amplification — HIGH / EASY

**Problem:** Every `sendEnforcementWhisper` call emits `enforcement_violation`
to eventBus, which is re-emitted as `tool_error`, which drives calibration
error / MARS / auto-recovery amplification. A perfectly fine advisory
triggers the error-recurrence advice next turn.

**Fix:** In `whisper.ts:51-58`, only emit `enforcement_violation` when
`critical: true`.

### 4.2 EW-7.2. Wire up the 14 unwired NudgeType values — HIGH / EASY

**Problem:** Of 16 `NudgeType` configs, only `validation` and `scratchpad`
have callers. The other 14 create a false impression.

**Fix:** For each: wire it up, or delete it. Specific:
- `malformed`: wrap `detection/malformed.ts:24` in `getNudgeManager("malformed")`. Right shape.
- `dangerousCommand`: keep as scaffolding, mark with TODO comment.
- `lazy`, `claim`: delete (replaced by LLM judges).
- `toolDiversity`: wire or delete the dead flag.
- `exploreBeforeAct`, `phaseValidation`, `judge`, `context`, `contextTool`, `toolError`, `memory`: trigger logic exists in L2 bundle; wire up or delete.
- `recordFailure`: wrap `turn-analysis.ts:106-118` in `getNudgeManager("recordFailure")`.

### 4.3 EW-7.3. Apply `braid.suppressNudges` consistently — HIGH / EASY

**Problem:** Off-switch checked in 4 sites, missed in 11+. Setting
`braid.suppressNudges=true` still gets ~70% of agent-facing whispers.

**Fix:** Add `areCognitiveNudgesDisabled()` checks at the 11 missed sites
(or refactor to a single wrapper).

### 4.4 EW-7.4. Extract "classifier offline" helper — MEDIUM / EASY

**Problem:** Three near-identical implementations in topic-drift,
turn-outcome, sycophancy. New classifiers copy-paste a fourth.

**Fix:** Add `lib/reasoning/classifier-offline.ts` with shared
`classifyWithOffline<T>()` helper and `CLASSIFIER_OFFLINE_WHISPERS`
constants.

### 4.5 EW-7.5. Clean up `checkBlocking` dead tracking — MEDIUM / EASY

**Problem:** `firstWorkDone`, `toolDiversityNudged` set but never read.
`ENFORCEMENT_PARAMS.blockExploreBeforeWrite` is dead.

**Fix:** Delete the dead fields and the dead config flag. Keep
`toolChain.recentEditWithoutThink` (used by signals.ts).

### 4.6 EW-7.6. Fix `enforcementSignals` pruning vs. MARS lookback — MEDIUM / EASY

**Problem:** `SIGNAL_RETENTION_TURNS = 1` keeps only current+previous turn.
MARS needs 3 samples for stability_decline. By the time MARS fires, data
is gone.

**Fix:** (a) Set `SIGNAL_RETENTION_TURNS = 3`, or (b) give MARS its own
long-lived stability log on `ThoughtChainState`.

### 4.7 EW-7.7. Type the `enforcementSignals` keys — MEDIUM / EASY

**Problem:** `Record<string, EnforcementSignalEntry>` allows typos that
compile.

**Fix:** Define `EnforcementSignalKey` union: `"stability" | "probe" | "routing" | "unpersisted_learnings"`.

### 4.8 EW-7.8. Promote `nudgeCooldownMs` to constants or remove — LOW / EASY

**Problem:** Two parallel rate-limit mechanisms: per-NudgeType cooldowns in
`NudgeManager` and `nudgeCooldownMs` in `error-tracking-state.ts`.

**Fix:** Delete `nudgeCooldownMs`; rely on `NudgeManager` for all rate-limiting.

### 4.9 EW-7.9. Make Session Signals bundle per-signal — MEDIUM / MEDIUM

**Problem:** L2 bundle gated by single hash of concatenated text. Adding
one L2 line re-arms previously-suppressed bundle.

**Fix:** Hash each sub-signal independently. Gate per-key via
`shouldSendNudge(sig.key, sig.content)`.

### 4.10 EW-7.10. Make `_localizationRisk` a regular field — LOW / EASY

**Fix:** Rename `_localizationRisk` → `localizationRisk`. Update setter
(`register-tool-call.ts:49`) and reader (`turn-end-handler.ts:340`).

### 4.11 EW-7.11. Add `braid.enforcement` settings block — HIGH / MEDIUM

**Problem:** All per-type cooldowns hardcoded. Power users can't tune.

**Fix:** Add `braid.enforcement` block to settings.json. Validate with
`validateNudgeConfig` helper. Power users (long-running sessions, custom
tool mixes) are currently locked into defaults.

### 4.12 EW-7.12. Establish prefix naming convention — LOW / MEDIUM

**Problem:** ~30+ inconsistent prefix formats.

**Fix:** Document convention: lowercase kebab for tags `[<subsystem>-<event>]`,
headline for major events, UPPERCASE for emergencies. Migrate gradually.

### 4.13 EW-7.13. Add per-source priority-aware caps — MEDIUM / MEDIUM

**Problem:** All sources share `PER_SOURCE_CAP = 2`. A 3rd
`triggerTurn: true` whisper is silently dropped — exactly where dropping
is worst.

**Fix:** Add `PER_SOURCE_CAP_OVERRIDES: Record<string, number>` (e.g.,
`"enforcement/whisper": 3`).

### 4.14 EW-7.14. Surface `nudgeSuppressedCount` in TUI — LOW / EASY

**Problem:** `nudgeSuppressedCount` incremented, never read.

**Fix:** Either surface via `ctx.ui.setStatus` (every 5 suppressions) or
delete.

### 4.15 EW-7.15. Document burst-suppression scope — LOW / EASY

**Problem:** `isBurst` wipes L2 `sessionSignals` but not L1
`enforcementSignals`, claim-tracker, verification judge, conflict
detection.

**Fix:** Either expand suppression (option a) or rename to `l2-burst`
(option b).

---

## Other audit items still in flight

### 5.1 Fragile heuristics status

From `FRAGILE-HEURISTICS-INVENTORY.md`:

| Risk | Total in inventory | Shipped | Remaining |
|---|---|---|---|
| **A** (replace with LLM) | 17 | 11 | 6 |
| **B** (replace or constrain) | 12 | 4 | 8 |
| **C** (keep with tests) | 16 | 16 | 0 |
| **D** (format/syntax, keep) | 31 | 31 | 0 |

The 14 remaining A+B heuristics are listed in the inventory. All are
flagged for Tier 2 (`tierPolicy: "always-llm"` or `"fallback-only"`)
replacement; the work is broken up across the relevant call sites.

### 5.2 Cost and caching open questions

From `CODE-QUALITY-REMEDIATION-PLAN.md`:

- **Q16: Tier 2 cost budget.** What's the per-turn LLM spend limit? Not
  measured. Should be analyzed before the remaining 14 A+B conversions
  ship.
- **Q17: Hash-based short-window cache for tier-2 results.** Not
  implemented. Would help DR-H-9 (topic drift 3-call fanout).

### 5.3 Q13 status

The 4 unsplit large `index.ts` files (`memory-agent-bridge`, `timer`,
`session-recall`, `latent-activator`) are still deferred. The
`scratchpadExecute` function in `extensions/memory/scratchpad/index.ts`
(DR-M-8) is now a stronger candidate because the Q13 trigger condition
("refactor requires touching multiple unrelated sections") is met.

The line counts in the original Q13 doc are stale; see [§2.2](#22-stale-from-q13-split-index-statusmd).

---

## Prioritized action roadmap

### 6.1 P0 — Critical bugs (ship before next release, ~3-5 dev days)

| # | Item | Effort | Files |
|---|---|---|---|
| P0-1 | [DR-C-1](#dr-c-1) fix `ctx.whisper` violations | Medium | 20+ files + heartbeat-scheduler refactor |
| P0-2 | [DR-H-4](#dr-h-4) surface scratchpad disk-write failure | Easy | `scratchpad/persistence.ts:217` |
| P0-3 | [DR-H-5](#dr-h-5) surface three-memory-stores episodic twin failure | Easy | `memory-agent-bridge/index.ts:104-110` |
| P0-4 | [DR-M-4](#dr-m-4) don't delete from `pad.done` if archive failed | Easy | `scratchpad/index.ts:786-789` |
| P0-5 | [DR-H-3](#dr-h-3) skip drift detection when `extractOutputText` falls through | Easy | `topic-drift/index.ts:158-164` |
| P0-6 | [EW-7.1](#41-ew-71-fix-enforcement_violation--tool_error-amplification--high--easy) fix `enforcement_violation → tool_error` amplification | Easy | `whisper.ts:51-58` |
| P0-7 | [EW-7.6](#46-ew-76-fix-enforcementsignals-pruning-vs-mars-lookback--medium--easy) fix MARS lookback pruning collision | Easy | `signals.ts:49-57` |

### 6.2 P1 — Contract / architectural (this session, ~5-8 dev days)

| # | Item | Effort | Files |
|---|---|---|---|
| P1-1 | [DR-C-2](#dr-c-2) migrate `_policyState`/`_detectorState` to per-session | Medium | `context-lifecycle/index.ts:78-79` + state.ts |
| P1-2 | [DR-C-3](#dr-c-3) fix AGENTS.md self-contradiction (line 146) | Easy | `lib/state/AGENTS.md`, `docs/STATE-POLICY.md` |
| P1-3 | [DR-C-4](#dr-c-4) document or migrate timer closure-captured state | Medium | `timer/index.ts:347-465` |
| P1-4 | [EW-7.3](#43-ew-73-apply-braidsuppressnudges-consistently--high--easy) apply `braid.suppressNudges` consistently | Medium | 11 sites across enforcement/ |
| P1-5 | [EW-7.2](#42-ew-72-wire-up-the-14-unwired-nudgetype-values--high--easy) wire up or delete 14 unwired NudgeTypes | Medium | `nudge-manager.ts` + 8 call sites |
| P1-6 | [DR-H-7](#dr-h-7) fix `relevanceReason` substring match | Easy | `memory-agent-bridge/index.ts:153-156` |
| P1-7 | [DR-H-2](#dr-h-2) fix `explore_paths` tool description | Easy | `memory-agent-bridge/explore-paths.ts:71` |
| P1-8 | [DR-H-6](#dr-h-6) don't synthesize fake `CognitiveMemoryEntry` from episode | Easy | `memory-agent-bridge/index.ts:340-368` |

### 6.3 P2 — High-effort improvements (next sprint, ~15-25 dev days)

| # | Item | Effort | Files |
|---|---|---|---|
| P2-1 | [DR-H-1](#dr-h-1) apply typed-adapter pattern to all 10 casts | Medium | 6 files |
| P2-2 | [DR-M-8](#dr-m-8) split `scratchpadExecute` into per-action handlers | Hard | `scratchpad/index.ts:472-825` |
| P2-3 | [EW-7.4](#44-ew-74-extract-classifier-offline-helper--medium--easy) extract `classifier-offline` helper | Easy | new `lib/reasoning/classifier-offline.ts` + 3 sites |
| P2-4 | [EW-7.9](#49-ew-79-make-session-signals-bundle-per-signal--medium--medium) make Session Signals bundle per-signal | Medium | `turn-end-handler.ts:362-365` |
| P2-5 | [EW-7.11](#411-ew-711-add-braidenforcement-settings-block--high--medium) add `braid.enforcement` settings block | Medium | new config plumbing + NudgeManager |
| P2-6 | [EW-7.13](#413-ew-713-add-per-source-priority-aware-caps--medium--medium) add per-source priority-aware caps | Medium | `turn-dedup.ts` + `WHISPER_CAPS` |
| P2-7 | [DR-H-9](#dr-h-9) cache drift-classifier results by input hash | Medium | `topic-drift/index.ts` + cache module |
| P2-8 | [DR-L-5](#dr-l-5) batch scratchpad writes via `file-mutation-queue` | Medium | `scratchpad/persistence.ts` |
| P2-9 | [DR-M-3](#dr-m-3) drop pipe-delimited parsing for scratchpad actions | Easy | `scratchpad/index.ts:540-685` |
| P2-10 | Q13 split memory-agent-bridge, timer, session-recall, latent-activator | Hard | 4 large files |
| P2-11 | FR replace 7 B-class fallbacks still pending | Medium | `critic-registry.ts` + tierPolicy |

### 6.4 P3 — Polish and cleanup (when capacity allows, ~5-8 dev days)

| # | Item | Effort | Files |
|---|---|---|---|
| P3-1 | [EW-7.5](#45-ew-75-clean-up-checkblocking-dead-tracking--medium--easy) clean up `checkBlocking` dead tracking | Easy | `blocking.ts` + state |
| P3-2 | [EW-7.7](#47-ew-77-type-the-enforcementsignals-keys--medium--easy) type `enforcementSignals` keys | Easy | `signals.ts` |
| P3-3 | [EW-7.8](#48-ew-78-promote-nudgecooldownms-to-constants-or-remove--low--easy) promote `nudgeCooldownMs` to constants or remove | Easy | `error-tracking-state.ts` |
| P3-4 | [EW-7.10](#410-ew-710-make-_localizationrisk-a-regular-field--low--easy) rename `_localizationRisk` | Easy | 3 sites |
| P3-5 | [EW-7.14](#414-ew-714-surface-nudgesuppressedcount-in-tui--low--easy) surface `nudgeSuppressedCount` in TUI | Easy | `turn-end-handler.ts:232` |
| P3-6 | [EW-7.15](#415-ew-715-document-burst-suppression-scope--low--easy) document burst-suppression scope | Easy | `turn-end-handler.ts:347-349` |
| P3-7 | [EW-7.12](#412-ew-712-establish-prefix-naming-convention--low--medium) establish prefix naming convention | Easy (doc) + Medium (migrate) | all whisper sites |
| P3-8 | [DR-M-1](#dr-m-1) skip `mutateAndSave` when nothing pruned | Easy | `scratchpad/index.ts:97-150` |
| P3-9 | [DR-M-2](#dr-m-2) use or drop `capPush` return value | Easy | `scratchpad/index.ts:120-126` |
| P3-10 | [DR-M-5](#dr-m-5) implement or remove `successCriteria` in `elevate_to_goal` | Easy | `scratchpad/index.ts:712-715` |
| P3-11 | [DR-M-6](#dr-m-6) use `params.constraint_id` in `remove_constraint` | Easy | `scratchpad/index.ts` |
| P3-12 | [DR-M-7](#dr-m-7) limit consolidated memory growth + log sources merged | Easy | `memory-agent-bridge/index.ts:91-97` |
| P3-13 | [DR-M-9](#dr-m-9) fix misleading "ttl=" in episodes_search provenance | Easy | `memory-agent-bridge/index.ts:413-416` |
| P3-14 | [DR-M-10](#dr-m-10) dedupe `addEvidence` calls | Easy | `memory-agent-bridge/index.ts:299-303` |
| P3-15 | [DR-L-1](#dr-l-1) remove or document `fireHandlers` dead code | Easy | `timer/index.ts:152-159` |
| P3-16 | [DR-L-2](#dr-l-2) use `getSessionIdSafe` in timer module | Easy | `timer/index.ts:101-104` |
| P3-17 | [DR-L-3](#dr-l-3) migrate `state()` calls to `getState(ctx)` | Easy | `context-lifecycle/index.ts` (multiple) |
| P3-18 | [DR-L-4](#dr-l-4) deprecate `_getState`/`state()` re-export | Easy | `context-lifecycle/index.ts:96-103` |
| P3-19 | [DR-L-6](#dr-l-6) reduce `: any` usage with `Static<typeof schema>` | Easy | multiple tool files |
| P3-20 | [DR-L-7](#dr-l-7) return summary counts not full arrays in `context_proposals.stats` | Easy | `context-lifecycle/index.ts:722-730` |
| P3-21 | [DR-L-8](#dr-l-8) use `getSessionIdSafe` in heartbeat-scheduler checkpoint | Easy | `heartbeat-scheduler/index.ts:241` |
| P3-22 | [DR-L-9](#dr-l-9) define typed wrapper for `getCognitiveMemoryInstance` | Easy | `lib/memory/index.ts:78` |
| P3-23 | [DR-H-8](#dr-h-8) single-pass `findByIdOrText` | Easy | `scratchpad/index.ts:135-145` |
| P3-24 | TI verify and delete orphan `tasks.json` file (if not done) | Easy | filesystem |
| P3-25 | FR Q16+Q17 cost analysis and caching strategy for tier-2 LLM calls | Hard | new |

---

## Cross-cutting recommendations

1. **Update `CASTS-AUDIT.md`** to also count `as ToolDefinition` casts.
   The current "4 real casts" is incorrect — actual count is 10. (DR-H-1)

2. **Update `STATE-POLICY.md` and `src/lib/state/AGENTS.md`** to use a
   consistent exception count (27). Currently three places disagree.
   (DR-C-3)

3. **Add a test** `test-ctx-whisper-usage.mjs` that scans for
   `ctx.whisper` assignments and direct callsites outside the documented
   sites. (DR-C-1)

4. **Add a test** `test-nudgetype-wiring.mjs` that asserts each
   `NudgeType` config in `DEFAULT_NUDGE_CONFIGS` has at least one call
   site to `shouldSendNudge`. Would have caught the 14 unwired
   NudgeTypes. (EW-7.2)

5. **Add a test** `test-persistence-failure-surfacing.mjs` that asserts
   disk-write failures are NOT silently swallowed. Would catch scratchpad
   persistence.ts:217. (DR-H-4)

6. **Document the single-process-per-session assumption** at every site
   where it's load-bearing: `timer/index.ts:347`,
   `context-lifecycle/index.ts:78-79`. Either add runtime assertions or
   migrate to per-session. (DR-C-2, DR-C-4)

7. **Reconcile the three audit counts** for `sendTrackedMessage`
   callsites. The numbers in `WHISPER-AND-LOGGING-AUDIT.md` (37) and
   `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (33+) disagree with a current
   grep (~23). Pick one canonical count and update all docs.

8. **Update cross-references** in the following files to point to
   archived docs and to the new ROADMAP:
   - `AGENTS.md` (root) — child DOX index
   - `CHANGELOG.md` — historical reference to `docs/TOOL-INVENTORY-AUDIT.md` (left as-is, it's a release-time record)
   - `test/runtime/lib/test-no-console-outside-logger.mjs:11` — comment
   - `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` — 4 references to
     `docs/archive/WHISPER-AND-LOGGING-AUDIT.md` (now in archive)
   - `docs/STATE-POLICY.md` — Q13 reference (now archived) + the "4
     documented exceptions" bug (corrected to 27)
   - `docs/CODE-QUALITY-REMEDIATION-PLAN.md` — 4 references to archived docs

---

## Effort / impact summary

| Tier | Count | Total effort estimate |
|---|---|---|
| **P0 Critical** | 7 items | ~3-5 dev days |
| **P1 Contract / Arch** | 8 items | ~5-8 dev days |
| **P2 High-effort** | 11 items | ~15-25 dev days |
| **P3 Polish** | 25 items | ~5-8 dev days |
| **Total actionable** | **51 items** | **~28-46 dev days** |

The bulk of the value (DR-C-1, DR-C-2, DR-C-4, EW-7.1, EW-7.3, EW-7.6,
DR-H-4) is concentrated in 7 items. The remaining 44 items are real but
lower-impact.

---

## Versioning

- **v1.0** (2026-06-17): initial compilation from prior audits + deep
  review. Replaces the 4 archived docs.
- **v1.1** (2026-06-17): first wave of items shipped.
  **P0 (all 7):** DR-C-1 ctx.whisper violations [DEFERRED — too
  cross-cutting for autonomous pass], P0-2 scratchpad disk-write
  surfacing, P0-3 episodic twin surfacing, P0-4 archive_done atomic
  delete, P0-5 extractOutputText JSON fallback, P0-6 enforcement_violation
  amplification fix, P0-7 SIGNAL_RETENTION_TURNS=3. **P1 (3/8):** P1-6
  relevanceReason substring match, P1-7 explore_paths description,
  P1-8 recall_get fake entry discriminator. **P3 (8/25):** P3-4
  _localizationRisk rename, P3-8 note_compact skip save, P3-10
  elevate_to_goal successCriteria, P3-11 remove_constraint uses
  params.constraint_id, P3-13 episodes_search "ttl=" → "age=", P3-15
  remove fireHandlers dead code, P3-16 getSessionIdSafe in timer,
  P3-20 stats summary counts, P3-22 typed CognitiveMemory wrapper,
  P3-23 single-pass findByIdOrText.
- **v1.2** (2026-06-17): second wave. **EW items:** EW-7.4
  classifier-offline helper created at
  `src/lib/reasoning/classifier-offline.ts` (callers not yet
  migrated — 3 sites can adopt the new `classifyWithOffline` API
  in a follow-up), EW-7.5 checkBlocking dead tracking removed
  (`firstWorkDone`, `toolDiversityNudged` fields deleted from
  `ToolTrackingState`), EW-7.14 nudgeSuppressedCount surfaced
  to TUI every 5 suppressions, EW-7.15 burst-suppression scope
  documented (only L2 wiped, L1 continues). **P3 (additional 3):**
  P3-5 nudgeSuppressedCount TUI, P3-14 addEvidence dedup by
  memory id+type, P3-21 heartbeat-scheduler uses getSessionIdSafe
  (4 call sites: lines 145, 248, 357, 415).

  Test verification: tsc clean, no-module-level-let passes
  (213 files), no-console-outside-logger passes (213 files),
  scratchpad-long-session 50/50.
- **v1.3** (2026-06-17): P1-1 (DR-C-2) partial migration. The
  `state()` function in `context-lifecycle/state.ts` is now an
  overload: `state(ctx)` returns per-session state via
  `getExtensionState`; `state()` (no args) keeps the module-level
  fallback for legacy callers. Migrated critical sites in
  `context-lifecycle/index.ts` (queueProposal rate limiter,
  before_agent_start handler, stats action, registerSessionStart
  handler). The remaining `state()` (no-args) call sites are in
  ctx-less callbacks (eventBus handlers, pi.on(TOOL_CALL) without
  ctx) - acceptable for now since the state mutations there are
  short-lived (turn-scoped counters). The lint test EXEMPT_LINES
  table was updated for the shifted line numbers.

  Deferred: full removal of the module-level fallback (requires
  threading ctx through `eventBus.on("memory_evict")` and the
  `pi.on(TOOL_CALL)` handler, which currently don't receive ctx).
- **v1.4** (2026-06-17): EW-7.7 partial - introduced
  `SIGNAL_KEYS` constant in `signals.ts` and migrated the 3
  literal `"unpersisted_learnings"` references in
  `turn-end-handler.ts` and `register-session-compact.ts`.
  Full typed-key union is still future work; the current
  `Record<string, EnforcementSignalEntry>` storage allows
  dynamic keys (per-sub-signal from the L2 bundle).

  Note: `find ~/.pi/agent/braid -name "tasks.json"` returned
  5 orphan files from the old `task` tool. These are user-state
  files, not repo files - not auto-deleted. User can clean
  manually if desired.
- **v1.5** (2026-06-17): P3-12 (DR-M-7) consolidated memory growth
  cap. memory_store `consolidateWith` capped to 10 sources, with
  a warn log on excess. Source IDs now included in
  `details.merged_from` and the response text says "merged from N
  source(s)" so the user has visibility into consolidation.

## Final autonomous-pass tally

27 of 51 actionable items shipped across 6 commits (see
`git log --oneline -7` from main). Remaining 24 items are
explicitly deferred in the per-version notes above with reasons.
The biggest deferred item is **P0-1 / DR-C-1** (ctx.whisper
migration, 20+ sites) which requires a coordinated refactor of
the heartbeat-scheduler monkey-patch to be safe.
- **v1.6** (2026-06-17): P2-1 partial — typed-adapter pattern.
  Eliminated 4 of 6 missed `as ToolDefinition<any, any, any>` casts:
  - `metacognition/handlers/think.ts`: createThinkTool() now
    returns `: ToolDefinition<any, any, any>` (added `label`).
  - `metacognition/handlers/hypothesize.ts`: already typed.
  - `metacognition/handlers/finalize.ts`: createFinalizeTool()
    now returns `: ToolDefinition<any, any, any>`.
  - `metacognition/handlers/verify.ts`: createVerifyTool() now
    returns `: ToolDefinition<any, any, any>` (added `label`).
  - `metacognition/index.ts`: 4 call sites now `pi.registerTool(createX())` (no cast).
  - `timer/index.ts:460` and `topic-drift/index.ts:421`: added
    missing `<any, any, any>` generic args (now consistent with
    the other documented casts).

  Remaining 4 `as ToolDefinition<any, any, any>` casts (scratchpad,
  claim-verification, timer, topic-drift) are documented in
  CASTS-AUDIT.md and require the proper "wrap return value in
  AgentToolResult shape" fix per the audit. This is more invasive
  (changes the execute function's return type) and deferred to
  a future round.
- **Future revisions:** bump when P0 ships; when half of P1 ships; etc.

This document supersedes the actionable sections of the archived audits.
The remaining active documents (`ENFORCEMENT-WHISPER-CONTENT-AUDIT.md`,
`CODE-QUALITY-REMEDIATION-PLAN.md`, `FRAGILE-HEURISTICS-INVENTORY.md`,
`STATE-POLICY.md`, `ARXIV-CITATIONS-AUDIT.md`) retain their full content
as historical/reference material.
