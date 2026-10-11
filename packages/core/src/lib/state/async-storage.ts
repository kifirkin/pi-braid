/**
 * Async storage utility for cognitive systems.
 *
 * Provides debounced async file I/O to replace synchronous readFileSync/writeFileSync
 * calls that block the Node.js event loop.
 *
 * Uses microtask-based batching instead of setTimeout debouncing - writes are
 * flushed before the event loop continues, eliminating the data-loss window
 * that existed with pending setTimeout callbacks on process exit.
 *
 * For safety, also registers a process.on('beforeExit') handler as a last resort.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";

const _log = createLogger("async-storage");

/** Pending writes queued for next microtask flush. */
const writeQueue = new Map<string, unknown>();

/** True while a microtask flush is scheduled. */
let flushScheduled = false;

/**
 * Schedule a microtask to flush all pending writes.
 * Schedule a microtask to flush all pending writes.
 * Called on every saveState() - multiple calls collapse into a single microtask.
 */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(async () => {
    flushScheduled = false;
    await flushAll();
  });
}

/**
 * Load state from JSON file asynchronously.
 *
 * Load-side size seatbelt (the write-side MAX_STATE_JSON_CHARS guard in
 * flushAll only bounds saves): a polluted state file on disk (the
 * OOM: degradation.json at ~508MB) must not be read into
 * memory and JSON.parsed — stat first, refuse oversized files.
 */
export async function loadState<T>(path: string): Promise<T | null> {
  try {
    const stats = await stat(path);
    if (stats.size > MAX_STATE_JSON_CHARS) {
      _log.warn(
        `Refusing to load ${path}: file is ${Math.round(stats.size / 1024 / 1024)}MB ` +
          `(limit ${MAX_STATE_JSON_CHARS / 1024 / 1024}MB). ` +
          "An oversized state file is pollution — delete/rotate the file instead of loading it.",
      );
      return null;
    }
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Save state to JSON file asynchronously with microtask-based batching.
 * Multiple rapid saves to the same path are coalesced into a single write.
 *
 * Unlike the previous setTimeout-based debounce, this guarantees the write
 * completes before the event loop continues. Zero data-loss window.
 */
export async function saveState<T>(path: string, data: T): Promise<void> {
  writeQueue.set(path, data);
  scheduleFlush();
}

/**
 * Force immediate save (for shutdown/cleanup).
 * Flushes all pending writes synchronously-asynchronously.
 */
export async function saveStateImmediate<T>(path: string, data: T): Promise<void> {
  // Cancel any pending microtask flush
  writeQueue.set(path, data);
  await flushAll();
}

/**
 * Flush all pending writes to disk.
 */
/**
 * Max serialized size for a single state file (~10 MB). The OOM:
 * degradation.json grew to 87MB+ because polluted metrics entries embedded
 * the full session graph; JSON.stringify then exceeded the V8 string limit
 * ("Invalid string length") and every flush re-serialized the giant graph.
 * Past this bound the write is SKIPPED with a loud error naming the file —
 * a skipped save is recoverable, an OOM'd process is not.
 */
const MAX_STATE_JSON_CHARS = 10 * 1024 * 1024;

export async function flushAll(): Promise<void> {
  if (writeQueue.size === 0) return;

  const entries = Array.from(writeQueue.entries());
  writeQueue.clear();

  const results = await Promise.allSettled(
    entries.map(async ([filePath, data]) => {
      try {
        let json: string;
        try {
          json = JSON.stringify(data, null, 2);
        } catch (err) {
          // Serialize-failure guard (same class as the size bound below):
          // circular refs or V8 string-limit overflow must not kill the flush.
          _log.error(`Failed to serialize state for ${filePath} (skipping save):`, err);
          return;
        }
        if (json.length > MAX_STATE_JSON_CHARS) {
          _log.error(
            `Refusing to save ${filePath}: state is ${Math.round(json.length / 1024 / 1024)}MB ` +
              `(limit ${MAX_STATE_JSON_CHARS / 1024 / 1024}MB). ` +
              "An accumulating state is leaking — trim/rotate the source instead of persisting it.",
          );
          return;
        }
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, json, "utf-8");
      } catch (err) {
        _log.error(`Failed to save state to ${filePath}:`, err);
      }
    }),
  );

  const failures = results.filter((r) => r.status === "rejected").length;
  if (failures > 0) {
    _log.warn(`${failures}/${entries.length} async writes failed`);
  }
}

/**
 * Initialize shutdown safety. Registers a beforeExit handler that flushes
 * any remaining writes before the process exits. Safe to call multiple times.
 *
 * Also exposed as shut down integration for pi session shutdown handlers.
 */
export async function shutdownAsyncStorage(): Promise<void> {
  await flushAll();
}

// ── Shutdown flush handlers (registered ONCE per process) ────────────────────
// pi /reload re-evaluates the extension import tree, so module-level
// `process.on(...)` calls at load time would stack a fresh beforeExit/SIGINT/
// SIGTERM handler trio on every reload (redundant flushAll on exit). We gate
// registration on a `globalThis` marker (process-global, survives any module
// re-evaluation) rather than `process.listenerCount`: pi-core may register its
// own SIGINT handlers before this module loads, so listenerCount gating would
// suppress the durability net entirely.

const _GLOBAL_REGISTERED_KEY = "__braid_async_storage_shutdown_registered__";

/**
 * Register the process-exit flush handlers exactly once per process.
 *
 * Idempotent across module re-execution: the first call registers all three
 * handlers (beforeExit/SIGINT/SIGTERM) and sets the `globalThis` marker;
 * every subsequent call (including module re-evaluation on pi /reload) is a
 * no-op. Behavior is otherwise unchanged - all three handlers still flush.
 */
export function ensureShutdownHandlers(): void {
  const g = globalThis as any;
  if (g[_GLOBAL_REGISTERED_KEY]) return;
  g[_GLOBAL_REGISTERED_KEY] = true;

  // Flush on process exit - registered once per process
  process.on("beforeExit", async () => {
    await flushAll();
  });
  // Also catch SIGINT/SIGTERM when possible
  process.on("SIGINT", async () => {
    await flushAll();
  });
  process.on("SIGTERM", async () => {
    await flushAll();
  });
}

// Register on load; module re-evaluation (pi /reload) is a no-op via the marker.
ensureShutdownHandlers();
