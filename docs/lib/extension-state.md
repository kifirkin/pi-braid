# lib/extension-state.ts

**Purpose**: Session-scoped state factory. Solves the problem of module-level `const state = {}` bleeding between sessions when pi runs multiple sessions in one process.

## How It Works

Two-tier storage:

1. **Primary**: Stable string key derived from `ctx.sessionManager.getSessionFile()` or `getSessionId()`. Uses `Map<string, Map<string, unknown>>` — survives ctx object recreation between tool calls.
2. **Fallback**: `WeakMap<ExtensionContext, Map<string, unknown>>` — for contexts without sessionManager (legacy).

## Key Functions

| Function                               | Description                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `getExtensionState(ctx, key, factory)` | Get or create state bucket for this session + key. Factory called once per session. |
| `clearAllExtensionState(ctx)`          | Remove all state for this session (cleanup on shutdown)                             |
| `registerSessionCleanup(pi, ctx)`      | Register session_shutdown handler that calls `clearAllExtensionState`               |

## Usage Pattern

```typescript
const state = getExtensionState(ctx, "my-extension", () => ({
  counter: 0,
  items: [],
}));
```

## Key Patterns

- **Factory-once**: The factory is only called the first time `getExtensionState` is called with a given (session, key) pair. Subsequent calls return the same object.
- **Session survival**: Because it uses string keys (session file paths), state survives context object recreation between tool calls.
- **WeakMap cleanup**: The WeakMap fallback auto-cleans when ctx is garbage collected (no manual cleanup needed).
- **Cross-session isolation**: Different sessions get different state even within the same pi process.
