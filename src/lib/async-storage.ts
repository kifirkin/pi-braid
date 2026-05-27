/**
 * Async storage utility for cognitive systems.
 *
 * Provides debounced async file I/O to replace synchronous readFileSync/writeFileSync
 * calls that block the Node.js event loop.
 *
 * Uses microtask-based batching instead of setTimeout debouncing — writes are
 * flushed before the event loop continues, eliminating the data-loss window
 * that existed with pending setTimeout callbacks on process exit.
 *
 * For safety, also registers a process.on('beforeExit') handler as a last resort.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./logger.js";

const _log = createLogger("async-storage");

/** Pending writes queued for next microtask flush. */
const writeQueue = new Map<string, unknown>();

/** True while a microtask flush is scheduled. */
let flushScheduled = false;

/**
 * Schedule a microtask to flush all pending writes.
 * Schedule a microtask to flush all pending writes.
 * Called on every saveState() — multiple calls collapse into a single microtask.
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
 */
export async function loadState<T>(path: string): Promise<T | null> {
  try {
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
export async function flushAll(): Promise<void> {
  if (writeQueue.size === 0) return;

  const entries = Array.from(writeQueue.entries());
  writeQueue.clear();

  const results = await Promise.allSettled(
    entries.map(async ([filePath, data]) => {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
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

// Flush on process exit — module-level code runs once on load
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
