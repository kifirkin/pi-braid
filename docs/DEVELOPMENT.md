# pi-braid Developer Guide

> **Start here**: [RESEARCH-MASTER.md](RESEARCH-MASTER.md) is the single source of truth for all research, gaps, proposals, and execution plans. This document is the technical companion.

## Project Overview

pi-braid is an extension layer on top of the pi coding agent. It adds cognitive capabilities:
session isolation, enforcement signals, context management, metacognition, and memory systems.

**Key stats**: 0 TypeScript errors | 76+ runtime tests | 29 extensions | ~25k lines

## Branching Strategy

```
main                    ← production-ready, always tagged
├── v0.6.1-stable       ← latest stable baseline
└── cleanup/refactor     ← current cleanup work

# For new features:
main → feature/my-feature → (test) → merge → main
```

### Rules
- **`main`** is always buildable and testable. Never commit broken code.
- **Feature branches** branch from `main`, not from other feature branches.
- **Tags** mark stable baselines: `v0.6.1`, `v0.6.1-stable`
- **Commits** follow conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Pre-commit Checklist

Before every commit, verify:

```bash
# 1. Type check
npx tsc --noEmit --skipLibCheck

# 2. All runtime tests pass
node test/runtime/test-error-classifier.mjs
node test/runtime/test-conflict-qa.mjs
node test/runtime/test-evidence-pool.mjs
node test/runtime/test-heartbeat.mjs
node test/runtime/test-memory-stores.mjs
node test/runtime/test-integration.mjs

# 3. Smoke test (optional, requires pi + API key)
python3 scripts/smoke-test-decomposition.py
```

## Extension Structure

Every extension follows this pattern:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { getExtensionState } from "../../lib/extension-state.js";

// ── Types ─────────────────────────────────────────────────────────────────
interface MyState {
  counter: number;
}

// ── Factory ──────────────────────────────────────────────────────────────
function createState(): MyState {
  return { counter: 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────────
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ── Extension ────────────────────────────────────────────────────────────
export default function myExtension(pi: ExtensionAPI) {
  const log = createLogger("my-extension");

  // Tools
  pi.registerTool({ name, label, description, parameters, execute: async (_id, params, _sig, _update, ctx) => {
    const state = getExtensionState(ctx, "my-extension", createState);
    return textResult(`Counter: ${state.counter}`);
  }});

  // Event handlers
  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    state.counter = 0;
  });
}
```

## Key Conventions

### State Management
```typescript
// Session-scoped state — use getExtensionState
const state = getExtensionState(ctx, "my-extension", createState);

// NEVER use module-level let for mutable state
// (except: disk-persisted config, process-scoped singletons)

// Create a named factory function
function createMyState(): MyState { return { ... }; }
```

### Tool Execute Return Type
```typescript
// ✅ Correct — AgentToolResult format
return { content: [{ type: "text" as const, text: "result" }], details: {} };

// ❌ Wrong — raw string
return "result";

// Helper pattern
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
```

### Event Handlers
```typescript
// ✅ Correct signature
pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => { ... });

// ❌ Missing ctx
pi.on("turn_end", async (event) => { getState(event.ctx); }); // wrong
```

### Logging
```typescript
// ✅ Always use createLogger
const log = createLogger("my-extension");
log.info("Session started");
log.warn("Something unexpected");
log.debug("Detail for debugging");

// ❌ Never use console.*
console.log("debug");   // breaks TUI
console.error("err");  // breaks TUI
```

### Empty Catch Blocks
```typescript
// ✅ Always add context comment
} catch (err) {
  // Non-fatal: gracefully handle missing ctx.getContextUsage
}
```

### Decomposition
Large extensions (>600 lines) should be decomposed into `handlers/`:
```
enforcement/
  index.ts              ← orchestrator, event handlers, tool registrations
  handlers/
    tool-tracker.ts      ← input/output tracking
    blocking.ts          ← tool blocking logic
    message-analysis.ts  ← complexity, routing, stability
    turn-analysis.ts     ← turn-end subroutines
    orphan-chains.ts     ← thought chain analysis
    probe-handler.ts     ← complexity probe logic
    routing-handler.ts    ← intent routing logic
```

## Testing Strategy

### Runtime Tests (`test/runtime/test-*.mjs`)
Pure JavaScript ESM tests that import from `dist/`. No TypeScript compilation needed. Fast, focused on logic.

```bash
# Run all tests
for t in test/runtime/test-*.mjs; do node "$t"; done
```

### Smoke Tests (`scripts/smoke-test-*.py`)
End-to-end integration via pi RPC mode. Tests that tools actually work in a live agent session.

```bash
# Requires: pi CLI, API key, running model
python3 scripts/smoke-test-decomposition.py
```

### Build first (for runtime tests)
Runtime tests import from `dist/`. Build before running:
```bash
npm run build
```
Or run tests directly (builds automatically):
```bash
npm test
```

## Releasing

```bash
# 1. Ensure main is clean
git checkout main
git pull

# 2. Run full verification
npx tsc --noEmit --skipLibCheck
node test/runtime/test-*.mjs

# 3. Tag
git tag -a v0.X.Y -m "v0.X.Y — changelog summary"

# 4. Also tag stable baseline
git tag -a v0.X.Y-stable -m "v0.X.Y stable baseline"
```

## Research Integration

Before implementing new features, check [RESEARCH-MASTER.md](RESEARCH-MASTER.md) for:
- Part 4: Whether the gap is already identified
- Part 6: Whether relevant research papers have been analyzed
- Part 7: Recommended execution order

### Quick Research Lookup

| Want to add | See RESEARCH-MASTER |
|-------------|---------------------|
| New extension | Part 4 (Gap Registry) |
| New behavior | Part 6 (Research Cross-Reference) |
| Prompt change | Part 5 (Today's Work) + implicit-framing docs |
| Benchmark | Part 8 (Metrics & Success Criteria) |
| Bug fix | Part 3 (Infrastructure Theater) |

## Extension Loading Order

Extensions load in order defined in `src/index.ts`. Order matters:

1. **early-load** extensions run first (event handlers fire before others register)
2. **normal** extensions run in declaration order
3. **late-load** extensions run last

Current order:
```
prompt-builder → user-message-preprocessor → scratchpad → context-lifecycle
→ cognitive-systems → context-manager → enforcement → metacognition
→ heartbeat-scheduler → three-memory-stores
```

Note: `heartbeat-scheduler` and `three-memory-stores` run last — they depend on other extensions' state.

> ⚠️ **Infrastructure Theater Warning**: `heartbeat-scheduler` loads but `policy engine`, `dreamer`, and `meta-learning` modules never activate (see [RESEARCH-MASTER.md Part 3](RESEARCH-MASTER.md#part-3-infrastructure-theater-analysis)).

## Common Patterns

### Cross-extension State Access
```typescript
// Read another extension's session state via getExtensionState
function getEnforcementState(ctx: ExtensionContext): EnforcementState {
  return (ctx as any).getExtensionState?.("enforcement")
    ?? createEnforcementState(); // fallback for testing
}
```

### Testing with Mock Context
```javascript
const mockCtx = {};
const state = getExtensionState(mockCtx, "my-ext", createMyState);
state.counter = 42;
// test...
```

### Adding a New Tool
1. Register in extension's `pi.registerTool()`
2. Use `textResult()` helper for return value
3. Use `getExtensionState(ctx, "name", factory)` for session state
4. Add runtime test in `test/runtime/test-myfeature.mjs`
5. Run full test suite before committing
