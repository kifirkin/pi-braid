# pi-braid — Gap Analysis & Implementation Documentation

## Overview

pi-braid is a self-contained pi-coding-agent extension that extracts all develop-branch functionality from `pi-mono/packages/coding-agent`. This document details every gap between `main` and `develop`, what was captured, what wasn't, and how each gap is bridged.

---

## 1. What pi-braid Captures ✅

**92 files, +19,883 lines** from `src/core/builtin/`:

| Category | Count | Details |
|----------|-------|---------|
| Extensions | 18 | planner, metacognition, scratchpad, cognitive-systems, docs, pijul-checkpoint, codebase-tree, healthcheck, prompt-guardian, enforcement, feedback, evolve, user-message-preprocessor, watchdog, rate-limiter, vision, reasoning, file-tool |
| Tool definitions | 17 | think, goals, plan, planning, task, finalize, autonomous-control, explore-paths, resources, scratchpad, metacognition, knowledge-integration, tool-learning, time-tracker, repl, sub-agent, hypothesize |
| Library modules | 13 | cognitive-memory, goal-manager, task-queue, task-scratchpad, planner, degradation-detector, metacognition, knowledge-integration, knowledge-vcs, pijul-utils, resource-manager, async-storage, tool-learner |
| Skills | 16 | code-search, codebase-summary, compliance-audit, healthcheck, hyperagents-evolution, paper-writer, pi-docs, pi-internals, pijul-checkpoint, process-hygiene, skill-creator, software-engineer, tmux, visual-validator, web-search, workspace-manager |

**Verification**: Loaded via jiti, registers 55 tools and 29 events without errors.

---

## 2. What Was NOT Captured (and Why)

### Category A: Core Engine Changes ❌ Not Extractable

These are changes to files deep in `src/core/` that are part of the pi runtime itself, not extensions.

#### A1. `system-prompt.ts` (+96/-43 lines)

**Change**: Complete rewrite from directive style to identity framing.

**Old (main)**:
```
"You are an expert coding assistant..."
"MUST read files before editing"
"ALWAYS verify your changes"
"NEVER fabricate data"
```

**New (develop)**:
```
"You are stateful, meticulous and rigorous software architect..."
"You examine files before editing"
"You verify after every change"
"You don't fabricate"
```

**Impact**: THE most impactful change. Defines the agent's entire personality.

**Bridge**: ✅ `prompt-builder` extension using `before_agent_start` event. See §3.1.

---

#### A2. `extensions/types.ts` (+47 lines)

**Change**: New `ExtensionContext` methods:
- `ctx.getUtilityModel(): Model | undefined` — Resolve cheapest model for utility calls
- `ctx.getVisionModel(): Model | undefined` — Resolve vision-capable model

**Impact**: 7 call sites in pi-braid extensions (vision, enforcement, evolve, metacognition).

**Bridge**: ✅ `polyfill` extension that patches these methods onto context. See §3.2.

---

#### A3. `extensions/runner.ts` (+10 lines)

**Change**: Wires `getUtilityModel`/`getVisionModel` into ExtensionContext creation.

**Impact**: Without this, the polyfilled methods work but invoke the polyfill code path.

**Bridge**: ✅ Covered by polyfill extension.

---

#### A4. `extensions/loader.ts` (+22/-22 lines)

**Change**: Runtime stubs changed from throwing errors to safe no-ops. Extensions calling methods during load no longer crash.

**Impact**: On main, calling runtime methods during extension loading throws. The polyfill extension loads AFTER the runtime is initialized, so this isn't an issue.

**Bridge**: ✅ No action needed — our extensions don't call runtime methods during factory loading.

---

#### A5. `settings-manager.ts` (+35/-8 lines)

**Change**: New `utilityModel` and `visionModel` settings with getters/setters.

**Impact**: The `/utility-model` and `/vision-model` TUI selectors don't exist on main.

**Bridge**: ✅ `polyfill` extension adds `/utility-model` and `/vision-model` commands. See §3.2.

---

#### A6. `model-registry.ts` (+21 lines)

**Change**: New `getCheapModels()` method that returns non-reasoning models sorted by cost.

**Impact**: Used by utility model resolution.

**Bridge**: ✅ Polyfill re-implements model filtering using `getAvailable()`. See §3.2.

---

### Category B: Core Tool Changes ⚠️ Not Extractable, Minor Impact

#### B1. `read.ts` (+55/-23 lines)

**Change**: Vision-aware image reading — checks `_ctx?.model?.input?.includes('image')` before sending images, shows fallback text for non-vision models.

**Impact**: On main, images are always sent regardless of model capability. Wastes tokens on non-vision models.

**Bridge**: ⚠️ Cannot override the core `read` tool from an extension. Options:
1. Register a custom `read` tool that wraps the built-in (risky — conflicts with core)
2. **Propose upstream PR**: Add a simple filter in the core `read` tool
3. **Accept the gap**: Most models handle image content gracefully even if they can't "see" it

**Recommended**: Propose a minimal PR to upstream that adds the vision check to the core `read` tool.

---

#### B2. `tools/index.ts` and individual tools (+~20 lines total)

**Change**: All tool factory functions gained `ctxFactory?: () => ExtensionContext | undefined` parameter for dynamic cwd resolution.

**Impact**: On main, tools use the closure cwd (`process.cwd()` by default). Minor — affects session switching scenarios.

**Bridge**: ⚠️ Accept the gap on main. When running on develop, the host provides the ctxFactory.

---

### Category C: Compaction 🟡 Partially Bridgeable

#### C1. `compaction/compaction.ts` (+205/-29 lines)

**Change**: Major rewrite of compaction logic — better summarization, branch summarization fixes.

**Bridge**: ⚠️ The core compaction function can't be overridden. BUT:
- The `session_before_compact` event lets extensions provide custom summaries
- The `session_compact` event lets extensions react to compaction results
- pi-braid could provide a custom compaction prompt via `session_before_compact`

**Decision**: Accept main's compaction logic. Optionally add compaction guidance via `before_agent_start`.

---

### Category D: TUI / Interactive Mode ❌ Not Extractable

#### D1. `utility-model-selector.ts` (+278 lines), `vision-model-selector.ts` (+254 lines)

New interactive TUI components for model selection. Cannot be replicated as extension — they're Ink/React components.

**Bridge**: ✅ `polyfill` extension provides `/utility-model` and `/vision-model` slash commands instead of TUI menus.

#### D2. `interactive-mode.ts` (+382/-151 lines)

Utility/vision model menus, status display changes, interactive mode improvements.

**Bridge**: ❌ Core TUI code. Accept gap.

#### D3. `print-mode.ts` (+78/-76 lines), `rpc/rpc-mode.ts` (+35/-25 lines)

Mode-specific changes for streaming, compaction, etc.

**Bridge**: ❌ Core mode code. Accept gap.

---

### Category E: Infrastructure 🟠 Not Extractable, Low Impact

| File | Change | Bridge |
|------|--------|--------|
| `agent-session.ts` (+408/-158) | Time tracking, utility model, skill block parsing | ❌ Accept |
| `agent-session-runtime.ts` (+222/-179) | Runtime bootstrap rewrite | ❌ Accept |
| `resource-loader.ts` (+234/-210) | Bundled extension loading, skills | ❌ Accept |
| `main.ts` (+534/-289) | CLI args, runtime bootstrap | ❌ Accept |
| `tool-analytics.ts` (+668) | Entirely new analytics module | ✅ Could rebuild as extension |
| `parse-tags.ts` (+109) | New tag parsing utility | ✅ Could bundle locally |
| `keybindings.ts` (+18/-1) | Minor keybinding changes | ❌ Accept |
| `slash-commands.ts` (+5) | Minor additions | ❌ Accept |
| `cli/args.ts` (+65/-7) | CLI arg changes for model selectors | ❌ Accept |

---

### Category F: Deleted Code

| File | Change | Bridge |
|------|--------|--------|
| `package-manager-cli.ts` (-270) | Removed entirely | ✅ Not needed |
| `migrations.ts` (-19) | Removed keybinding migration | ✅ Not needed |
| `AGENTS.md` | Removed, replaced by system prompt identity framing | ✅ Covered by prompt-builder |

---

## 3. Bridge Extensions — Detailed Implementation

### 3.1. `prompt-builder` Extension

**Purpose**: Replace the system prompt with develop-branch identity framing.

**Mechanism**: Uses `before_agent_start` event which returns `{ systemPrompt: "..." }`.

**What it does**:
1. Receives `event.systemPrompt` (the current prompt from the host)
2. Extracts any append content (Project Context, skills from the host)
3. Builds a new prompt with:
   - Identity framing ("You are stateful, meticulous...")
   - Tool-aware guidelines (conditional based on active tools)
   - Tool descriptions built from `pi.getAllTools()` + `promptSnippet`
   - Guidelines from `promptGuidelines` on registered tools
   - Default identity-framing guidelines if no tool guidelines
4. Preserves all Project Context and append sections from the original prompt
5. Returns `{ systemPrompt: newPrompt }`

**Key design decisions**:
- Does NOT just append text — it REPLACES the prompt entirely
- Checks `pi.getActiveTools()` and `pi.getAllTools()` for tool-aware guidelines
- Preserves any `# Project Context` sections from the original prompt
- Only overrides default guidelines if tools provide `promptGuidelines`

**Priority**: CRITICAL — This is the #1 behavioral difference between main and develop.

---

### 3.2. `polyfill` Extension

**Purpose**: Patch missing `ExtensionContext` methods and provide model selector commands.

**What it patches**:
- `ctx.getUtilityModel()` — Falls back to `ctx.model` then cheapest available model
- `ctx.getVisionModel()` — Falls back to `ctx.model` (if vision-capable) then first vision model

**What it adds**:
- `/utility-model [pattern|clear]` — Set or show utility model
- `/vision-model [pattern|clear]` — Set or show vision model

**Model resolution priority**:
1. Custom pattern from `.pi/settings.json` (e.g., `"utilityModel": "anthropic/claude-haiku-4-5"`)
2. Current model (for utility) / current model if vision-capable (for vision)
3. Cheapest non-reasoning available model (for utility) / first vision model (for vision)

**Priority**: CRITICAL — Without this, 7 call sites in pi-braid crash on main.

---

## 4. Git History Insights — Midway Extraction Attempts

The develop branch shows a clear progression of attempting to extract core functionality into extensions:

| Commit | What |
|--------|------|
| `9e8d0cc` | Add 113 new builtin extensions, skills, tools, and lib modules |
| `68f96d1` | Wire up cognitive systems to v0.65.0 API |
| `67cbb6e33` | Adapt hooks to v0.65.0 published Agent API |
| `36b2fca` | Remove redundant/stub tools, demote admin tools to slash commands |
| `5c150b8` | Refactor built-in tools and extract to extensions |
| `fa4fdbd` | Move scratchpad() to extensions |
| `a7c97ef` | Remove AGENTS.md, refactor system prompt |
| `c73560d` | Implement 'Implicit Framing Engineering' for system_prompt |
| `5c12bbc` | Apply implicit framing and add skill for applying it further |

**Key insight**: The AGENTS.md was progressively gutted (81 → 44 → 0 lines) and replaced by the system prompt builder. The system prompt itself evolved from MUST/ALWAYS/NEVER directives to identity framing. This confirms our approach: the prompt is the #1 thing to capture.

---

## 5. upstream_main API Surface (v0.66.1)

The upstream branch has a stable extension API that supports everything we need:

| API Method | Purpose | Available in upstream? |
|-----------|---------|----------------------|
| `pi.on("before_agent_start")` | Modify system prompt per-turn | ✅ Yes (commit 17cb328c) |
| `pi.registerTool()` with `promptSnippet` | Tool descriptions in prompt | ✅ Yes (commit 8d4a49487) |
| `pi.registerTool()` with `promptGuidelines` | Tool-specific guidelines | ✅ Yes (commit bc2fa8d6d) |
| `pi.getAllTools()` / `pi.getActiveTools()` | Get tool info | ✅ Yes |
| `ctx.modelRegistry.getAvailable()` | Get available models | ✅ Yes |
| `ctx.model` | Current model | ✅ Yes |
| `pi.registerCommand()` | Slash commands | ✅ Yes |
| `pi.on("resources_discover")` | Inject skills | ✅ Yes (commit 3e5d91f2) |
| `pi.on("session_start")` | Lifecycle hook | ✅ Yes |
| `pi.on("tool_call")` | Tool interception | ✅ Yes |
| `ctx.settingsManager` | Read/write settings | ✅ Yes |
| `ctx.getUtilityModel()` | **Resolve utility model** | ❌ NOT in upstream |
| `ctx.getVisionModel()` | **Resolve vision model** | ❌ NOT in upstream |

**Conclusion**: The extension API is sufficient for everything except `getUtilityModel`/`getVisionModel`, which we polyfill.

---

## 6. Recommended Upstream PRs

These changes would benefit the entire pi ecosystem and make pi-braid simpler:

### PR 1: Vision-Aware Read Tool (Small, Low Risk)
Add `ctx?.model?.input?.includes('image')` check in the `read` tool before sending image content. Falls back to text warning for non-vision models. ~20 lines of code.

### PR 2: getUtilityModel/getVisionModel on ExtensionContext (Medium)
Add these methods to the `ExtensionContext` interface so extensions can resolve models for LLM calls without polyfills. The resolution logic (settings → model → cheapest) is well-defined and testable.

### PR 3: Dynamic cwd via ctxFactory (Small)
Add optional `ctxFactory?: () => ExtensionContext | undefined` to tool factory functions so tools can resolve cwd from session context rather than closure.

---

## 7. Critical Differences: upstream_main vs develop

This is a fresh review of ALL 17 commits between upstream_main (v0.66.1, the published package) and develop, comparing extension types, SDK, loader, runner, settings, model-registry, compaction, and system-prompt diffs.

### A. ExtensionContext API Surface

Only ONE difference between upstream_main and develop:
- `ctx.getUtilityModel()` — **NEW on develop only** → Polyfilled by pi-braid ✅
- `ctx.getVisionModel()` — **NEW on develop only** → Polyfilled by pi-braid ✅

All other `ExtensionContext` methods are identical.

### B. ExtensionAPI Events

Only ONE difference:
- `session_directory` event — **NEW on develop only**. Custom session directory resolution via `before_agent_start` alternatives. **NOT on upstream_main**.

All other events are identical.

### C. Input Event — `confirm` Action

**Develop adds a new result type** to `InputEventResult`:
```typescript
| { action: "confirm"; text: string; images?: ImageContent[] }
```

This allows extensions to show a confirmation dialog to the user before proceeding. **Not available on upstream_main.**

pi-braid does NOT currently use this. Could be added as an enhancement.

### D. Slash Commands — What Exists Where

| Command | upstream_main | develop |
|---------|-------------|---------|
| `/utility-model` | ❌ Not built-in | ✅ Built-in |
| `/vision-model` | ❌ Not built-in | ✅ Built-in |
| `/retry` | ❌ Not built-in | ✅ Built-in (core engine) |
| `/analytics` | ❌ Not built-in | ✅ Built-in (needs ToolAnalytics) |
| `/analytics:all` | ❌ Not built-in | ✅ Built-in (needs ToolAnalytics) |
| `/compact`, `/new`, `/resume`, etc. | ✅ | ✅ |

**pi-braid provides `/utility-model` and `/vision-model`** as extension commands — works on upstream_main.

### D.1. /analytics Commands — Implemented as Extension

**Develop branch**: `/analytics` and `/analytics:all` require the core `ToolAnalytics` class.

**pi-braid workaround**: Created a self-contained `analytics` extension at `src/extensions/analytics/index.ts` that provides:
- `/analytics` — current session stats (tool calls, durations, success rates, sequences)
- `/analytics:all` — historical summary across all sessions
- Uses `tool_execution_start` and `tool_execution_end` events to track timing and success
- Persists to `~/.pi/agent/analytics/tool-analytics.jsonl`

This is a simplified version of the core ToolAnalytics but provides the same commands.

### D.2. /retry Command — Limitation and Workaround

**Develop branch**: `/retry` uses `session.continue()` to remove the last assistant message and re-run that turn.

**upstream_main limitation**: `session.continue()` is NOT available in upstream_main. The extension can only:
1. Call `ctx.abort()` to stop the current operation
2. Send a steer message to inform the user

**pi-braid workaround**:
- Provides `/retry` command as an extension command
- Aborts the current operation via `ctx.abort()`
- Sends a steer message explaining the limitation and workarounds:
  - Type the request again to start fresh
  - Use `/compact` to summarize, then continue
  - Use the develop branch for full retry capability

**What would be needed from upstream**: Add `session.continue()` to the `ReadonlySessionManager` or `ExtensionContext` so extensions can implement full retry functionality.

### E. Extension Loader Runtime Stubs (CRITICAL BEHAVIORAL DIFFERENCE)

**On upstream_main**: Calling action methods during extension factory loading **THROWS**:
```typescript
sendMessage: notInitialized, // throws "Extension runtime not initialized"
sendUserMessage: notInitialized,
getActiveTools: notInitialized, // throws
getAllTools: notInitialized, // throws
getCommands: notInitialized, // throws
setModel: () => Promise.reject(new Error("...")),
getThinkingLevel: notInitialized, // throws
```

**On develop**: Same methods return **safe defaults**:
```typescript
sendMessage: () => {},
sendUserMessage: () => {},
getActiveTools: () => [],
getAllTools: () => [],
getCommands: () => [],
setModel: async () => false,
getThinkingLevel: () => "medium",
```

**Impact**: Extensions on upstream_main MUST NOT call `getCommands()`, `getActiveTools()`, `getAllTools()`, `sendMessage()`, etc. during the factory function (the synchronous initialization). All pi-braid extensions are written to handle this correctly — they use `session_start` event handlers for these calls, not factory-time calls.

### F. Resource Loader — How Extensions Are Loaded

**On develop**: `resource-loader.ts` explicitly calls `loadBundledExtensions(BUILT_IN_EXTENSIONS, ...)` to load 18 built-in extensions from the bundled dist.

**On upstream_main**: Extensions are loaded ONLY from:
- `additionalExtensionPaths` passed to `ResourceLoader`
- `extensionFactories` passed to `ResourceLoader`

**Both have the same files in `dist/core/builtin/extensions/`** — but upstream_main doesn't auto-load them. pi-braid provides these extensions as a directory extension, which fills this gap.

### G. settings-manager.ts — getUtilityModel/setUtilityModel

These methods exist on `SettingsManager` (not just ExtensionContext):
- `settingsManager.getUtilityModel()` → returns `settings.utilityModel`
- `settingsManager.setUtilityModel(pattern)` → sets and persists to `settings.json`

pi-braid's polyfill reads `settingsManager.get("utilityModel")` which should work equivalently, but could be updated to use the actual getter/setter methods.

### H. Compact Improvements (Context Chunking)

**Develop compaction** (+234 lines):
- When conversation exceeds model's context window, chunks messages and summarizes each chunk
- Then merges summaries into final summary
- Better token estimation and chunking algorithm

**Not extractable** — this is in `compaction.ts`. Extensions can influence compaction via `session_before_compact` event.

### I. model-registry.ts — getCheapModels()

**NEW method on develop**: `modelRegistry.getCheapModels(maxInputCost = 0.5, maxOutputCost = 2.0)` returns non-reasoning models sorted by cost.

pi-braid's polyfill reimplements this using `getAvailable()` and manual filtering. Functionally equivalent.

### J. CLI Args — --utility-model

**New on develop**: `--utility-model <pattern>` CLI argument. **Not in upstream_main.**

pi-braid provides `/utility-model` slash command instead, which works on upstream_main.

---

## 8. Verified Completeness — All 17 upstream_main→develop Commits Reviewed

```
5c12bbcde  chore: applied implicit framing + compliance-audit skill (captured)
7b1903e79  feat: preprocessor improvements (547 lines, captured)
fa4fdbd68  feat: refactor built-in tools, move scratchpad() to extensions (captured)
5c150b86e  feat: refactor built-in tools, extract to extensions (core-tools created, NOT in pi-braid ✓)
a7c97ef07  feat: refactor system_prompt, remove agents.md (captured by prompt-builder)
c73560d76  feat: Implicit Framing Engineering (captured by prompt-builder)
264d19fd4  refactor: consolidate builtin extensions (captured)
acdd53829  test: update enforcement tests (tests, not code)
ee5c1de1e  feat: replace regex detection with LLM judge (captured)
d6f036951  improve: loosen enforcement thresholds (captured)
37f8c5a0c  improve: system prompt, guidelines, vision, SKILL.md (captured)
85983244d  feat: implement hypothesize tool to call utility model (captured)
a4769416d  cleanup: remove reasoning alias, dead tools (captured)
36b2fca89  refactor: remove redundant/stub tools (captured)
0c548299b  fix: restore builtin extensions integrations (captured)
80a7c38d3  improve: compaction, model pickers, interactive mode (captured as much as possible)
9e8d0cc6a  feat: add 113 new builtin extensions, skills, tools (+22,484 lines, captured)
```

**Result**: All significant code changes captured. No critical items missed.

---

## 9. File Manifest

### pi-braid Structure
```
pi-braid/
├── package.json              # pi.extensions = ["./src/index.ts"]
├── tsconfig.json
├── README.md
├── .gitignore
├── docs/
│   └── GAP-ANALYSIS.md       # This file
├── skills/                   # 16 skill directories
│   ├── code-search/SKILL.md
│   ├── codebase-summary/SKILL.md
│   ... (14 more)
├── src/
│   ├── index.ts              # Main entry — loads all sub-extensions
│   ├── lib/                  # 13 utility modules
│   │   ├── async-storage.ts
│   │   ├── cognitive-memory.ts
│   │   ... (11 more)
│   ├── tools/                # 17 tool definitions
│   │   ├── think.ts
│   │   ├── goals.ts
│   │   ... (15 more)
│   └── extensions/           # 21 extension modules
│       ├── polyfill/index.ts           # NEW: Patches ctx.getUtilityModel/getVisionModel
│       ├── prompt-builder/index.ts     # NEW: Identity-framing system prompt
│       ├── codebase-tree/index.ts
│       ├── cognitive-systems/index.ts
│       ... (16 more)
```

### Import Mapping
All private imports remapped to public API:
- `../../../extensions/types.js` → `@mariozechner/pi-coding-agent`
- `../../../../extensions/types.js` → `@mariozechner/pi-coding-agent`
- `../../lib/*.js` → kept as-is (bundled locally)
- `../../tools/*.js` → kept as-is (bundled locally)
- `@mariozechner/pi-ai` → peer dependency
- `@mariozechner/pi-agent-core` → peer dependency
- `@sinclair/typebox` → direct dependency