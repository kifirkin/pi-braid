<!-- status: planning -->

# Context Navigation Pipeline — Design & Research Plan

**Status:** Planning. To be implemented in a fresh session.
**Priority:** P1 (immediate after P0 philosophical foundation).
**Goal:** Add a proper context navigation pipeline to braid's system prompt, with tool availability guards matching pi-core's native pattern, so the agent can navigate session trees to handle ultra-complex sessions without context bloat.

---

## 1. Research: pi-core's native pattern

### Tool availability guards

pi-core's `buildSystemPrompt()` in `system-prompt.js` checks which tools are available **before** adding guidelines:

```js
const hasBash = tools.includes("bash");
const hasGrep = tools.includes("grep");
const hasFind = tools.includes("find");
const hasRead = tools.includes("read");

if (hasBash && !hasGrep && !hasFind && !hasLs) {
  addGuideline("Use bash for file operations like ls, rg, find");
}
```

Key insight: **guidelines are conditional on tool availability.** If a tool isn't registered, the guideline for using it doesn't appear. This prevents the prompt from telling the agent to use a tool that doesn't exist.

### braid's current implementation

braid's `toolsSection()` in `prompt-builder/index.ts` partially mirrors this:

```js
const hasBash = toolNames.includes("bash");
const hasGrep = toolNames.includes("grep");
// ...same conditional pattern...
```

But it only covers pi-native tools (bash, grep, find, ls). **Context tools have no equivalent guards.** The guidelines don't tell the agent *when to use context_navigate vs context_compress vs context_inspect*, and they don't check which context tools are available.

### What's missing

1. **Context tool availability checks** — `hasContextNavigate`, `hasContextCompress`, `hasContextInspect`
2. **Pipeline guidelines** — "Tag → navigate → archive → inspect" as a procedure
3. **Strategy differentiation** — When to use navigate vs compact vs inspect
4. **Tagging discipline** — When and how to tag checkpoints

---

## 2. Proposed pipeline

### The core loop

```
[context heavy] → context_navigate(action='tag', name='checkpoint-N')
               → context_compress(action='archive', beforeTag='checkpoint-N')
               → context_navigate(action='log')  [verify health]
               → context_inspect(detail='quick') [verify context is manageable]
               → continue working
```

### When to use which tool

| Situation | Tool | Action |
|-----------|------|--------|
| Starting complex work | `context_navigate` | `action='tag', name='before-<task>'` |
| Context > 50% | `context_compress` | `action='archive', beforeTag='last-checkpoint'` |
| Context > 70% | `context_compress` | `action='compact', keep=10` |
| Lost in history | `context_navigate` | `action='log'` then `action='checkout'` |
| Before risky operation | `context_navigate` | `action='tag', name='before-<op>'` |
| After any checkpoint | `context_inspect` | `detail='quick'` |
| Session feels bloated | `context_inspect` | `detail='prune'` then act on candidates |

### The pipeline as a system prompt guideline block

Added to `toolsSection()` after the existing pi-native guidelines:

```markdown
### Context management strategy

When managing session context, use these tools in this order:

1. **context_navigate(action='tag')** — Tag your current position before any
   major operation. This creates a named save point you can jump back to.
2. **context_navigate(action='checkout')** — Jump to a tagged position when
   you need to explore a different branch or revisit earlier work.
3. **context_compress(action='archive')** — Archive old history before a tag
   when context exceeds 50%. This preserves the summary while freeing space.
4. **context_inspect(detail='quick')** — Check context health after any
   management operation.
```

Conditional: only show guidelines for tools that are actually available.

---

## 3. Implementation plan

### Files to modify

| File | Change |
|------|--------|
| `src/extensions/core/prompt-builder/index.ts` | Add context tool availability checks + pipeline guidelines to `toolsSection()` |
| `src/extensions/core/prompt-builder/identity.ts` | Add "Context Manager" as a self-management trait (or keep in guidelines) |
| `src/extensions/memory/context-manager/handlers/tools/context-navigate.ts` | Review `promptSnippet` + `description` for pipeline compatibility |
| `src/extensions/memory/context-manager/handlers/tools/context-compress.ts` | Same — ensure descriptions align with pipeline roles |
| `src/extensions/memory/context-manager/handlers/tools/context-inspect.ts` | Same — "health check" framing |

### Code sketch: `toolsSection()` additions

```typescript
// Context tool availability guards (pi-core pattern)
const hasContextNavigate = toolNames.includes("context_navigate");
const hasContextCompress = toolNames.includes("context_compress");
const hasContextInspect = toolNames.includes("context_inspect");

// Only add if at least one context tool is available
if (hasContextNavigate || hasContextCompress || hasContextInspect) {
  guidelineLines.push("");  // blank line separator
  guidelineLines.push("## Context management strategy");
  if (hasContextNavigate) {
    guidelineLines.push(
      "- Use context_navigate(action='tag') to save your position before major work.",
    );
    guidelineLines.push(
      "- Use context_navigate(action='checkout') to jump to a tagged position.",
    );
  }
  if (hasContextCompress) {
    guidelineLines.push(
      "- Use context_compress(action='archive') to free space when context > 50%.",
    );
  }
  if (hasContextInspect) {
    guidelineLines.push(
      "- Use context_inspect(detail='quick') to check context health after any operation.",
    );
  }
}
```

### Tool description updates

Each context tool's `description` should include a "when to use" line that matches the pipeline:

- **context_navigate**: "Tag your position, browse history, or jump to a checkpoint. Use action='tag' before major work, action='log' to explore, action='checkout' to return."
- **context_compress**: "Free context space by archiving or compacting. Use action='archive' with beforeTag when context > 50%. Use action='compact' as last resort."
- **context_inspect**: "Check context health. Use detail='quick' for a 5-line summary, detail='prune' to find candidates for removal."

---

## 4. Deep research questions

### 4.1. Can navigate replace agent-initiated compaction?

**Hypothesis:** With proper tagging discipline (`context_navigate(action='tag')` before every major operation), the agent can always jump back to a known-good state. The need for agent-initiated `context_compress` disappears — only pi-core auto-compact and overflow force-compact remain.

**Test:** Run a full session using only `context_navigate` for context management. No `context_compress` agent calls. Track:
- Does the agent ever hit pi-core's auto-compact threshold?
- How many tags are created per session?
- Does the agent's performance degrade as context grows?

**If hypothesis holds:** Remove `context_compress` from braid's active tool set. Defer to pi-core's native compaction. The agent focuses on tagging and navigating, not managing context space.

### 4.2. Tagging discipline design

What makes a good tag? What makes a bad tag?

**Good tags:**
- `before-refactor-X` — before a risky operation
- `checkpoint-N` — after completing a subtask
- `experiment-Y` — before trying an approach that might fail
- `investigation-Z` — before deep research that might branch

**Bad tags:**
- `tag-1`, `tag-2` — meaningless names
- `checkpoint` — no context, overwritten by next checkpoint
- Tags with no corresponding archive action

**Guideline:** "Tags should describe what you're about to do, not what you've done. `before-refactor-X` tells you what's at stake. `checkpoint-3` tells you nothing."

### 4.3. Context tool availability in deferred loading

If braid adopts deferred tool loading (pi-core compatibility refactoring), context tools would be in the deferred set. The pipeline guidelines must be conditional on whether the tools are currently active:

- If `context_navigate` is not active → don't show navigation guidelines
- If `context_compress` is not active → don't show compression guidelines
- If `context_inspect` is not active → don't show inspection guidelines

This is the pi-core pattern: guidelines are tool-availability-gated, not hardcoded.

### 4.4. Integration with heartbeat whisper

The heartbeat whisper already fires at context thresholds. It should be updated to suggest specific pipeline actions:

- At 50%: "Context at 50%. Consider: context_navigate(action='tag', name='before-cleanup') then context_compress(action='archive', beforeTag='before-cleanup')."
- At 70%: "Context at 70%. Consider: context_compress(action='compact', keep=10)."
- At 85%: "Context critical. Use context_navigate(action='checkout') to a recent checkpoint, or context_compress(action='compact', keep=5)."

---

## 5. Success criteria

1. Agent tags before every major operation in a session
2. Agent uses `context_navigate(action='checkout')` to explore branches instead of letting context grow
3. Agent-initiated `context_compress` calls drop by >80%
4. Context stays below 70% without agent-initiated compaction
5. The pipeline is documented in the system prompt with tool-availability guards
6. All 42 tests pass, typecheck clean

---

## 6. Open questions

1. **Should the pipeline be in identity.ts or toolsSection()?** Identity is "who braid is." ToolsSection is "what tools braid has and how to use them." The pipeline is a strategy — it belongs in guidelines, not identity. But a "Context Manager" self-management trait could reference the pipeline.

2. **Should the heartbeat whisper triggerTurn: true at critical levels?** Currently `triggerTurn: false` (advisory). At 85%, the agent might not see the whisper before the session crashes. But `triggerTurn: true` would interrupt the agent mid-thought. Trade-off.

3. **How does this interact with deferred tool loading?** If context tools are deferred, the pipeline guidelines are hidden until the agent activates them. The agent would need to know about context tools *before* they're active to activate them. Chicken-and-egg problem. Solution: keep context_navigate always active, defer only context_compress and context_inspect.

4. **What about the `context_proposals` tool?** It's part of the context lifecycle but not part of the pipeline. Should it be? Proposals are about auto-generated suggestions, not agent-initiated navigation. Keep separate.

---

## 7. Implementation order (fresh session)

1. Add context tool availability checks + pipeline guidelines to `toolsSection()` in `prompt-builder/index.ts`
2. Update `context_navigate` description with "when to use" framing
3. Update `context_compress` description with "when to use" framing
4. Update `context_inspect` description with "when to use" framing
5. Update heartbeat whisper with pipeline-specific suggestions
6. Run typecheck + tests (42/42)
7. Commit with message: `feat: add context navigation pipeline with tool availability guards`
8. Test: run a full session using only navigate, no agent-initiated compress