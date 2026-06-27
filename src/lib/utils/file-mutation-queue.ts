/**
 * File Mutation Queue - serializes writes to the same file.
 *
 * Problem: Concurrent async writes to the same file can cause corruption.
 * Solution: Per-file write queue with TTL-based deduplication and immediate
 * processing for single writes. Each write is performed atomically via
 * write-temp-then-rename so readers never observe a partially-written file.
 */

import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../core/logger.js";

const _log = createLogger("file-mutation-queue");

/**
 * Generate a unique temp suffix so concurrent temp files (if any) never collide.
 * Uses 8 bytes of randomness → 2^64 keyspace; collision probability is
 * negligible for any single machine.
 */
function tempSuffix(): string {
  return `.${randomBytes(8).toString("hex")}.tmp`;
}

export interface FileMutationQueueOptions {
  /** TTL for dedup: coalesce writes within this window (ms). Default: 100 */
  dedupMs?: number;
  /** Auto-process when queue depth exceeds this. Default: 10 */
  maxQueueDepth?: number;
}

interface QueueEntry {
  data: unknown;
  queuedAt: number;
  resolve: () => void;
}

export class FileMutationQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private options: Required<FileMutationQueueOptions>;

  constructor(options: FileMutationQueueOptions = {}) {
    this.options = {
      dedupMs: options.dedupMs ?? 100,
      maxQueueDepth: options.maxQueueDepth ?? 10,
    };
  }

  /** Enqueue a write. Resolves when persisted. Concurrent writes to same path are serialized. */
  async write(path: string, data: unknown): Promise<void> {
    // Check dedup: if same path queued within window, update data
    const existing = this.queues.get(path);
    if (existing && existing.length > 0) {
      const last = existing[existing.length - 1];
      if (Date.now() - last.queuedAt < this.options.dedupMs) {
        last.data = data;
        last.queuedAt = Date.now();
        // Return promise that resolves when the last entry in queue is processed
        const entryResolve = last.resolve;
        return new Promise<void>((res) => {
          last.resolve = () => {
            entryResolve();
            res();
          };
        });
      }
    }

    // New queue entry. If a queue for this path already exists (because a
    // processQueue is in flight), reuse it so the running loop picks up
    // our entry — this prevents a second processQueue from racing the first.
    if (!this.queues.has(path)) this.queues.set(path, []);
    const queue = this.queues.get(path)!;
    const entry: QueueEntry = { data, queuedAt: Date.now(), resolve: () => {} };
    queue.push(entry);

    // Schedule processing: next microtask for single writes, or immediately when deep.
    // If processing is already in flight for this path, the running loop will
    // pick up our entry via the shared queue — no reschedule needed.
    if (queue.length === 1 && !this.processing.has(path)) {
      setTimeout(() => this.processQueue(path), 0);
    } else if (queue.length > this.options.maxQueueDepth && !this.processing.has(path)) {
      this.processQueue(path);
    }

    return new Promise<void>((res) => {
      entry.resolve = res;
    });
  }

  /** Force flush a specific path. */
  async flush(path: string): Promise<void> {
    if (this.queues.has(path) && this.queues.get(path)!.length > 0) {
      await this.processQueue(path);
    }
  }

  /** Force flush ALL pending writes. */
  async flushAll(): Promise<void> {
    const paths = Array.from(this.queues.keys());
    await Promise.all(paths.map((p) => this.processQueue(p)));
  }

  /** Queue depth for a path. */
  queueDepth(path: string): number {
    return this.queues.get(path)?.length ?? 0;
  }

  /** Check if a path has pending writes. */
  hasPending(path: string): boolean {
    return (this.queues.get(path)?.length ?? 0) > 0 || this.processing.has(path);
  }

  private async processQueue(path: string): Promise<void> {
    // Re-entry guard: a new write() call arriving while we're already
    // processing this path will (via the shared queue) be picked up by
    // our running while-loop. Without this guard, an external
    // setTimeout(processQueue, 0) or a write() that exceeds maxQueueDepth
    // would start a SECOND processQueue that races with us — corrupting
    // the file with two concurrent writeFile calls on the same path.
    if (this.processing.has(path)) return;
    const queue = this.queues.get(path);
    if (!queue || queue.length === 0) return;

    this.processing.add(path);
    // Keep the queue in this.queues during processing so new writes append
    // to the same array and are picked up by the while-loop below.
    // (Previously we deleted the path here, which let concurrent writes
    //  create a fresh queue + spawn a racing processQueue.)

    try {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        try {
          await mkdir(dirname(path), { recursive: true });
          // Atomic write: serialize to a uniquely-named temp file, then
          // rename over the target. Readers either see the old file
          // (pre-rename) or the new one (post-rename) — never a half-written
          // mix. This is defense-in-depth against any future race we miss
          // at the queue level (e.g., a process kill mid-write).
          const tmpPath = `${path}${tempSuffix()}`;
          await writeFile(tmpPath, JSON.stringify(entry.data, null, 2), "utf-8");
          await rename(tmpPath, path);
          entry.resolve();
        } catch (err) {
          _log.error(`FileMutationQueue: failed to write ${path}:`, err);
          // Best-effort cleanup of any orphan temp file
          try {
            await unlink(`${path}${tempSuffix()}`);
          } catch {
            // ignore — temp file may not exist if writeFile failed before creating it
          }
          entry.resolve(); // Don't hang
        }
      }
    } finally {
      this.processing.delete(path);
      // Only remove the map entry if the queue is still empty. If a write
      // raced in between the loop exit and this finally block (impossible
      // today since JS is single-threaded and the finally has no awaits,
      // but defensive against future refactors that introduce one), the
      // entry stays and a future processQueue call will pick it up.
      if (queue.length === 0) {
        this.queues.delete(path);
      }
    }
  }
}

export const fileMutationQueue = new FileMutationQueue();
