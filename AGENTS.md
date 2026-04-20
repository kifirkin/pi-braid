# pi-braid Developer Guide

## Project Structure

```
src/
  index.ts          # Main entry point
  tools/            # Built-in tools (think, finalize, repl, etc.)
  extensions/       # pi-braid extensions
    enforcement/    # Signal enforcement
      handlers/     # Modular enforcement sub-handlers
    heartbeat-scheduler/  # Proactive cognitive scheduling (paper 2604.14178)
    three-memory-stores/   # Episodes + heuristics + tool reliability (paper 2604.14475)
    metacognition/   # Think/hypothesize/finalize tools
    context-manager/ # Context analysis, pruning, retry
    ...
  lib/             # Shared libraries
    extension-state.ts    # Session-scoped state factory
    evidence-pool.ts      # Evidence tracking + conflict detection
    conflict-qa.ts        # Conflict QA + resolution questions
    error-classifier.ts   # Error classification + retry logic
    mars-reflector.ts     # MARS reflection engine
    belief-policy-engine.ts
    topic-drift-detector.ts
    reasoning-metrics.ts
    degradation-detector.ts
skills/             # Bundled agent skills
test/runtime/      # Runtime tests (.mjs)
```

## Build & Test

- **Type check**: `npx tsc --noEmit --skipLibCheck`
- **Build**: `npx esbuild src/index.ts --bundle --format=esm --outdir=dist`
- **Run locally**: `pi -e /Users/kifir/projects/agents/pi-braid/src/index.ts`
- **Runtime tests**: `node test/runtime/test-*.mjs`

## State Management

- Use `getExtensionState(ctx, key, factory)` for session-scoped state
- Never use module-level `let` for mutable state (except disk-persisted config)
- Event handlers receive `(event, ctx: ExtensionContext)` as parameters
- Tool execute functions receive `(toolCallId, params, signal, onUpdate, ctx)`

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are auto-enabled on first session (fixes missing tools bug)
- Prompt-builder completely overrides system prompt (no native loading)
- Decompose large handlers into `handlers/*.ts` sub-modules