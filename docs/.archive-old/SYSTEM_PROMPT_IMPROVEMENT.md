# PI-BRAID System Prompt Improvement Plan

**Date:** 2026-04-17  
**Problem:** Model confused about tool availability, overlapping tools across 30+ extensions

## Root Causes

1. **30+ extensions** registered in pi-braid, many overlapping:
   - `context-*` tools in both context-manager and context-lifecycle
   - `memory_*` tools in cognitive-systems and session-recall
   - `scratchpad` in its own extension

2. **No centralized tool catalog** - model doesn't know what tools exist

3. **Enforcement state is a hack** - accessing non-existent `ctx.enforcementState`

## Solution: AGENTS.md as Single Source of Truth

Created `/Users/kifir/projects/agents/pi-braid/AGENTS.md` with:

- Clear identity statement
- Tool philosophy (proactive, multi-turn)
- Categorized tool list
- Behavioral guidelines
- Key tool combinations

## Next Steps

### 1. Verify AGENTS.md loads

Test that pi with pi-braid extension now loads the AGENTS.md content.

### 2. Simplify Extension Architecture

Consider consolidating:

- context-manager + context-lifecycle → single context extension
- cognitive-systems + session-recall → single memory extension

### 3. Create Tool Discovery Tool

Add a `tools` or `help` tool that lists available tools in organized categories.

### 4. Remove Redundant Tools

Remove or rename overlapping tools to reduce confusion.

### 5. Document Extension API

Create documentation for ExtensionAPI so future extensions don't try to access non-existent state.

## Files to Review

- `src/extensions/context-manager/index.ts` - overlapping with context-lifecycle
- `src/extensions/context-lifecycle/index.ts` - new extension with overlapping tools
- `src/extensions/cognitive-systems/index.ts` - memory tools
- `src/extensions/session-recall/index.ts` - more memory tools
- `src/extensions/enforcement/index.ts` - state access issue

## Testing

After improvements, run benchmark to verify:

1. Model correctly lists available tools
2. PI-BRAID still encourages more REPL usage
3. Task completion rates improve
