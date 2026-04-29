# lib/global-state.ts

**Purpose**: Process-global state for pi-braid. Used sparingly — only for things that truly need cross-session or process-wide access (e.g., emergency rotation flag).

## State

```typescript
{
  emergencyRotation: boolean,
}
```

## Key Functions

| Function           | Description                                     |
| ------------------ | ----------------------------------------------- |
| `getGlobalState()` | Get or create the singleton global state object |

## Key Patterns

- **Process-singleton**: One state object per process. Not session-scoped. Use EXTREMELY sparingly.
- **Use case**: Emergency rotation flag needs to survive across session rotations within the same process. Session-scoped state would be lost on each rotation.
- **Thread safety**: Node.js single-threaded — no mutex needed. But shared between async handlers, so reads are safe (writes are atomic).
