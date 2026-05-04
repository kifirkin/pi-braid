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
