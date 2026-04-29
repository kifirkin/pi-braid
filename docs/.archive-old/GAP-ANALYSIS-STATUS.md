# pi-braid Gap Analysis: GAP-ANALYSIS vs Current State

**Purpose**: Compare what was identified as captured/not-captured in the original GAP-ANALYSIS with current pi-braid implementation status.

**Generated**: 2026-04-23 | **Source**: vibe/implicit-framing/.archive/braid-stable-snapshot/braid-stable/pi-braid/docs/GAP-ANALYSIS.md

---

## Summary: What Was Identified

The GAP-ANALYSIS categorized changes into 5 areas:

| Category                  | Status in pi-braid                                           |
| ------------------------- | ------------------------------------------------------------ |
| A. Extension API Surface  | ✅ All covered (polyfill for getUtilityModel/getVisionModel) |
| B. Core Tool Changes      | ⚠️ Partial (B1 read vision check not implemented)            |
| C. Compaction             | ⚠️ Partial (session_before_compact event exists)             |
| D. TUI / Interactive Mode | ❌ Not applicable (extension-only)                           |
| E. Infrastructure         | ⚠️ Partial (tool-analytics rebuilt as extension)             |

---

## Category A: Extension API Surface

| Item                                             | GAP Finding                         | Current pi-braid Status                                          |
| ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| **A1. ExtensionContext.runtime**                 | Needs `runInContext()`              | ✅ `runtime` polyfill exists                                     |
| **A2. Dynamic cwd via ctxFactory**               | Tool factory parameter              | ⚠️ Not needed for current tools                                  |
| **A3. `pi.registerTool()`** with `promptSnippet` | Tool descriptions in prompt         | ✅ `prompt-builder` uses `pi.getAllTools()` + `promptSnippet`    |
| **A4. `session_before_compact` event**           | Custom summary via event            | ✅ Exists in context-manager                                     |
| **A5. `utilityModel`/`visionModel` settings**    | New getters/setters                 | ✅ `polyfill` adds `/utility-model` and `/vision-model` commands |
| **A6. `getCheapModels()`**                       | Non-reasoning sorted by cost        | ✅ Polyfill implements via `getAvailable()`                      |
| **Session directory event**                      | `session_directory` event           | ❌ Not implemented (not needed for core functionality)           |
| **Input confirm action**                         | `{ action: "confirm" }` result type | ❌ Not implemented (extension would need this)                   |

**Assessment**: All critical Extension API gaps are bridged. Remaining items (session_directory, confirm action) are nice-to-haves.

---

## Category B: Core Tool Changes

| Item                               | GAP Finding                                                 | Current pi-braid Status                                                  |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| **B1. Vision-aware read**          | Check `model.input.includes('image')` before sending images | ⚠️ **NOT IMPLEMENTED** — Cannot override core `read` tool from extension |
| **B2. Dynamic cwd via ctxFactory** | Tool factory parameter for `ctxFactory`                     | ⚠️ Not needed for current tools                                          |

**B1 Gap — Recommended Action**:
The GAP-ANALYSIS recommended proposing an upstream PR. This is still the best path:

- pi-braid cannot override core tools from an extension
- The check would need to be in the core `read` tool

**Current Workaround**: `polyfill` has vision model detection but `read` tool sends images regardless.

---

## Category C: Compaction

| Item                    | GAP Finding                                         | Current pi-braid Status                        |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------- |
| **C1. Compact rewrite** | `session_before_compact` event for custom summaries | ✅ Event exists and is used in context-manager |
| **Compaction logic**    | Core compaction can't be overridden                 | ⚠️ Accepts main's compaction (acceptable)      |

**Assessment**: pi-braid uses the core compaction with custom summarization via the event. This is the correct approach per GAP-ANALYSIS recommendation.

---

## Category D: TUI / Interactive Mode

| Item      | GAP Finding              | Current pi-braid Status                            |
| --------- | ------------------------ | -------------------------------------------------- |
| **D1-D3** | Ink/React TUI components | ❌ Not applicable — extensions can't replicate TUI |

**Assessment**: Correctly accepted as un-bridgeable. `/utility-model` and `/vision-model` slash commands provide equivalent functionality.

---

## Category E: Infrastructure

| Item                               | GAP Finding                                       | Current pi-braid Status                                                      |
| ---------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **E1. `agent-session.ts`**         | Time tracking, utility model, skill block parsing | ❌ Accept gap                                                                |
| **E2. `agent-session-runtime.ts`** | Runtime bootstrap rewrite                         | ❌ Accept gap                                                                |
| **E3. `resource-loader.ts`**       | Bundled extension loading                         | ❌ Accept gap                                                                |
| **E4. `main.ts`**                  | CLI args, runtime bootstrap                       | ❌ Accept gap                                                                |
| **E5. `tool-analytics.ts`**        | Entirely new analytics module                     | ✅ **Rebuilt as extension** — `analytics` extension with full feature parity |
| **E6. `parse-tags.ts`**            | New tag parsing utility                           | ✅ Bundled locally where needed                                              |
| **E7. `keybindings.ts`**           | Minor keybinding changes                          | ❌ Accept gap                                                                |
| **E8. `slash-commands.ts`**        | Minor additions                                   | ❌ Accept gap                                                                |
| **E9. `cli/args.ts`**              | CLI arg changes                                   | ❌ Accept gap                                                                |

**Assessment**: The tool-analytics rebuild is the most significant infrastructure win. Full feature parity achieved.

---

## Recommended Upstream PRs (from GAP-ANALYSIS)

| PR                                                           | Status           | pi-braid Notes                                                       |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------- |
| **PR 1: Vision-Aware Read Tool**                             | ⚠️ Not submitted | Still the best solution for B1. Would benefit all users.             |
| **PR 2: getUtilityModel/getVisionModel on ExtensionContext** | ✅ Superseded    | polyfill extension achieves equivalent functionality. PR not needed. |
| **PR 3: Dynamic cwd via ctxFactory**                         | ⚠️ Not needed    | Current tools work without this. Low priority.                       |

---

## Key Insights from GAP-ANALYSIS

### 1. System Prompt is #1

> "The system prompt itself evolved from MUST/ALWAYS/NEVER directives to identity framing."

**pi-braid status**: ✅ **ACHIEVED**

- `prompt-builder` implements full identity framing
- System prompt is rebuilt from structured state, not parsed text
- 245 lines from ~460, ~30-40% token reduction

### 2. Extension API is Sufficient

> "The extension API is sufficient for everything except getUtilityModel/getVisionModel"

**pi-braid status**: ✅ **CONFIRMED**

- All critical APIs are available or polyfilled
- No blocking gaps in the extension architecture

### 3. Core Tool Override Limitation

> "Cannot override the core read tool from an extension"

**pi-braid status**: ⚠️ **ACCEPTED**

- This is a fundamental pi architecture constraint
- Vision-aware read needs upstream PR

### 4. AGENTS.md Progressive Extraction

> "The AGENTS.md was progressively gutted (81 → 44 → 0 lines) and replaced by the system prompt builder."

**pi-braid status**: ✅ **COMPLETED**

- `prompt-builder` is the replacement
- No AGENTS.md dependency

---

## Current Gaps: What Remains

| Priority  | Item                           | GAP Category | Recommendation                           |
| --------- | ------------------------------ | ------------ | ---------------------------------------- |
| 🔴 HIGH   | **B1: Vision-aware read tool** | B            | Submit upstream PR or accept token waste |
| 🟡 MEDIUM | **session_directory event**    | A            | Nice-to-have, not critical               |
| 🟡 MEDIUM | **Input confirm action**       | A            | Nice-to-have for user confirmations      |
| 🟢 LOW    | **PR 3: Dynamic cwd**          | B            | Not needed currently                     |

---

## Verification Checklist

- [x] ExtensionContext.runtime polyfill
- [x] `/utility-model` and `/vision-model` commands
- [x] `tool-analytics` rebuilt as extension
- [x] `session_before_compact` event usage
- [x] `prompt-builder` full identity framing
- [x] All 33 extensions documented and cataloged
- [ ] **B1: Vision-aware read** (needs upstream PR)
- [ ] **session_directory event** (nice-to-have)
- [ ] **Input confirm action** (nice-to-have)

---

## Related Documents

- `docs/archive/H8_extension_docs.md` — Extension catalog
- `docs/BRAID-CONSOLIDATED-TASKS.md` — Work tracker
- `evaluation/` — Benchmark suite
- `vibe/implicit-framing/` — Research foundation
