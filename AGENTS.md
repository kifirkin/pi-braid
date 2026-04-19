# pi-braid Developer Guide

## Project Structure

```
src/
  index.ts          # Main entry point
  tools/            # Built-in tools (think, finalize, repl, etc.)
  extensions/       # pi-braid extensions
    prompt-builder/ # System prompt reconstruction
    metacognition/  # Think/hypothesize/finalize tools
    enforcement/    # Signal enforcement
    ...
skills/             # Bundled agent skills
```

## Build & Test

- **Type check**: `npx tsc --noEmit --skipLibCheck`
- **Build**: Standard pi build (handled by pi CLI)
- **Run locally**: `pi -e /Users/kifir/projects/agents/pi-braid/src/index.ts`

## Key Conventions

- Extensions register via `pi.registerTool()` and `pi.on("event", handler)`
- Tools added by extensions are NOT auto-enabled - use `pi.setActiveTools()`
- Prompt-builder completely overrides system prompt (no native loading)
- Extension tools auto-enabled on `before_agent_start` in metacognition