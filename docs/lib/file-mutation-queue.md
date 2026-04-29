# lib/file-mutation-queue.ts

**Purpose**: Atomic file write queue for safe concurrent mutation. Ensures writes don't interleave and provides rollback on failure.

## Key Functions

| Function                      | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `enqueueWrite(path, content)` | Queue a file write — returns a promise that resolves when committed |
| `flushAll()`                  | Wait for all queued writes to complete                              |
| `cancelPending(path?)`        | Cancel pending writes (optionally for a specific file)              |

## Key Patterns

- **Serial execution**: Writes are queued and executed serially — no concurrent writes to the same file.
- **Atomic per-file**: Each file's writes are sequenced. Multiple files can be written concurrently, but each file is serialized.
- **Rollback on error**: If a write fails, the queue catches the error and re-throws — the caller can retry or abort.
