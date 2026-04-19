# pi-braid Code Review — v0.5.7

**Reviewer**: Braid (self-review)  
**Date**: 2026-04-19  
**Scope**: Every file. All 34,869 lines across 110 files.  
**Verdict**: ❌ FAIL — Architectural decay, API misuse, dead code, and pervasive antipatterns.

**Updated**: 2026-04-19 (post-deletion status + consolidated implementation plan)

---

## 0. Executive Summary

pi-braid is a 35-extension monolith that grafts cognitive systems, enforcement, feedback, evolution, and a dozen other concerns onto the pi-coding-agent extension API. The extension API is used incorrectly in roughly half the extensions. There are two competing LLM judge systems, two whisper delivery systems, two malformed-tool-call detectors, and 37 "latent behaviors" nobody invokes. Sync filesystem calls block the event loop in tools that claim to be async. The logger is 378 lines but most extensions use `console.log` instead. The `scratchpad` uses `process.cwd()` instead of `ctx.cwd`. The `rate-limiter` listens to an event that doesn't exist. The `repl` evals arbitrary code with `new Function()`. No tests exist.

This is not a review of intent — the ideas are sound. This is a review of execution.

---

## 1. Architecture

### 1.1 Monolithic Extension Loader

`src/index.ts` loads 35 sub-extensions in a hardcoded order with a comment saying "context-lifecycle goes AFTER context-manager" as the only documentation of dependency. One `try/catch` wraps each factory — failures are silently swallowed.

**Problems:**
- No dependency declaration mechanism
- No way to disable individual extensions
- Loading order is a global invariant maintained by comments
- No health reporting on which extensions loaded successfully

### 1.2 Extension Count Explosion

35 extensions is absurd for what this codebase does. Many should be merged or removed:

| Should Merge | Extensions | Reason |
|---|---|---|
| Enforcement + Feedback + Reasoning | enforcement, feedback, reasoning | All do the same thing: detect issues, send whispers |
| Anti-slop + Anti-slop-input | anti-slop, anti-slop-input | Two files, one concern |
| Context systems | context-manager, context-lifecycle | Lifecycle is automation layer for manager |
| Environment | agent-environment + l1-environment.ts | Split across extension and prompt-builder sub-module for no reason |
| Cognitive + Memory | cognitive-systems, cognitive-memory.ts | lib + extension should be one unit |

| Should Delete | Extension | Reason |
|---|---|---|
| latent-activator | 37 behaviors, zero integration with anything | Dead framework |
| visual-dashboard | Renders ASCII boxes nobody sees | Dead UI |
| ab-testing | 954 lines of statistical framework with no users | Dead science |
| reasoning | Duplicate of enforcement's malformed detection | Redundant |
| query-optimizer | Hardcoded medical body-part regexes in a coding tool | Wrong domain |
| analytics | Fabricated success rates (hardcoded 0.9) | Useless data |
| watchdog | Sets status to "active" and nothing else | Does nothing |
| rate-limiter | Listens to an event that doesn't exist | Completely non-functional |

### 1.3 Inter-Extension Communication

Extensions communicate via:
1. `pi.events` event bus (enforcement → prompt-builder)
2. `Symbol.for("pi-braid:custom-model-keys")` global shared state (polyfill ↔ model-resolver)
3. Direct import of mutable objects (`import { state } from "./state.js"`)
4. Module-level mutable variables
5. Monkey-patching context: `(ctx as any).__queryOptimizer`

There is no unified communication pattern. Five different mechanisms for the same problem.

---

## 2. Pi Extension API Misuse

### 2.1 `as any` Casts

The codebase contains **~80 instances** of `as any` casts. These are used to:
- Access event properties not in the TypeScript definitions (`(event as any).message`)
- Call methods that don't exist on the API (`(ctx as any).settingsManager`)
- Listen to events that may not exist (`pi.on("session_compact" as any, ...)`)
- Cast tool params instead of typing them (`params as ScratchpadToolInput`)

This is the #1 code quality issue. When the API changes, every `as any` is a silent runtime bomb.

### 2.2 Undocumented Events

Several extensions listen to events not documented in the extension API:

| Extension | Event | Status |
|---|---|---|
| enforcement | `session_compact` | Undocumented |
| enforcement | `auto_retry_end` | Undocumented |
| ab-testing | `agent_start` | Does this exist? |
| ab-testing | `tool_execution_start` | Does this exist? |
| analytics | `tool_execution_start` | Does this exist? |
| analytics | `tool_execution_end` | Does this exist? |
| rate-limiter | `context` | **Definitely doesn't exist** |
| visual-dashboard | `tool_result` | Does this exist? |

The rate-limiter listens to `"context"` event and accesses `ctx.model` and `ctx.getSystemPrompt()` — none of which exist on `ExtensionContext`. This extension is **completely non-functional**.

### 2.3 `Type.Union` + `Type.Literal` Instead of `StringEnum`

The Pi docs explicitly warn: *"Use `StringEnum` from `@mariozechner/pi-ai` for string enums. `Type.Union`/`Type.Literal` doesn't work with Google's API."*

Extensions using the wrong pattern:
- `metacognition/index.ts` — think tool type, depth parameters
- `scratchpad/index.ts` — action, phase, mode parameters
- `evolve/index.ts` — action parameter
- `planner/index.ts` — goal action, status parameters
- `context-manager/index.ts` — action parameter
- `docs/index.ts` — format parameter

### 2.4 Monkey Patching the API

`polyfill/index.ts` patches methods directly onto the `pi` object:

```typescript
pi.getBranch = () => sm.getBranch();
pi.getLeafId = () => sm.getLeafId();
pi.getTree = () => sm.getTree();
// ... 8 more methods
```

This is fragile. If pi adds these methods natively, the `typeof pi.getBranch !== "function"` check will skip the patch but the native method may have different behavior.

### 2.5 `ctx` Parameter Ignored in Tools

Most tools receive `ctx: ExtensionContext | undefined` as their 5th parameter but ignore it, using module-level state instead. This breaks session branching — when the user navigates to a different branch, module-level state is stale.

Affected: scratchpad, cognitive-systems, enforcement state, analytics, agent-environment, repl, evolve.

---

## 3. Logging

### 3.1 The Logger Nobody Uses

`src/lib/logger.ts` is 378 lines. It provides:
- `createLogger(source, ctx, minLevel)` — TUI-aware, level-filtered
- `taggedConsole(source)` — console.log with `[source]` prefix

Most extensions use `console.log` or `taggedConsole` instead of `createLogger`:

| Extension | Logging Used |
|---|---|
| ab-testing | `console.log` |
| anti-slop | `console.log` |
| anti-slop-input | `console.log` |
| cognitive-memory | `taggedConsole` |
| degradation-detector | `taggedConsole` |
| evolve | `taggedConsole` |
| query-optimizer | `console.log` |
| enforcement | `createLogger` ✓ |
| context-lifecycle | `createLogger` ✓ |

The logger also has a bug: `info` level messages go to `console.debug` instead of `console.info`:

```typescript
case "info":
    console.debug(formatted);  // Should be console.info
    break;
```

### 3.2 Console.log in Production Extensions

Extensions register with `console.log("[name] Extension registered")`. These fire on every session start, polluting TUI output.

---

## 4. State Management

### 4.1 Module-Level Mutable Singletons

**Every single extension** uses module-level mutable state. Examples:

```typescript
// enforcement/state.ts — 166 lines of exported mutable state
export const state = {
    config: { ...DEFAULT_CONFIG },
    turnHistory: new Map<number, TurnState>(),
    currentTurn: 0,
    // ... 30 more fields
};

// scratchpad/index.ts
let _taskScratchpad: TaskScratchpad | null = null;
let _currentProjectSlug: string = "";

// cognitive-memory.ts
let _memoryStore: CognitiveMemoryStore | null = null;

// repl/index.ts
const replState = {
    context: {} as Record<string, unknown>,
    executionCount: 0,
    lastResult: undefined as unknown,
};
```

**Problem**: When pi navigates to a different session branch, these singletons still hold state from the old branch. The scratchpad uses `process.cwd()` for project slug instead of `ctx.cwd`, meaning it returns the wrong project if the working directory changes.

### 4.2 No Session Isolation

The Pi extension API docs show the correct pattern: store state in tool result `details` and reconstruct from session entries on `session_start`. Almost no extension follows this pattern. Instead, state lives in module-level variables that persist across branch switches.

### 4.3 Global Shared State via Symbols

The polyfill and model-resolver share model keys via `Symbol.for("pi-braid:custom-model-keys")` on `globalThis`. This is a global mutable Map accessible from anywhere, with no cleanup on session shutdown.

---

## 5. File I/O

### 5.1 Synchronous Filesystem Everywhere

The codebase makes **~200 sync filesystem calls** (`readFileSync`, `writeFileSync`, `existsSync`, `statSync`, `mkdirSync`, `readdirSync`). These block the Node.js event loop.

Worst offenders:
- `cognitive-memory.ts`: Reads/writes `~/.pi/memory/memory.json` synchronously on every memory operation
- `scratchpad/index.ts`: Writes to disk on every scratchpad mutation
- `enforcement/index.ts`: Reads files for redundancy detection synchronously during turn processing
- `codebase-tree/index.ts`: Stats every file, reads gitignore, counts lines — all sync
- `analytics/index.ts`: Reads JSONL history synchronously
- `error-capture/index.ts`: Reads error log, parses JSONL, rewrites entire file — all sync

The `lib/async-storage.ts` module exists specifically to provide async file I/O with debouncing. Only the assistant extension uses it.

### 5.2 Path Handling

- `scratchpad`: Uses `process.cwd()` instead of `ctx.cwd`
- `codebase-tree`: Uses `process.cwd()` instead of `ctx.cwd`
- `error-capture`: No path normalization
- `docs`: Hardcoded `/tmp/` paths

### 5.3 No File Mutation Queue

The Pi docs warn: *"If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in edit and write."*

No extension uses `withFileMutationQueue`. The file-tool extension, docs extension, and any extension that touches files bypass the mutation queue.

---

## 6. Type Safety

### 6.1 `params as any` Pattern

Almost every tool casts params to a typed interface instead of using the schema-inferred type:

```typescript
// scratchpad/index.ts — repeated 30+ times
const { action, text } = params as ScratchpadToolInput;

// metacognition/index.ts
execute: async (_toolCallId: string, params: any, ...) => {
```

The correct pattern is to let TypeBox infer the type from the schema.

### 6.2 Return Type Inconsistency

Some tools return objects with `isError: true` as a property instead of throwing:

```typescript
// browser/index.ts
return { ..., isError: true } as { ...; isError?: boolean };
```

The docs say: *"Returning a value never sets the error flag regardless of what properties you include."* Only throwing sets `isError`.

### 6.3 Type Declaration Augmentation

`src/types/extension-context.d.ts` adds `getUtilityModel()` and `getVisionModel()` to `ExtensionContext`. These methods are patched by the polyfill extension at runtime. This means:
1. TypeScript thinks these methods always exist
2. At runtime they may be `undefined`
3. No runtime check is enforced

---

## 7. Dead Code & Bloat

### 7.1 Extensions That Do Nothing Useful

See Appendix D for detailed analysis of 8 extensions marked for deletion.

### 7.2 Dead Code Within Extensions

- `polyfill/index.ts`: `_lastUserMessage` tracking for `/retry` command — the retry command never reliably captures the right message
- `enforcement/whisper.ts`: `pendingWhisper` and `queueEnforcementWhisper()` are "DEPRECATED" but still used
- `feedback/index.ts`: `pendingWhisper` and `_queueFeedbackWhisper()` are "DEPRECATED" but still present
- `latent-activator/index.ts`: `inferBehaviorsFromTask()` exists but is disabled ("Behavior inference disabled")
- `visual-dashboard/index.ts`: Exports `updateConfidence()`, `updateMemoryPressure()`, `updateContextPercent()`, `setTokenBudget()` — none are called by any other extension

### 7.3 Competing Duplicate Systems

| Concern | Implementation A | Implementation B |
|---|---|---|
| Malformed tool call detection | enforcement/index.ts `detectMalformedToolCalls` | reasoning/index.ts `detectMalformedToolCalls` |
| LLM judging | enforcement/judge.ts (response analysis) | enforcement/verification-judge.ts (work verification) |
| Whisper delivery | enforcement/whisper.ts | feedback/index.ts |
| Nudge management | enforcement/nudge-manager.ts | feedback/index.ts |
| Memory persistence | cognitive-memory.ts | scratchpad key_learnings |
| Tool call tracking | enforcement/handlers/tool-tracker.ts | analytics/index.ts |
| Session state tracking | visual-dashboard/state-tracker.ts | agent-environment/index.ts |

---

## 8. Per-Extension Critical Issues

### polyfill (378 lines)
- **Critical**: Monkey-patches `pi` object with 8+ methods via direct assignment
- **Critical**: Uses `Symbol.for` on `globalThis` for cross-module state
- **Bug**: `agent_end` event handler uses `asApi(pi).on("agent_end", ...)` — is this event real?
- **Hack**: Persists to `~/.pi/agent/settings.json` by reading/merging/writing — could corrupt settings

### prompt-builder (310 lines)
- **Critical**: Re-implements project context loading with sync `readFileSync`/`existsSync`
- **Issue**: Uses sync fs to discover pi root path (`discoverPiRootPath()`) which calls `execSync("which pi")` — blocks event loop
- **Issue**: `formatEnforcementL1()` accesses module-level `_enforcementSignals` — no session scoping

### metacognition (615 lines)
- **Bug**: Duplicate tool auto-enable logic — both `turn_start` and `before_agent_start` do `setActiveTools()`
- **Issue**: Uses `Type.Union` + `Type.Literal` instead of `StringEnum` (breaks Google API)
- **Issue**: `completeSimple()` calls bypass pi's provider management, directly using `getApiKeyAndHeaders()`

### scratchpad (844 lines)
- **Bug**: Uses `process.cwd()` for project slug instead of `ctx.cwd`
- **Critical**: Sync `writeFileSync` on every mutation
- **Issue**: `mark_done` action matches by text content — if two plan steps have the same text, wrong one could be marked
- **Issue**: `add_constraint` parses `"type|description"` — fragile, no validation

### enforcement (807 lines + 12 sub-files = ~3000 lines total)
- **Critical**: Module-level `state` object with 30+ fields, no session isolation
- **Issue**: Redundancy detection uses Jaccard similarity on line-level tokenization — naive, expensive, sync
- **Issue**: `session_compact` handler reads scratchpad via `ctx.tools.scratchpad?.()` — is this a real API?
- **Issue**: Two separate LLM judge systems (judge.ts + verification-judge.ts)
- **Issue**: `overflowRecently` state can cause enforcement to silently suppress all signals for 5 turns

### context-manager (1914 lines)
- **Critical**: Largest file in the codebase by far
- **Issue**: Hash function is a basic string hash (`hashMessage`) — collisions are likely
- **Issue**: Sync fs throughout
- **Issue**: `PruneRule` interface has optional `prepare` and `process` — rules are never actually applied to prune messages, only marked

### repl (213 lines)
- **Security**: Uses `new Function()` for code execution — no sandboxing
- **Issue**: `pi as any` in the extension factory
- **Issue**: `globSync` is synchronous
- **Issue**: `replState` persists across sessions with no cleanup

### rate-limiter (168 lines)
- **Critical**: Listens to `"context"` event — **this event does not exist** in the pi API
- **Critical**: Accesses `ctx.model` and `ctx.getSystemPrompt()` — **not on ExtensionContext**
- **Conclusion**: This extension is completely non-functional dead code

### safety (294 lines)
- **Issue**: Auto-commits on session shutdown without checking if the repo belongs to the user
- **Issue**: Regex-based dangerous command detection can be bypassed with encoding, pipes, or subshells
- **Issue**: Dirty repo guard blocks in non-interactive mode — too aggressive

### browser (695 lines)
- **Best extension in the codebase** — proper API usage, custom renderers, truncation
- **Minor**: Module-level CDP connection state
- **Minor**: `console.log` for CDP tab creation

---

## 9. Missing Tests

```
"scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
}
```

34,869 lines of code. Zero tests. The `test-e2e.mjs` file is a skeleton that spawns pi and checks for a tool name.

---

## 10. Recommendations

### Immediate (P0)

1. **Delete dead extensions**: latent-activator, visual-dashboard, ab-testing, query-optimizer, analytics, watchdog, reasoning
2. **Delete the rate-limiter**: It listens to an event that doesn't exist
3. **Fix scratchpad cwd**: Replace `process.cwd()` with `ctx.cwd` from tool execute context
4. **Fix Type.Union → StringEnum**: All tool schemas with string enums
5. **Remove duplicate enforcement systems**: Merge judge + verification-judge, merge whisper systems

### Short-term (P1)

6. **Convert sync fs to async**: Start with cognitive-memory, scratchpad, enforcement file reads
7. **Eliminate `as any`**: Type every event handler, every tool param, every ctx access
8. **Consolidate extensions**: Merge the 7 enforcement/feedback/reasoning extensions into 1-2
9. **Use `withFileMutationQueue`**: For any extension that writes files
10. **Replace module-level state with session-scoped state**: Store in tool result `details`, reconstruct on `session_start`

### Medium-term (P2)

11. **Split context-manager**: Extract pruning rules, tag/checkout/compress tools into separate files
12. **Add dependency declaration**: Replace hardcoded load order with explicit deps
13. **Write tests**: Start with scratchpad, cognitive-memory, repl
14. **Fix logger**: Make `createLogger` the standard, remove all `console.log` calls
15. **Audit event usage**: Verify every `pi.on()` event name against the actual API

### Long-term (P3)

16. **Consider splitting into packages**: Core tools vs cognitive systems vs enforcement
17. **Remove polyfill monkey-patching**: Find proper API solutions or contribute upstream
18. **Add extension health reporting**: Each extension reports load status, tool counts

---

## Appendix A: File-by-File Size Analysis

| File | Lines | Assessment |
|---|---|---|
| context-manager/index.ts | 1914 | 🔴 Too large, split needed |
| enforcement/index.ts | 807 | 🔴 Too large |
| cognitive-memory.ts | 1181 | 🔴 Too large for a lib |
| scratchpad/index.ts | 844 | 🟡 Large but manageable |
| healthcheck/index.ts | 859 | 🟡 Monolithic but focused |
| metacognition/index.ts | 615 | 🟡 Three tools in one file |
| ab-testing/index.ts | 954 | 🔴 Delete entirely |
| enforcement/judge.ts | 555 | 🟡 Complex but isolated |
| user-message-preprocessor | 664 | 🟡 Reasonable |
| feedback/index.ts | 690 | 🟡 Should merge with enforcement |

## Appendix B: Extension Load Order (from index.ts)

```
polyfill → error-capture → prompt-builder → planner → metacognition → 
scratchpad → cognitive-systems → context-manager → context-lifecycle → 
session-recall → docs → codebase-tree → healthcheck → prompt-guardian → 
file-tool → evolve → enforcement → feedback → analytics → 
user-message-preprocessor → watchdog → rate-limiter → safety → ux → 
web-fetch → browser → assistant → vision → reasoning → repl → 
latent-activator → anti-slop → anti-slop-input → query-optimizer → ab-testing
```

35 extensions. Load order is a global invariant.

---

## Appendix C: Research Papers with Harness-Level Solutions

Research from `implicit-framing/docs/` that could fix review issues:

### 1. Batch Prompting (2511.04108) - 76% Token Reduction
**Problem**: Agent produces verbose output for simple tasks
**Solution**: Batch related queries in shared context → pattern induction suppresses overthinking
**Status**: Partially addressed via `IMPLICIT_BUDGET` constant

### 2. ACE Evolving Playbooks (2510.04618) - State Management
**Problem**: Module-level mutable singletons cause stale state on branch switch
**Solution**: Treat state as "evolving playbook" - structured incremental updates that preserve knowledge atoms
**Status**: Not implemented

### 3. MARS Self-Improvement (2601.11974) - Single-Cycle Reflection
**Problem**: Multi-turn improvement loops waste tokens
**Solution**: Single-cycle principle-based + procedural reflection after task completion
**Status**: `think` tool exists, latent-activator behaviors are dead

### 4. BCR Implicit Budget (2604.02322) - Token Budget Enforcement
**Problem**: Explicit limits ignored, context fills with verbose output
**Solution**: Structural constraints create implicit budget - models self-regulate
**Status**: `IMPLICIT_BUDGET` constant in prompt-builder

### 5. SkipKV (2512.07993) - Async I/O Pattern
**Problem**: 200+ sync fs calls block event loop
**Insight**: `lib/async-storage.ts` exists but not used
**Solution**: Replace sync calls with async-storage pattern
**Status**: Not used

---

## Appendix D: Extension Revival Analysis

After deep investigation, 8 extensions were marked for deletion. NOT all are truly dead:

### DELETE Permanently (Non-salvageable)

| Extension | Reason | Verdict |
|---|---|---|
| **rate-limiter** | Listens to `"context"` event that doesn't exist, accesses non-existent ctx properties | ❌ DELETE |

### MERGE Into Existing (Duplicate/Trivial)

| Extension | Action | Reason |
|---|---|---|
| **reasoning** | → enforcement | Duplicate `detectMalformedToolCalls()` |
| **watchdog** | → analytics/healthcheck | Trivial session health tracking, does nothing useful |

### PRESERVE + FIX (Valid Ideas, Broken Implementation)

| Extension | What Works | What's Broken | Action |
|---|---|---|---|
| **ab-testing** | 954-line complete statistical framework | No variant assignment integration | Add `assignVariant()` call in before_agent_start |
| **analytics** | Tool call tracking, JSONL storage, sequence detection | `successRate` hardcoded to 0.9 (fake data) | Track real errors from `tool_execution_end.isError` |
| **visual-dashboard** | Phase detection logic, ASCII chart renderer | Output mechanism broken (`ctx.ui.notify()` doesn't render) | Rebuild with working `/dashboard` command |

### RESEARCH Later (Valid Concept, Zero Integration)

| Extension | Research Backing | Issue | Action |
|---|---|---|---|
| **latent-activator** | HER (2601.21459): IMPLICIT > EXPLICIT | 37 behaviors defined but nothing reads them | Keep deleted, document integration point |
| **query-optimizer** | PriHA (2604.14215): Intent classification | Medical regexes in coding tool (wrong domain) | Keep deleted, refactor for coding domain |

### Implementation Priority for Salvaged Extensions

1. **analytics**: Fix `isError` tracking from tool_execution_end event (~2 hours)
2. **visual-dashboard**: Rebuild with `/dashboard` command using working emit (~1 day)
3. **ab-testing**: Add `assignVariant()` call + feature flag integration (~1 day)

---

## Appendix E: Consolidated Implementation Plan

### Phase 1: DELETE (Do First)
- [x] rate-limiter (already deleted from disk)
- [ ] reasoning → enforcement merge (has duplicate malformed detection)
- [ ] watchdog → analytics merge or delete

### Phase 2: FIX Broken Extensions
- [ ] analytics: Fix successRate tracking (real error data)
- [ ] visual-dashboard: Rebuild with working output mechanism
- [ ] ab-testing: Add variant assignment integration

### Phase 3: Consolidate Duplicates
- [ ] enforcement + feedback (two whisper systems)
- [ ] enforcement/judge + enforcement/verification-judge
- [ ] cognitive-systems + cognitive-memory

### Phase 4: Critical Bugs
- [ ] scratchpad: `process.cwd()` → `ctx.cwd`
- [ ] Type.Union → StringEnum (all tool schemas)
- [ ] Remove `as any` casts (~80 instances)
- [ ] Session-scoped state (not module-level)

### Phase 5: Performance
- [ ] Sync FS → Async (200+ calls, use async-storage.ts)
- [ ] analytics: Incremental stats (fix O(n) loadAnalytics)

### Phase 6: Architecture
- [ ] Dependency declaration for extensions
- [ ] Extension health reporting on load
- [ ] Event audit (verify pi.on() events exist)

### Phase 7: Research Implementations
- [ ] Batch Context (2511.04108)
- [ ] ACE Playbooks (2510.04618)
- [ ] MARS Reflection (2601.11974)

---

## Appendix F: Prior Art Reviews

### AUDIT-2026-04-14
Pre-cleanup state. Identified 25 extensions + 59 tools. Noted `model-selectors` was empty directory (removed).

### SKEPTIC-AUDIT
"WORST MOOD" review. Key findings:
- 12/31 extensions provide zero user-facing functionality
- `ctx.triggerCompaction` doesn't exist (now fixed to `ctx.compact()`)
- Extension load order dependency without guarantees (prompt-builder must load AFTER enforcement)
- Sync FS in event handlers blocks event loop
- No auth boundaries between extensions

### GAP-ANALYSIS
Detailed bridge documentation. What pi-braid captures from `develop` vs `main`:
- 18 extensions, 17 tool definitions, 13 library modules, 16 skills
- System prompt identity framing is THE most impactful change
- AGENTS.md removed, replaced by prompt-builder

---

## Appendix G: Evidence Files

| File | Purpose |
|---|---|
| `docs/AUDIT-2026-04-14.md` | Pre-cleanup state |
| `docs/SKEPTIC-AUDIT.md` | Architectural issues |
| `docs/GAP-ANALYSIS.md` | Bridge documentation |
| `docs/PI_BRAID_EXTENSION_REVIVAL_PROPOSAL.md` | Deep dive on 8 dead extensions |
| `docs/CONTEXT_RESEARCH_PAPERS.md` | Research-backed improvements |
| `docs/CONTEXT_RESEARCH_IMPLEMENTATION_PLAN.md` | Research implementation plan |
| `implicit-framing/docs/PI_BRAID_IMPLEMENTATION_PLAN.md` | Full 7-phase implementation plan |
