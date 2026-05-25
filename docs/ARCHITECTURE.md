# Architecture

> High-level overview of pi-braid's design. For extension development, see [EXTENSION-HOOKS.md](EXTENSION-HOOKS.md) and individual extension docs in [docs/extensions/](extensions/).

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

Extensions are grouped by **actual coupling** (shared events, tools, state):

| Module                 | Always-on | Purpose                               | Extensions                                                                                        |
| ---------------------- | --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **core**               | ✅        | Foundation layer                      | agent-patch, polyfill, metacognition, scratchpad, preprocessor, prompt-builder, agent-environment |
| **cognitive-quality**  | ✅        | Reasoning quality tools               | reasoning, verification, topic-drift, sycophancy-detector                                         |
| **enforcement**        | ✅        | RepE behavioral enforcement           | enforcement                                                                                       |
| **memory**             | ✅        | Memory stores + context lifecycle     | three-memory-stores, session-recall, context-manager, context-lifecycle, memory-agent-bridge      |
| **heartbeat**          | ✅        | Proactive cognitive scheduling        | heartbeat-scheduler, analytics                                                                    |
| **tools**              | ✅        | Cognitive utility tools               | timer, latent-activator                                                                           |
| **nudge**              | ✅        | Feedback/nudge injection              | feedback                                                                                          |
| **contrib**            | ✅        | Peripheral utilities (not cog. arch.) | diff, healthcheck, observatory, research, system-monitor, rate-limiter, tool-config               |
| **watchdog**           | ❌        | Error monitoring (opt-in)             | watchdog                                                                                          |
| **health-maintenance** | ❌        | Degradation recovery (opt-in)         | health-maintenance                                                                                |
| **error-tracking**     | ❌        | Error logging tools (opt-in)          | error-capture                                                                                     |

Cognitive extensions live at `src/extensions/<module>/<extension>/`. Peripheral utilities live at `src/contrib/<extension>/`.

## Module Config

Toggling: `BRAID_MODULES=cognitive-quality,enforcement,+error-tracking,-tools`

See `src/modules/definitions.ts` for the full list.

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
