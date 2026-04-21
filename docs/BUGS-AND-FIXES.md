# Bug Report & Fixes — pi-braid Integration Session

## Session Context
**Date**: 2026-04-21  
**Task**: Execute INTEGRATION-PLAN.md + add structured logging  
**Branch**: `integration/harness-merge` → merged into `cleanup/refactor`

---

## Bug 1: `add-logging.mjs` Script Corrupted Multi-line Imports

**Severity**: HIGH  
**Status**: FIXED (manual repair)

### Root Cause
The automated script `scripts/add-logging.mjs` naively inserted `import { createLogger }` and `const log = createLogger(...)` after the first import line. For files with multi-line import blocks, this broke the import statement:

```typescript
// BEFORE (valid):
import {
  log, getCmState,
} from "./shared.js";

// AFTER (broken by script):
import {
import { createLogger } from "../../../lib/logger.js";
const log = createLogger("context-manager");
  log, getCmState,
} from "./shared.js";
```

### Files Affected
- `src/extensions/context-manager/handlers/compaction.ts`
- `src/extensions/context-manager/handlers/events.ts`
- `src/extensions/context-manager/handlers/navigation.ts`
- `src/extensions/context-manager/handlers/rotation.ts`
- `src/extensions/context-manager/handlers/tools.ts`
- `src/extensions/vision/index.ts`

### Fix Applied
Manually repaired all 6 files by:
1. Removing the incorrectly inserted `import { createLogger }` and `const log = ...` lines
2. For handlers that import `log` from `./shared.js`, keeping that import
3. For `vision/index.ts`, adding the logger import correctly at the top

### Prevention
- **Script deleted** (`scripts/add-logging.mjs` removed in commit)
- Future import-injection scripts must use an AST parser (e.g., `@babel/parser`) instead of regex/line insertion

---

## Bug 2: bash Tool Silent Output Truncation

**Severity**: MEDIUM  
**Status**: MITIGATED (awareness)

### Observation
Multiple bash commands in the session returned `(no output)` or empty results when they should have produced output. Examples:
- `echo "test"` → worked fine
- `diff -u ...` → sometimes `(no output)`
- `grep -rn ...` → `(no output)` with exit code 1 (grep found no matches)

### Root Cause
The bash tool returns `(no output)` in two distinct cases:
1. **Genuinely empty stdout** — command produced nothing
2. **Output truncated by context limits** — tool result was pruned

The agent sometimes cannot distinguish these cases, leading to false assumptions.

### Fix / Mitigation
- Always use `wc -l` or `head -N` to verify output exists
- Use `echo "marker"` as a canary in compound commands
- Prefer `read` tool for file inspection over `cat` via bash

---

## Bug 3: edit Tool Opaque Failures

**Severity**: MEDIUM  
**Status**: WORKAROUND (manual retry)

### Observation
Multiple edit tool calls failed silently or with unhelpful error messages. The agent had to retry edits with slightly different `oldText` patterns.

### Root Cause
The edit tool uses exact string matching. When:
- Line endings differ (LF vs CRLF)
- Whitespace is subtly different
- The file was already modified by a prior edit

…the match fails with no clear indication of *why*.

### Fix / Mitigation
- Use shorter `oldText` snippets (3-5 lines max) to reduce whitespace sensitivity
- Always verify file state with `read` before `edit`
- Consider using `write` for large structural changes instead of incremental edits

---

## Bug 4: think Tool Silent Failures

**Severity**: LOW  
**Status**: COSMETIC

### Observation
Error `err-mo8jy52h-vnoy` and others: "Tool failed: think" with no further detail.

### Root Cause
The `think` tool occasionally fails due to backend transient errors. The error provides no context about what went wrong.

### Fix / Mitigation
- think tool failures are non-blocking; the agent should continue
- Consider adding retry logic around think calls in the framework

---

## Bug 5: Git Worktree State Confusion

**Severity**: MEDIUM  
**Status**: RESOLVED

### Observation
Initial analysis of git state was incorrect. The agent assumed `harness/implicit-budget` was ahead of `cleanup/refactor`, but the reverse was true — `cleanup/refactor` had already merged harness content.

### Root Cause
The INTEGRATION-PLAN.md described a stale state (branches diverged at 605a0f9). In reality:
- `cleanup/refactor` HEAD = `4bbc54e` (already has harness content)
- `harness/implicit-budget` HEAD = `bab6841` (older)
- Merge base = `605a0f9`

The agent wasted several turns verifying this before proceeding.

### Fix / Mitigation
- Always run `git log --oneline --graph --all` at the start of any git operation
- Verify merge-base before assuming divergence direction

---

## Bug 6: Extension Registration Pattern Inconsistency

**Severity**: LOW  
**Status**: FIXED

### Observation
The 6 new extensions were copied to `src/extensions/` but not registered in `src/index.ts`. The `SUB_EXTENSIONS` array was missing entries for:
- analytics, feedback, latent-activator, rate-limiter, reasoning, watchdog

### Fix
Added imports and SUB_ENTRIES for all 6 extensions in `src/index.ts`.

---

## Bug 7: Logger Import Path Inconsistency

**Severity**: LOW  
**Status**: FIXED

### Observation
Extensions at different directory depths use inconsistent relative paths to `lib/logger.js`:
- Root extensions: `../../lib/logger.js`
- Sub-handlers: `../../../lib/logger.js`
- Some files use `taggedConsole`, others use `createLogger`

### Fix
No code change needed — this is by design. The import paths are correct relative to each file's location. However, the inconsistency in factory choice (`taggedConsole` vs `createLogger`) could be unified.

### Recommendation
Standardize on `createLogger` for all new extension code. `taggedConsole` is deprecated per `lib/logger.ts` comments.

---

## Tool Conceptual Issues (from session analysis)

### Issue A: `read_document` vs `read_pdf_screenshot` Confusion

**Problem**: The agent documentation states `read_document` extracts text from PDFs, but `read_pdf_screenshot` renders PDF pages as images. In practice:
- `read_document` on PDF → extracts text only (no layout, no images, no diagrams)
- `read_pdf_screenshot` on PDF → renders as PNG → then `analyze_image` on PNG

**Confusion**: When should the agent use each? The current heuristic seems to be:
1. Try `read_document` first (faster, gets text)
2. If text is garbled or PDF is image-based, use `read_pdf_screenshot` + `analyze_image`

**Fix needed**: Add a decision tree to `read_document` or `read_pdf_screenshot` tool descriptions.

### Issue B: `analyze_image` Expectations

**Problem**: `analyze_image` returns structured analysis, but agents often expect it to "understand" the image the way a human would. The output is actually:
- Domain detection (UI, game, document, etc.)
- Structured measurements
- Specific framework application

**Confusion**: Agents call `analyze_image` expecting it to replace reading text, but it's designed for visual analysis (UI elements, sprites, layout).

**Fix needed**: Clarify in tool description that `analyze_image` is for VISUAL analysis, not OCR. For text extraction from images/screenshots, use `read_document` or OCR tools.

### Issue C: Session Search Reliability

**Problem**: `session_search` returned no results for queries that should match (`pdf screenshot analyze image`).

**Possible causes**:
- Search index not populated for recent sessions
- Search operates on limited fields (only user messages?)
- Keyword matching is too strict

**Fix needed**: Document search scope and limitations. Consider adding session path directly from error context.

---

## Summary of Changes in This Session

| Change | Files | Lines |
|--------|-------|-------|
| Added 6 new extensions | 6 dirs | +1986 |
| Added enforcement files | 6 files | +~400 |
| Updated vision, healthcheck | 2 files | +~200/-900 |
| Added createLogger imports | ~50 files | +~150 |
| Fixed corrupted imports | 6 files | -~30/+~30 |
| Updated src/index.ts | 1 file | +~20 |
| Removed add-logging.mjs | 1 file | -~120 |
| **Total** | **~63 files** | **+2676/-721** |

---

## Recommendations

1. **Add a pre-merge verification script** that checks for:
   - All extensions registered in `src/index.ts`
   - No `console.*` in extensions (use createLogger)
   - Import paths are valid (no broken relative paths)

2. **Standardize logging** across all extensions using `createLogger`

3. **Improve tool documentation** for PDF/image workflows with clear decision trees

4. **Add AST-based refactoring scripts** instead of regex-based ones
