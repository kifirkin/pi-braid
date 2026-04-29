# Architecture

> High-level overview of pi-braid's design. For extension development, see [DEVELOPMENT.md](DEVELOPMENT.md).

## System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     pi Coding Agent                        │  ← pi host
│  - Tool execution, session lifecycle, LLM API             │
└──────────┬────────────────────────────┬──────────────────┘
            │                            │
            ▼                            ▼
┌──────────────────────────────┐  ┌──────────────────────────┐
│   pi-braid Extensions (35)    │  │   Skills (13)           │
│   - Cognitive capabilities    │  │   - Agent instruction    │
│   - Memory systems          │  │     sets per task type   │
│   - Enforcement signals      │  │   - Loaded at session    │
│   - Metacognition tools     │  │     start               │
└──────────────────────────────┘  └──────────────────────────┘
            │
            ▼
┌──────────────────────────────┐
│   Shared Libraries (lib/)    │
│   - extension-state.ts        │  ← session-scoped state factory
│   - evidence-pool.ts         │  ← belief tracking + conflict detection
│   - error-classifier.ts     │  ← error categorization
│   - conflict-qa.ts          │  ← contradiction resolution
│   - logger.ts              │  ← structured logging
└──────────────────────────────┘
```

## Extension Module Hierarchy

Extensions are grouped into 14 modules (`src/modules/definitions.ts`):

| Module                | Purpose                        | Extensions                                                              |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| **core**              | Always-on foundation           | polyfill, metacognition, planner, scratchpad, preprocessor              |
| **cognitive**         | RepE enforcement, reasoning    | cognitive-systems, reasoning, enforcement, verification, topic-drift    |
| **memory**            | Three memory stores, context   | three-memory-stores, session-recall, context-manager, context-lifecycle |
| **heartbeat**         | Proactive cognitive scheduling | heartbeat-scheduler, analytics                                          |
| **retry**             | Error recovery                 | retry, error-capture                                                    |
| **prompt**            | System prompt construction     | prompt-builder, prompt-guardian                                         |
| **tools**             | Utility tools                  | codebase-tree, repl, docs, healthcheck, timer, latent-activator         |
| **browser**           | Web interaction                | browser (CDP), web-fetch, vision                                        |
| **assistant**         | UX & feedback                  | assistant, feedback                                                     |
| **watchdog**          | Error monitoring (opt-in)      | watchdog                                                                |
| **evolve**            | Self-maintenance (opt-in)      | evolve                                                                  |
| **rate-limiter**      | Usage throttling (opt-in)      | rate-limiter                                                            |
| **agent-environment** | Runtime context (opt-in)       | agent-environment                                                       |

Each extension lives at `src/extensions/<module>/<extension>/index.ts`.

## State Management

All mutable state uses `getExtensionState(ctx, key, factory)` for session isolation:

```typescript
const state = getExtensionState(ctx, "my-ext", () => ({
  counter: 0,
  lastTurn: null,
}));
```

**Rule**: Never use module-level `let` for mutable session state. Use module-level `let` only for:

- Disk-persisted config
- Process-scoped constants

## Event Bus

pi emits events; extensions subscribe:

```typescript
pi.on("session_start", (_event, ctx) => { ... });
pi.on("turn_end",       (_event, ctx) => { ... });
pi.on("agent_end",      (_event, ctx) => { ... });
pi.on("before_agent_start", (_event, ctx) => { ... });
```

Event handlers receive `ExtensionContext` — always pass ctx to state accessors.

## Tool Registration

```typescript
pi.registerTool({
  name: "my_tool",
  description: "...",
  parameters: Type.Object({ ... }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const state = getExtensionState(ctx, "my-ext", factory);
    return { content: [{ type: "text", text: "result" }], details: {} };
  },
});
```

## Skills System

Skills are instruction sets loaded at session start. Each skill is a directory containing `SKILL.md`. Skills augment the system prompt with task-specific guidance.

- **User skills**: `~/.pi/agent/skills/`
- **Bundled skills**: `skills/` (project root)

See [SKILLS.md](SKILLS.md) for the full skill system documentation.
