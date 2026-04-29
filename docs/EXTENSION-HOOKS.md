# Extension Hooks Reference

> How to hook into pi's event lifecycle. Based on canonical implementation in `src/extensions/cognitive/enforcement/index.ts`.

## Event Hooks

### `pi.on("message_end")`

The primary hook for analyzing responses after they're generated. Fires on every assistant message.

```typescript
import type { Extension, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function myExtension(): Extension {
  return {
    name: "my-extension",

    async onLoad(pi: ExtensionApi): Promise<void> {
      pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
        if (event.message?.role !== "assistant") return;

        // Extract text from multi-modal content
        const responseText = (event.message.content ?? [])
          .filter((c: MessageContentBlock) => c.type === "text")
          .map((c: TextContentBlock) => c.text)
          .join("\n");

        // event.message.content also has c.type === "thinking" blocks
        const thinking = (event.message.content ?? [])
          .filter((c: MessageContentBlock) => c.type === "thinking")
          .map((c: ThinkingBlock) => c.thinking)
          .join("\n");

        // ctx has: state, sessionManager, config, whisper (if enforcement loaded)
        const turn = (ctx as any).turnNumber ?? 0;
        const session = (ctx as any).sessionManager?.getCurrentSession?.();
        const history = session?.messages ?? [];

        // Process...
      });
    },
  };
}
```

**Important**: `message_end` fires AFTER the response is sent. There is no pre-response hook. You cannot intercept, veto, or rewrite the response.

### Other hooks

```typescript
// Check enforcement/index.ts for available hooks
pi.on("tool_result", async (event, ctx) => { ... });
pi.on("error", async (event, ctx) => { ... });
pi.on("turn_end", async (event, ctx) => { ... });
```

Search `pi.on(` in existing extensions to find all available hooks.

## Whisper System

Emit a soft correction in the next turn. From `enforcement/whisper.ts`:

```typescript
import { sendEnforcementWhisper } from "./whisper.js";

// In an extension's onLoad:
pi.on("message_end", async (event, ctx) => {
  sendEnforcementWhisper(pi, "Correction: the approach should use X instead of Y.");
});
```

**What it does**: Adds a whisper to the queue. Delivered in the next turn as a soft intervention. Rate-limited (1 per turn by default). Has cooldown to avoid spam.

## Policy Engine Signals

Emit structured signals into the belief policy engine. From `belief-policy-engine.ts`:

```typescript
import { emitSignal } from "../../../lib/belief-policy-engine.js";

// emitSignal(ctx, type, label, severity, anySignal, metadata)
emitSignal(
  ctx,
  "sycophancy", // signal type (must match a policy trigger)
  "detected", // label
  "warn", // severity: "info" | "warn" | "error"
  false, // anySignal (match any signal of this type)
  {
    // metadata
    tactics: ["AGREEABLENESS"],
    confidence: 0.8,
  },
);
```

The policy engine evaluates signals against policies and dispatches actions.

## CognitiveModule Registration

For periodic/latency-insensitive tasks (runs on heartbeat tick, not per-message).

### The interface

```typescript
interface CognitiveModule {
  name: string;
  priority: number; // Higher = runs first. Default modules: 10-80.
  shouldActivate(ctx: ModuleContext): boolean;
  activate(ctx: ModuleContext): Promise<void>;
}
```

### How to register

In `heartbeat-scheduler/index.ts`, add to the `builtInModules` array:

```typescript
// In builtInModules array:
const builtInModules: CognitiveModule[] = [
  // ... existing modules ...
  {
    name: "my-cognitive-module",
    priority: 50,
    shouldActivate(ctx: ModuleContext): boolean {
      // Return true when this module should run on this tick
      const signals = ctx.getSignals?.("my-signal-type") ?? [];
      return signals.length > 0;
    },
    async activate(ctx: ModuleContext): Promise<void> {
      // Periodic task: compliance scoring, meta-learning, etc.
    },
  },
];
```

### ModuleContext

Available in `shouldActivate` and `activate`:

```typescript
interface ModuleContext {
  turnCount: number;
  tokenCount: number;
  getSignals(type?: string): SemanticSignal[];
  state: ExtensionState; // key-value store
  // Plus ExtensionContext fields (state, sessionManager, etc.)
}
```

## ExtensionContext

Standard context passed to all hooks. Access via the `ctx` parameter:

```typescript
// From extension-context.d.ts
interface ExtensionContext {
  state: ExtensionState; // key-value store, persisted across turns
  sessionManager: SessionManager; // getHistory(), getCurrentSession()
  config: PiConfig; // agent settings
  turnNumber: number; // current turn (1-indexed)
  whisper?: WhisperFn; // send a whisper (if enforcement loaded)
  model?: ModelFn; // call the LLM
  // ... more
}
```

## Extension Registration

Register your extension in `src/extensions/cognitive/index.ts`:

```typescript
import myExtension from "./my-extension/index.ts";

export const COGNITIVE_EXTENSIONS: Extension[] = [
  enforcement,
  memoryEcho,
  beliefTracker,
  conflictQA,
  memoryWhisper,
  myExtension, // ← add here
];
```

## Common Patterns

### Pattern: Read previous user message + current response

```typescript
pi.on("message_end", async (event, ctx) => {
  if (event.message?.role !== "assistant") return;

  const responseText = getText(event.message.content);

  // Get the last user message from history
  const session = (ctx as any).sessionManager?.getCurrentSession?.();
  const messages = session?.messages ?? [];
  const userMessages = messages.filter((m: any) => m.role === "user");
  const lastUserText = getText(userMessages[userMessages.length - 1]?.content ?? "");

  // Now you have: lastUserText (the user's message)
  // and responseText (the agent's response to it)
});
```

### Pattern: Conditional whisper + signal emission

```typescript
pi.on("message_end", async (event, ctx) => {
  const responseText = getText(event.message.content);

  if (someCondition(responseText)) {
    // Whisper in next turn
    sendEnforcementWhisper(pi, "Consider: X might be wrong here.");

    // Signal for policy engine
    emitSignal(ctx, "my-signal", "detected", "warn", false, {
      detail: "something",
    });
  }
});
```

### Pattern: State accumulation across turns

```typescript
pi.on("message_end", async (event, ctx) => {
  const count: number = (ctx.state.get("my_counter") as number) ?? 0;
  ctx.state.set("my_counter", count + 1);

  if (count >= threshold) {
    // Act after N occurrences
    sendEnforcementWhisper(pi, "This has happened N times...");
  }
});
```

## Type Imports

```typescript
import type {
  Extension,
  ExtensionContext,
  ExtensionApi,
  MessageEndEvent,
  MessageContentBlock,
  TextContentBlock,
  ThinkingBlock,
} from "@mariozechner/pi-coding-agent";

import type { CognitiveModule, ModuleContext } from "../heartbeat/heartbeat-scheduler/index.js";
import type { SemanticSignal } from "../memory/context-lifecycle/types.js";
```

## Key Files

| File                                                    | Purpose                                                  |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `src/extensions/cognitive/enforcement/index.ts`         | **Canonical example** — `message_end` + whisper + signal |
| `src/extensions/cognitive/enforcement/whisper.ts`       | `sendEnforcementWhisper()`                               |
| `src/lib/belief-policy-engine.ts`                       | `emitSignal()`                                           |
| `src/extensions/heartbeat/heartbeat-scheduler/index.ts` | CognitiveModule registration                             |
| `src/extensions/memory/context-lifecycle/types.ts`      | `SemanticSignalType`, `ContextPolicy`, `PolicyAction`    |

---

_Reference implementation: `enforcement/index.ts`. Last updated: 2026-04-27._
