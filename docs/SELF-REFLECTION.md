# Agent Self-Reflection: pi-braid Tool & Architecture Audit

*Generated: 2026-05-03 - Infinite Self-Reflection Loop*

---

## 1. Tool Landscape (66 active tools across 25+ files)

### BY CATEGORY

| Category | Count | Extensions | Health |
|----------|-------|-----------|--------|
| **Metacognition** | 5 | think, hypothesize, finalize, verify, scratchpad | ✅ Strong |
| **Memory** | 12 | memory-search, memory-add, memory-list, memory-get, session-search, session-query, context-tag, context-compress, context-audit, context-proposals, conflict-qa, context-signal | ✅ Strong |
| **Cognitive** | 10 | verify-claim, verify-decomposition, check-topic-drift, reset-topic-anchors, 6 belief/conflict tools | ✅ Strong |
| **Utility** | 12 | healthcheck, timer-set/list/cancel, web-fetch, browser-*, codebase-tree, read-document, render-pdf-page | ✅ Strong |
| **Latent Activator** | 4 | 3 activator + 1 behavior tools | ⚠️ Weak |
| **Observatory** | 1 | /observatory | ✅ New |
| **Analytics** | 5 | /analytics, /analytics:all, /analytics:setVariant, /analytics:ab, 3 data tools | ✅ Strong |
| **Error** | 4 | error-list, error-get, error-clear, error-stats | ✅ Strong |
| **Evolve** | 1 | /evolve | ⚠️ Weak triggers |
| **Agent-Env** | 1 | /env | ⚠️ Weak |

### KEY OBSERVATIONS

**Missing Tools (critical gaps):**
- **No diff/patch tool** — agent must bash `diff` to compare files, can't apply patches directly
- **No structured data query tool** — no SQL/JSON query, forces bash jq usage
- **No system monitor** — agent can't see CPU/memory trends (only healthcheck snapshot)
- **No rollback/snapshot tool** — state-checkpoint lib exists but no user-facing tool
- **No experiment tracker** — no structured A/B result viewer (only raw analytics)
- **No prompt tester** — no way to test prompt changes before deploying
- **No file comparison tool** — agent reads two files separately, no side-by-side

**Overused Tools (addiction signals):**
- **bash (32-62% of calls)** — used for build, test, grep, wc, git, npm, piping. 52 shell pattern usages in test files, 147 in extensions. Many should be dedicated tools.
- **grep (indirect via bash)** — should be first-class tool with structured output

---

## 2. Event Bus Architecture

### HOT SPOTS (overloaded events)

| Event | Listeners | Risk |
|-------|-----------|------|
| `session_start` | 12 | STARTUP LATENCY — all fire synchronously |
| `turn_end` | 8 | PER-TURN OVERHEAD — enforcement + heartbeat + memory + feedback |
| `session_shutdown` | 8 | CLEANUP RACE — shutdown order matters |
| `tool_call` | 3 | MISSING — no tool_error event type |

### GAPS

| Missing Event | Impact |
|--------------|--------|
| `tool_error` | Enforcement can't react to tool failures directly |
| `memory_evict` | Emitted by collector but no handler consumes it |
| `context_full` | Emitted but reactive, not proactive |
| `analytics_alert` | No structured alert channel from analytics → enforcement |
| `experiment_result` | No event for A/B test results landing |

### RECOMMENDATION
- Lazy-load heavy session_start listeners
- Batch turn_end handlers into a single tick
- Add tool_error event type to reduce bash catch-all usage

---

## 3. Test Coverage Crisis

### UNTESTED LIBRARIES (24 of 40 = 60%)

| File | Lines | Risk |
|------|-------|------|
| `cognitive-memory.ts` | **1225** | ⛔ CRITICAL — core memory system, zero tests |
| `goal-manager.ts` | 527 | ⛔ HIGH — goal tracking, no tests |
| `degradation-detector.ts` | 328 | ⛔ HIGH — drives degrade decisions, no tests |
| `state-checkpoint.ts` | 306 | ⛔ HIGH — rollback infrastructure, no tests |
| `filter-safe-to-remove.ts` | 251 | ⛔ HIGH — injection filtering, no tests |
| `belief-store.ts` | 252 | ⛔ HIGH — policy engine state, no tests |
| `context-density.ts` | 175 | ⚠️ MEDIUM |
| `extension-state.ts` | 146 | ⚠️ MEDIUM — all extensions depend on this |
| `injection-tracker.ts` | 131 | ⚠️ MEDIUM |
| `edit-helper.ts` | 201 | ⚠️ MEDIUM |
| 14 more smaller files | 35-130 | 🟢 LOW per-file, but compound risk |

### EXTENSIONS WITH ZERO ERROR HANDLING

| Extension | Lines | Risk |
|-----------|-------|------|
| `verification` | 411 | ⛔ HIGH — any error crashes the tool |
| `topic-drift` | 356 | ⛔ HIGH |
| `sycophancy-detector` | 280 | ⚠️ MEDIUM |
| `agent-environment` | 282 | ⚠️ MEDIUM |
| `rate-limiter` | 173 | ⚠️ MEDIUM |
| `metacognition/index.ts` | 117 | ⚠️ MEDIUM (handlers have catches though) |
| `watchdog` | 77 | 🟢 LOW |
| `planner` | 21 | 🟢 LOW |
| `latent-activator` | 568 (zero catch) | ⛔ HIGH — commands can fail silently |

### TEST QUALITY
- 47 tests pass, but most test small surface areas via source analysis (grep for strings in files)
- Only 5-6 tests do actual runtime import/invocation
- No performance/benchmark tests for memory or heartbeat
- No stress tests (many concurrent events)
- No regression test suite for event bus

---

## 4. Skill System Health

### 15 ACTIVE SKILLS

| Skill | Lines | Trigger Phrases | Sections | Health |
|-------|-------|----------------|----------|--------|
| meta-improvement | 166 | **7** | 30 | ✅ Best |
| visual-creator | 386 | 1 | 41 | ⚠️ Bloated |
| design-system | 368 | 1 | 27 | ⚠️ Bloated |
| process-control | 137 | 1 | 21 | ⚠️ Under-triggered |
| code-search | 92 | 1 | 19 | ⚠️ Under-triggered |
| agent-testing | 196 | 1 | 9 | ⚠️ Under-triggered |
| tone-quality | 116 | 3 | 6 | ✅ Good triggers |
| vcs-tools | 100 | 1 | 12 | ⚠️ |
| visual-validator | 135 | **0** | 17 | 🚫 BROKEN — no trigger phrases |

### PROBLEMS
- **11/15 skills have only 1 trigger phrase** — they activate rarely or never
- **visual-validator** has zero trigger phrases — effectively dead
- **visual-creator** (386L) and **design-system** (368L) are bloated with no progressive loading
- **Archived skills** (5 dirs, 24 files) — abandoned experiments, should be cleaned or revived
- No way to audit skill usage rates (no telemetry)

---

## 5. File Decomposition Status

### PROBLEM FILES (still >500 lines)

| File | Lines | Status |
|------|-------|--------|
| `heartbeat/analytics/index.ts` | 1053 | ⏳ Not decomposed |
| `enforcement/index.ts` | 1268 | ⏳ Has handlers/ but index still huge |
| `cognitive-memory.ts` | 1225 | ⏳ Not decomposed |
| `lib/bidirectional-verifier.ts` | 674 | ⏳ Could split |
| `context-lifecycle/index.ts` | 622 | ⏳ Could split |
| `session-recall/index.ts` | 591 | ⏳ Could split |
| `latent-activator/index.ts` | 568 | ⏳ Could split |
| `cognitive-systems/index.ts` | 521 | ⏳ Could split |
| `feedback/index.ts` | 503 | ⏳ Could split |

### DECOMPOSED SUCCESSFULLY
| File | Before | After | Delta |
|------|--------|-------|-------|
| heartbeat-scheduler/index.ts | **1410** | **446** | -964 ✅ |
| enforcement index splitted into handlers/ | ~2000+ | 1268 | Already in progress ✅ |

---

## 6. What Boosts Performance

### HIGH-VALUE PATTERNS
1. **Injection Tracker** (injection-tracker.ts) — prevents system messages from corrupting user context
2. **Event Bus** (event-bus.ts) — decoupled architecture lets modules react without coupling
3. **Extension State** (extension-state.ts) — session-scoped state prevents cross-session leaks
4. **Heartbeat Scheduler** — proactive cognitive scheduling reduces reactive mistakes
5. **Policy Engine** (belief-policy-engine.ts) — declarative policy definition, composable
6. **Verification tools** (verify-claim, verify-decomposition) — agent self-checks
7. **Error classifier** (error-classifier.ts) — structured errors → appropriate retry
8. **Scratchpad** — persistent plan tracking with budget awareness
9. **Tool tracking + addiction detection** — self-knowledge for the agent

### LOW-VALUE / RARELY USED
1. **Latent Activator** — 4 tools, 568 lines, zero error handling, unclear value
2. **Evolve extension** — has infrastructure but rarely triggers
3. **Rate Limiter** — disabled-by-default, 173 lines, never fires
4. **Watchdog** — disabled-by-default, minimal value
5. **Agent-Environment** — disabled-by-default, overlaps with polyfill
6. **Prompt-Guardian** — already removed (was dead code)
7. **Sycophancy Detector** — zero error handling, unclear effectiveness

---

## 7. Immediate Action Items

### CRITICAL (do this week)
- [ ] Write tests for cognitive-memory.ts (1225L) — highest risk untested code
- [ ] Add error handling to verification, topic-drift, sycophancy-detector extensions
- [ ] Add catch blocks to latent-activator (568L, zero error handling)
- [ ] Write tests for degradation-detector.ts (328L) — drives evolve decisions

### HIGH PRIORITY
- [ ] Create diff/patch tool — reduce bash usage by 10%+
- [ ] Write tests for filter-safe-to-remove.ts, injection-tracker.ts, state-checkpoint.ts
- [ ] Add tool_error event type to event bus
- [ ] Lazy-load session_start handlers (12 listeners is too many)

### MEDIUM PRIORITY
- [ ] Decompose analytics/index.ts (1053L), cognitive-memory.ts (1225L)
- [ ] Add trigger phrases to visual-validator (currently 0)
- [ ] Clean up archived skills (5 dirs, revive or remove)
- [ ] Create system monitor tool (CPU/memory/disk trends)

### LOW PRIORITY
- [ ] Create structured data query tool (SQL/JSON path)
- [ ] Create experiment tracker UI
- [ ] Add progressive loading to visual-creator (386L) and design-system (368L)

---

*Generated: Cycle 4 of infinite self-reflection loop. Next analysis cycle would deep-dive each critical item with implementation proposals.*
# Self-Reflection Supplement: Deep-Dive Findings
*Appended during infinite loop — Cycles 5-8*

---

## Cycle 5: enforcement/index.ts (1268L) — Misleading Decomposition

### Finding: handlers/ directory is ALL UTILITY, ZERO event handlers
Every file in `src/extensions/cognitive/enforcement/handlers/` has **0** `pi.on()`, `registerTool()`, or `registerCommand()` calls. They are pure helper modules:

| Handler File | Lines | Purpose | Registration Count |
|-------------|-------|---------|-------------------|
| blocking.ts | 91 | Check if commands should be blocked | 0 |
| message-analysis.ts | 98 | Analyze message content | 0 |
| orphan-chains.ts | 58 | Detect orphan thought chains | 0 |
| probe-handler.ts | 146 | Probe analysis | 0 |
| routing-handler.ts | 216 | Route messages to correct handler | 0 |
| tool-registrations.ts | 8 | **STUB** — no actual registrations | 0 |
| tool-tracker.ts | 152 | Track tool usage | 0 |
| turn-analysis.ts | 126 | Analyze turn patterns | 0 |

**All 8 pi.on() event handlers remain in index.ts** (1268 lines):
- `before_agent_start`
- `input` 
- `session_start`
- `tool_call` (largest: ~90 lines)
- `message_end` (3 handlers!)
- `tool_end`
- `turn_end` (largest: ~360 lines)
- `session_compact`
- `auto_retry_end`
- `session_shutdown`

**Impact**: The handlers/ directory creates the *illusion* of decomposition. The index.ts is still 1268 lines with all event wiring. True decomposition would move each pi.on() into a handlers/ file.

---

## Cycle 6: Cross-Module Coupling & Circular Dependency Risk

### CRITICAL: enforcement → analytics (cross-module hard import)

```
cognitive/enforcement/index.ts
  → heartbeat/analytics/index.js  (HARD import, not lazy)
```

This is a **cross-module dependency** NOT documented in COUPLING.md:
```ts
import { getAnalyticsState } from "../../heartbeat/analytics/index.js";
import { recordNudgeSent, recordNudgeSuppressed } from "../../../extensions/heartbeat/analytics/index.js";
```

The second import path `../../../extensions/heartbeat/analytics/index.js` is a **filesystem-relative path that bypasses the module system entirely**. If the heartbeat module is disabled but cognitive is enabled, this import will fail at runtime. This IS a latent bug.

### VERIFIED CLEAN: heartbeat → memory (uses lazy import)
heartbeat-scheduler uses `await import()` for three-memory-stores, avoiding static circular dependency. ✅

### CONCERN: No static import verification
There is no tool or check that verifies cross-module imports are documented in COUPLING.md. Any extension can hard-import any other extension's code.

---

## Cycle 7: Tool Effectiveness Analysis

### What Boosts Performance (empirical)

| Tool/Pattern | Why | Usage Pattern |
|-------------|-----|--------------|
| **edit** | Exact match replacement — reliable, no partial changes | 80% of file changes |
| **write** | Full file overwrite — atomic and predictable | 15% of file changes |
| **think** | Structured reasoning with depth param | Used every 5-10 turns |
| **grep** | Fast codebase search | ~10% of calls |
| **scratchpad** | Persistent state between sessions | ~1-3 calls per session |
| **error_clear** | Error state management | ~3-5 per session |
| **read** | Understanding existing code | ~20% of calls |

### What Struggles (empirical)

| Tool/Pattern | Problem | Suggested Fix |
|-------------|---------|---------------|
| **bash** (32-62%) | Used for grep, diff, test, build, wc, npm, git, piping | Create diff tool, query tool, test watcher |
| **healthcheck** | Diagnostic only, no continuous monitoring | Add system monitor with trend tracking |
| **latent-activator** | 568 lines, 4 tools, 0 error handling, unclear value | Audit for actual usage; remove if dead |
| **evolve** | Complex infrastructure, rarely triggers | Simplify trigger conditions |
| **observatory** | New, untested in production | Needs real-world validation |
| **verify** (verify-claim) | Works well but output is text, not structured | Add structured output mode |

### Tool Category Value Ranking

```
HIGH:     edit, write, read, grep, think, error_*, memory_*, context_*
MEDIUM:   bash (necessary evil), verify_*, browser_*, web_fetch, repl
LOW:      latent-activator, evolve, rate-limiter, watchdog, agent-environment
NEW:      observatory, codebase-tree, timer
```

---

## Cycle 8: Shared Library Dependency Health

### HIGHEST USAGE LIBS (most dependents)

| Library | Used By | Risk |
|---------|---------|------|
| `extension-state.ts` (146L, NO TEST) | heartbeat, context-lifecycle, metacognition, planner, topic-drift, three-memory-stores | 🔴 ALL extensions depend on untested state |
| `event-bus.ts` (181L, TESTED) | heartbeat, enforcement, timer, observatory | 🟢 Tested |
| `logger.ts` (301L, NO TEST) | ALL extensions | 🔴 30+ dependents, no test |
| `injection-tracker.ts` (131L, NO TEST) | enforcement, reasoning, timer, retry, metacognition, feedback | 🔴 Controls message visibility |
| `degradation-detector.ts` (328L, NO TEST) | heartbeat, evolve | 🔴 Drives auto-rollback decisions |

### POTENTIAL FRAGILE LIBS (complex, no tests)
| Library | Lines | Complex? | Tested? |
|---------|-------|----------|---------|
| `cognitive-memory.ts` | 1225 | YES (class + I/O) | ❌ |
| `goal-manager.ts` | 527 | YES (multi-step logic) | ❌ |
| `state-checkpoint.ts` | 306 | YES (async I/O + rollback) | ❌ |
| `filter-safe-to-remove.ts` | 251 | YES (LLM summarization) | ❌ |
| `consolidation-channel.ts` | 358 | YES (async queue) | ✅ (test-consolidation-channel.mjs) |

---

*End of supplement. Next cycles would propose fixes for each finding.*
# Self-Reflection: Improvement Proposals
*Cycle 9 — Highest-ROI fixes for tool effectiveness and system health*

---

## P1: Create `diff` Tool (reduce bash by ~8-12%)

**Problem**: Agent uses `bash diff file1 file2` or `git diff` to see changes. This returns plain text, not structured data. No way to apply patches.

**Solution**: `pi.registerTool({ name: "file_diff", ... })` that:
- Takes `fileA`, `fileB` (optional git ref)
- Returns structured diff (hunks, added/removed lines)
- Can apply patches via `patch` parameter
- Returns changed line numbers for follow-up `read` calls

**Impact**: Eliminates one of the top 3 bash use cases. Makes verification faster.

## P2: Add `tool_error` Event (fill event bus gap)

**Problem**: No `tool_error` event type exists. When a tool fails, enforcement can't react directly. Errors go to error-capture but no event propagates for other modules.

**Solution**: Emit `tool_error` from error-capture extension. Enforcement subscribes to react. Heartbeat can track failure rates.

**Impact**: Enables proactive error recovery. Reduces silent tool failures.

## P3: Lazy-Load session_start Handlers (reduce startup latency)

**Problem**: 12 listeners fire on `session_start` synchronously. Startup gets slower with every new extension. Latency is invisible — agent just waits.

**Solution**: Add batch phase loading:
```
Phase 1 (synchronous): polyfill, extension-state, logger
Phase 2 (await all): memory, enforcement, context-lifecycle, prompt
Phase 3 (fire-and-forget): analytics, heartbeat, latent-activator
```

**Impact**: Faster startup, less context wasted on initialization whispers.

## P4: Extract enforcement Handlers (complete decomposition)

**Problem**: handlers/ directory is misleading — 0 event registrations. All 8 pi.on() handlers remain in 1268-line index.ts.

**Solution**: Move each pi.on() into its own handler file:
- `handlers/input-handler.ts`
- `handlers/tool-call-handler.ts`
- `handlers/turn-end-handler.ts`
- `handlers/session-start-handler.ts`
- etc.

Each handler file receives `(pi, getState, ...utilities)` and registers itself.

**Impact**: Drops index.ts from 1268L to ~100L (imports + export). Each handler becomes independently testable.

## P5: Write Tests for Critical Untested Libraries

**Priority order (by risk):**
1. `extension-state.ts` (146L) — ALL extensions depend on it
2. `injection-tracker.ts` (131L) — controls message visibility
3. `degradation-detector.ts` (328L) — drives auto-rollback
4. `filter-safe-to-remove.ts` (251L) — LLM context summarization
5. `cognitive-memory.ts` (1225L) — largest untested file
6. `logger.ts` (301L) — 30+ dependents

Each test takes ~30 min to write. Total: ~3 hours for all 6.

**Impact**: From 24/40 untested to 18/40 untested. Covers highest-risk surface.

## P6: Create System Monitor Tool

**Problem**: Only `healthcheck` exists (snapshot). No way to see CPU/memory trends, process count, disk growth.

**Solution**: `pi.registerTool({ name: "system_monitor", ... })`:
- Returns resource usage as structured metrics
- Can start continuous monitoring (setInterval + whisper when thresholds exceeded)
- Stores history for trend visualization

**Impact**: Proactive resource management. Reduces crashes from memory pressure.

## P7: Audit Low-Value Extensions

**Extensions to review for removal or reduction:**
- `latent-activator` (568L, 0 catch blocks, unclear value)
- `evolve` (780L, unclear trigger conditions)
- `rate-limiter` (173L, disabled-by-default, never fires)
- `watchdog` (77L, minimal value vs overhead)
- `agent-environment` (282L, disabled-by-default)
- `sycophancy-detector` (280L, 0 catch blocks)

**Recommendation**: Either rewrite with clear value proposition, or remove. Dead code is a maintenance burden.

---

*Generated during infinite self-reflection loop. Next analysis: implementation plans for each proposal.*
