# Changelog

All notable changes to pi-braid are documented here.

## v0.38.0 (2026-04-29)

### Refactor
- **browser/ merged into tools/**: CDP automation, web-fetch, vision now utility tools under tools/ module. Reduced module count from 14 to 13.

### Features
- **RepE structured contrast vectors**: 4-mode system (TRUTH-SEEKING, CORRECTION, EPISTEMIC CALIBRATION, TOOL RELIABILITY) embedded in prompt-builder section 8c.
- **Structured output format**: CoT with > prefix, code blocks with language tags, XML-style tool result tags, tables for structured data. Prompt-builder section 8d.
- **resources_discover handler**: pi-braid registers bundled skills via pi's native discovery system (prompt-builder extension).
- **Master implementation plan**: docs/IMPLEMENTATION.md — single source of truth with P0-P3 execution order, 15 proposals audited.
- **12 new proposals from research agent**: Worker tasks, Agent Timer/Pomodoro, Benchmark v2, Contrast Phrase Library, Heartbeat Event Bus, Hierarchical Memory, Memory Leak Prevention, Self-Evolution Meta-Cognition, Structured Output Catalyst, VAR-MATH variants.

### Cleanup
- **Top-level docs culled 26 → 10**: Archived 15 redundant/historical docs (.archive-old/top-level-cull-2026-04-29/). Kept: README, ARCHITECTURE, MODULES, EXTENSION-HOOKS, ERRORS, BRAID-NEXT, WHAT-IS-MISSING, BENCHMARKS, SKILLS, CHANGELOG.
- **6 extension group docs added**: cognitive, core, heartbeat, memory, prompt, tools — full group coverage.
- **7 docs deleted**: PI-API-RESEARCH, PROMPT-BUILDER-REFACTOR, RESEARCH-MASTER, CONSOLIDATED-DOCS-INVENTORY, HONEST-REVIEW, DEVELOPMENT, PROPOSAL-scratchpad-*
- **README.md links fixed**: Dead links to RESEARCH-MASTER.md and DEVELOPMENT.md removed.
- **proposals/README.md status table**: Full proposal audit with status markers.
- **FIXME in degradation-detector.ts fixed**.

### Bug Fixes
- **enforcement/index.ts**: event param cast to `any` (auto_retry_end not in ExtensionAPI types).
- **test-features.mjs**: doc count guard updated (10 → 11).

---

## v0.14.0 (2026-04-23)

### Features

- **Compaction cascade prevention**: emergency rotation at 75% threshold, concurrency guards for retry, `display:false` for error messages to avoid context pollution
- **Auto-finalize with auto-proceed**: `finalize(autoProceed:true)` scans planner + goal manager for next pending task
- **Enforcement structured signals**: judge-prompt → structured JSON output, `emitSignal` wire to belief-policy-engine
- **Extension docs generated**: 29 new extension documentation files (34 total)
- **withFileMutationQueue**: atomic file write queue for safe concurrent mutation

### Fixes

- Critical: tool execution context bloat from retry cascades during compaction
- Context window monitoring before overflow retry — checks errors BEFORE retrying
- LLM summarization skipped when context ≥200K tokens
- Enforcement whisper no longer pollutes context via `display:false`
- Dead import cleanup in `conflict-qa.ts` (addEvidence, getAllConflicts, getEvidence, formatConflictMessage)

---

## v0.13.0 (2026-04-22)

### Features

- **Overnight build session**: 248 runtime tests pass
- **R6**: Session recall — past insights injected into prompt builder
- **H8**: Extension docs generator + evaluation suite
- **BR4**: Latent activator multi-turn test harness
- **BM1/BM2**: Multi-turn debugging + code quality benchmarks
- **D5**: Evidence pool fully source-labeled (enforcement has context)
- **All `as any` casts removed**: Proper typed access throughout codebase
- **planner vs metacognition resolved**: "Keep separate — complementary" decision

### Fixes

- Preprocessor: English detection via stopword ratio (>10% = skip translation)
- `/tools` command: Using SettingsList pattern instead of broken Box+SelectList
- Command persistence: Version-based config entries with disk fallback
- Finalize not being called: Prompt strengthening + enforcement whisper

---

## v0.12.0 (2026-04-21)

### Features

- **Parallel agent TIER 1-4**: Multi-agent orchestration infrastructure
- **Heartbeat scheduler**: Proactive cognitive scheduling (paper 2604.14178)
- **Timer extension**: Non-blocking Pomodoro timers with heartbeat integration
- **Analytics programmatic tools**: `get-session-metrics`, `get-tool-reliability`
- **Topic-drift detector**: Semantic anchor tracking for output relevance
- **Verification tools**: `verify_claim`, `verify_decomposition`, `conflict_qa`
- **Prompt-builder**: Structured output catalyst + RepE contrast phrases
- **Proactive token monitoring**: Overflow prevention via heartbeat policy

### Fixes

- Context: Check context window BEFORE overflow retry
- Context: Skip LLM summarization at ≥200K tokens
- ModuleContext data wiring in heartbeat

---

## v0.11.0 (2026-04-19)

### Features

- **Browser extension**: Native CDP browser automation (navigate, snapshot, eval, screenshot, cookies, content extraction)
- **Web-fetch**: URL → clean markdown with secret scanning + injection detection
- **Docs extension**: `read_document` + `render_pdf_page` for PDF, DOCX, RTF, HTML
- **RLM REPL**: Context-aware JS evaluation with `ctx` helpers (chunk, search, filter, map, reduce)
- **Polyfill refactor**: Model resolvers via `lib/model-resolver.ts`, no ctx patching needed
- **Codebase-tree**: Async traversal, gitignore-aware, smart truncation

### Fixes

- Vision model selector: ScopedModels for vision-capable model filtering
- Model persistence: `setDefaultModelAndProvider` saves across restarts
- REPL bare expression wrapping: Auto-wrap in `return` for expression-mode

---

## v0.10.0 (2026-04-17)

### Features

- **Prompt-builder refactor**: Section-based construction, helper functions, no fragile string extraction
- **User-message-preprocessor**: Multi-stage analysis (code stripping, prose detection, stopword ratio, translation)
- **Tools directory removed**: All tools moved inline to extensions (cognitive-systems, evolve, planner, metacognition, repl)
- **Context pruning**: 4 rules (dedup, superseded writes, error purge, recency) + auto-prune on every LLM call
- **Context compression**: LLM-driven summarization tool
- **Enforcement improvements**: Re-read detection, memory hygiene, context tool nudges, stricter finalize blocking

### Fixes

- `/tools` command: SettingsList pattern (fixes terminal hang)
- Console.log leaking to TUI: Removed debug output from context-manager
- Preprocessor: `isLikelyEnglish` check prevents false translation for English text

---

## v0.9.0 (2026-04-15)

### Features

- **Timer extension**: Set, list, cancel non-blocking timers
- **Feedback extension**: Structured feedback collection at natural breakpoints
- **UX extension**: User interaction conventions
- **Enforcement system**: Pre-turn prompts, memory hygiene, tool-use nudges
- **Tool cleanup**: Deregistered prompt-guardian, enforcement_status, preprocessor tools
- **Implicit budget**: 83.8% token reduction validated

### Fixes

- Session rotation bug: Context cleanup handler resets retry guards
- Compaction cascade: Remaining hidden turn triggers removed
- Topic drift: Proper anchor reset on task boundaries

---

## v0.8.0 (2026-04-12)

### Features

- **Evidence pool**: Structured evidence tracking with conflict detection
- **MARS reflector**: Adaptive triggers, tool overuse/error recurrence detection
- **Reasoning metrics**: Entropy, verbosity, overlap, recovery tracking (18 tests)
- **Conflict QA**: Token-overlap claim matching + conflict resolution
- **Cognitive-systems**: Three-memory stores (episodic, heuristics, tool stats)
- **Analytics**: Session metrics, tool reliability stats, A/B variant tracking

### Fixes

- Reasoning entropy check ordering: Check BEFORE overlap to prevent double-trigger
- ModuleContext state: WeakMap fallback fix for re-entrant calls

---

## v0.7.0 (2026-04-10)

### Features

- **Context-lifecycle V2**: R-CCAM loop, governance layer, closed-loop outcome tracking
- **Context-manager decomposition**: 5 handler modules (shared, tools, compaction, navigation, rotation, events)
- **Context tools**: tag, log, checkout, prune, compress, audit
- **Compaction integration**: Smart retry with exponential backoff (2s base, max 3 attempts)
- **HEMS scheduler**: Tier 1+2 event-driven + proactive scheduling
- **Session recall**: Past session search + query

### Fixes

- `context_prune` with `dryRun:false` — now actual analysis-only (no deletion since SessionManager is append-only)
- BranchWithSummary + compaction_end handler ordering

---

## v0.6.0 (2026-04-08)

### Features

- **HEMS heartbeat scheduler**: Proactive cognitive scheduling system
- **Enforcement extension**: Multi-tier signal system (L1 internal, L2 bundled, L3 critical)
- **Metacognition decomposition**: think/hypothesize/finalize tools + `cognition_evaluate`
- **Error classifier**: Structured classification (HTTP codes → provider codes → text matching)
- **Async migration**: 7 modules converted (cognitive-memory, scratchpad, enforcement, error-capture, docs, vision, codebase-tree)

### Fixes

- Sync→async in codebase-tree: `await parseGitignore` on line 218
- Double-comma TypeScript error in session-recall tool descriptions

---

## v0.5.8 (2026-04-06)

### Features

- Evidence pool integration (cognitive-systems NEW API, docs, memory_recall)
- MARS reflector (adaptive trigger, tool overuse/error recurrence)
- Reasoning metrics tests (18 new tests, threshold fixes)
- ROADMAP-v0.6 updated

### Fixes

- Various threshold calibration fixes

---

## v0.5.7 (2026-04-04)

### Features

- **Rate-limiter extension**: Token bucket per-second limits + concurrency cap
- **Reasoning metrics**: Entropy, verbosity, overlap, recovery tracking
- **Feedback system**: User feedback collection
- **StringEnum migration**: 10 files converted
- **Sync→async migration**: 7 modules
- **withFileMutationQueue**: Atomic file mutation queue
- **Finalize auto-proceed**: Planner + GoalManager integration

### Fixes

- 38 runtime tests pass
- TypeScript 0 errors

---

## v0.5.0-0.5.6 (2026-04-01 → 2026-04-04)

### Features

- AGENTS.md developer guide
- Extension state factory pattern
- Context pruning (deduplication, superseded writes, error purging, recency)
- Session tree visualization
- Goal/plan/task management via scratchpad
- `think(depth=deep)` invokes utility model
- Cognitive memory stores framework

---

## v0.4.0 (2026-03-28)

### Features

- Enforcement signals (tiered)
- Error capture extension
- Healthcheck extension
- Watchdog extension
- Time-status tool
- Session-scoped state via WeakMap pattern
- Metacognitive state tracking (confidence, knowledge gaps)

---

## v0.3.0 (2026-03-25)

### Features

- Context-manager extension (tag, log, checkout)
- Metacognition tools (think, hypothesize, finalize)
- Planner extension (goals, plans, tasks)
- Agent-environment extension (L1 state)
- Scratchpad tool (20+ actions)
- Prompt-builder system prompt customization
- Polyfill model resolver patching

---

## v0.2.0 (2026-03-22)

### Features

- Skill system (agent skills framework)
- REPL tool (JavaScript evaluation)
- Latent activator (behavior patterns)
- Explore-paths (parallel hypothesis investigation)
- Browser extension (basic navigation)
- Web-fetch tool (URL → markdown)
- Docs tool (PDF, DOCX, RTF reading)

---

## v0.1.0 (2026-03-18)

### Initial release

- Extension framework for pi agent
- Vision model integration
- Codebase tree tool
- Implicit budget (83.8% token reduction)
- Basic tool registry
- README.md with architecture diagram
