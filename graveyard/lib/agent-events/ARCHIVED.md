# agent-events.ts — Unified Event Taxonomy

**Origin**: Commit `ffd1b227` — "feat: P2.2 event taxonomy + P2.3 project-scoped memory boundary"

**What it was supposed to do**: Formalize pi-braid's async event model as documented types
and an `emitSignal()` function driving the belief-policy-engine. Defined the full event
taxonomy table: stability, tool-use, reflection, context, etc.

**Why it was abandoned**: Superseded by the actual implementations:
- `lib/event-bus.ts` — concrete event bus with typed events
- `lib/consolidation-channel.ts` — signal processing pipeline
- `lib/belief-policy-engine.ts` — policy evaluation engine

The event taxonomy concept was correct but the file was never imported — the actual code
was split across multiple specific modules with better separation of concerns.

**What replaced it**: `lib/event-bus.ts`, `lib/consolidation-channel.ts`, `lib/belief-policy-engine.ts`

**Tests**: None.

**Git history**: `git log --oneline --follow src/lib/agent-events.ts`
- `d4b12a12` Move enforcement physical folder
- `8f1883fe` fix: legacy memory migration
- `09b67b55` fix: source quality — remove dead code
- `2d12362f` chore: eslint config + deps
- `ffd1b227` feat: P2.2 event taxonomy