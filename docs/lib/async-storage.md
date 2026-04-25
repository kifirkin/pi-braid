# lib/async-storage.ts

**Purpose**: Async wrappers for `fs/promises` with safe JSON read/write. Used by extensions that need persistent state.

## Key Functions

| Function | Description |
|----------|-------------|
| `loadState(path)` | Async JSON read with `Try<unknown>` — returns `None` if file doesn't exist or is invalid |
| `saveStateImmediate(path, data)` | Async JSON write with `try/catch` |
| `saveStateDelayed(path, data, delayMs?)` | Debounced async JSON write — good for high-frequency updates |
| `readJsonl(path)` | Async read of JSONL file → parsed objects array |
| `appendJsonl(path, data)` | Async append a JSON object to a JSONL file |

## Key Patterns

- **Safe reads**: `loadState` uses `Try<unknown>` monad — no throw for missing files. Returns `Some(data)` or `None`.
- **Debounced writes**: `saveStateDelayed` debounces writes with configurable delay (default 1s). Prevents file thrashing.
- **JSONL append**: `appendJsonl` appends `JSON.stringify(data) + "\n"` — atomic per-line operations.
