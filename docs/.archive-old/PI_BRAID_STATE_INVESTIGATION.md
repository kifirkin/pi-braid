# pi-braid Current State Investigation

**Date**: 2026-04-19  
**Goal**: Identify messy parts that need tackling before future work

---

## Summary: What's Been Done vs What's Left

### ✅ Progress Made

| Area                    | Before | After | Status         |
| ----------------------- | ------ | ----- | -------------- |
| Extensions              | 35     | 27    | 8 dead removed |
| `as any` casts          | ~80    | ~45   | 44% reduction  |
| Sync FS calls           | ~200   | ~70   | 65% reduction  |
| Type.Union → StringEnum | ~15    | 0     | Done           |
| Hypothesis scoring      | No     | Yes   | Implemented    |

### ❌ Remaining Issues

| Priority | Issue                                | Impact                        | Files                   |
| -------- | ------------------------------------ | ----------------------------- | ----------------------- |
| P0       | `process.cwd()` for session state    | Branch switching breaks state | scratchpad, enforcement |
| P0       | Module-level mutable state           | Session isolation fails       | All extensions          |
| P1       | Sync FS in settings/tools            | Event loop blocking           | 4 extensions            |
| P1       | Dead extension deletions uncommitted | Dirty git state               | enforcement, etc.       |
| P2       | No dependency declaration            | Load order fragile            | index.ts                |
| P2       | No health reporting                  | Failed loads silent           | All extensions          |

---

## P0: process.cwd() Issues

### scratchpad/index.ts (Line 373)

```typescript
function resolveProjectSlug(cwd?: string): string {
  try {
    return projectSlugFromCwd(cwd ?? process.cwd()); // ← P0
  } catch {
    return "default";
  }
}
```

**Problem**: When user switches branches, `process.cwd()` returns the OLD directory. State gets saved to wrong project.

**Fix needed**: Always use `ctx.cwd` from tool execute context.

### enforcement/index.ts (Line 72)

```typescript
const resolvedPath = isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath); // ← P1
```

**Problem**: File path resolution uses `process.cwd()`. Less critical than scratchpad but still problematic.

---

## P0: Module-Level Mutable State

Every extension uses module-level mutable state. Example from scratchpad:

```typescript
let _taskStore: TaskStore | null = null;
let _currentProjectSlug: string = "";

// These persist across branch switches
```

**Problem**: When pi navigates to a different session branch, these singletons still hold state from the old branch.

**Fix needed**: Store state in tool result `details`, reconstruct on `session_start`.

---

## P1: Sync FS in Critical Paths

### user-message-preprocessor/index.ts

```typescript
// Lines 87-107: Settings loading/saving
if (!existsSync(SETTINGS_FILE)) return defaultValue;
const content = readFileSync(SETTINGS_FILE, "utf-8");
// ...
writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
```

**Problem**: Blocking calls during settings access.

### prompt-guardian/index.ts

```typescript
// Lines 42-50: Prompt storage
return JSON.parse(fs.readFileSync(file, "utf-8")) as SavedPrompt[];
// ...
fs.writeFileSync(getPromptsFile(), JSON.stringify(prompts, null, 2));
```

**Problem**: Blocking calls for prompt storage.

### repl/index.ts

```typescript
// Lines 72-81: File content loading
if (!existsSync(resolvedPath)) throw new Error(`File not found`);
return parseContent(readFileSync(resolvedPath, "utf-8"));
```

**Problem**: Sync file reads for content loading.

---

## P1: Uncommitted Dead Extension Deletions

From `git status`, these files show as deleted but not staged:

- `src/extensions/ab-testing/` (954 lines)
- `src/extensions/analytics/` (441 lines)
- `src/extensions/latent-activator/` (444 lines)
- `src/extensions/query-optimizer/` (407 lines)
- `src/extensions/rate-limiter/`
- `src/extensions/reasoning/` (155 lines)
- `src/extensions/visual-dashboard/`
- `src/extensions/watchdog/`

**Problem**: Git state is dirty. Can't cleanly build or deploy.

**Fix needed**: `git add -A && git commit` to finalize deletions.

---

## P2: No Dependency Declaration

Current `src/index.ts`:

```typescript
const SUB_EXTENSIONS: ExtensionFactory[] = [
  // context-lifecycle goes AFTER context-manager
  polyfill,
  // ... 27 extensions in hardcoded order
];
```

**Problem**: Order maintained by comments only. No explicit dependencies.

**Fix needed**: Add dependency declaration system:

```typescript
const SUB_EXTENSIONS: Array<{
  name: string;
  factory: ExtensionFactory;
  depends?: string[];
}> = [
  { name: "polyfill", factory: polyfill },
  { name: "prompt-builder", factory: promptBuilder, depends: ["polyfill"] },
  // ...
];
```

---

## P2: No Health Reporting

Current extension loading:

```typescript
try {
  ext(pi);
} catch (err) {
  logger.error(`Failed to load ${name}: ${err}`);
  continue; // Silent continue
}
```

**Problem**: No way to know which extensions loaded successfully.

**Fix needed**: Add reporting mechanism:

```typescript
try {
  ext(pi);
  pi.reportHealth?.(name, { status: "loaded" });
} catch (err) {
  pi.reportHealth?.(name, { status: "failed", error: err.message });
  logger.error(`Failed to load ${name}: ${err}`);
}
```

---

## What's Clean: The Good News

### metacognition (759 lines)

- Uses StringEnum correctly (no Type.Union)
- Has hypothesis scoring (Task 7 done)
- No obvious process.cwd() issues
- Clean event handler types

### enforcement (924 lines)

- New fields for Task 4a (toolsSinceReflection, thoughtChains)
- Clean implementation
- Using fileMutationQueue for writes

### Codebase structure

- Extensions are reasonably organized
- Uses modern TypeScript patterns
- Has async-storage.ts for when async is used

---

## Recommended Execution Order

### Immediate (Today)

1. **Commit dead extension deletions** — Clean git state
2. **Fix scratchpad process.cwd()** — P0 session isolation

### This Week

3. **Fix enforcement process.cwd()** — File path resolution
4. **Add async settings in user-message-preprocessor** — Blocking issue
5. **Add dependency declaration** — Unblocks future work

### Later

6. **Module-level → session-scoped state** — Major refactor
7. **Async migration for remaining sync calls** — Lower priority
8. **Health reporting** — Nice to have

---

## What NOT To Touch (It's Working)

- `metacognition/` — Clean, well-structured
- `context-manager/` — Large but functional
- `prompt-builder/` — Core, working
- `browser/`, `vision/`, `assistant/` — Extension APIs work correctly

---

## Status Check Commands

```bash
# Check for process.cwd() issues
grep -r "process\.cwd()" src/extensions/ --include="*.ts"

# Check for sync FS
grep -r "readFileSync\|writeFileSync" src/extensions/ --include="*.ts" | wc -l

# Check for as any
grep -r "as any" src/extensions/ --include="*.ts" | wc -l

# Check git state
git status --short
```

---

## Files to Modify

| File                                        | Changes                    | Priority |
| ------------------------------------------- | -------------------------- | -------- |
| `src/extensions/scratchpad/index.ts`        | Use ctx.cwd                | P0       |
| `src/extensions/enforcement/index.ts`       | Use ctx.cwd for paths      | P1       |
| `src/extensions/user-message-preprocessor/` | Async settings             | P1       |
| `src/index.ts`                              | Add dependency declaration | P2       |
| `src/index.ts`                              | Add health reporting       | P2       |
| `src/extensions/prompt-guardian/`           | Async prompts              | P2       |
| `src/extensions/repl/`                      | Async file reads           | P2       |

---

## Integration with Future Work

These fixes unblock the research roadmap:

- **P0 session isolation** → Required for all memory stores
- **Async migration** → Required for evidence pool
- **Dependency declaration** → Required for heartbeat scheduler
- **Health reporting** → Required for measuring system health

Fix these first, then implement the cognitive architecture.
