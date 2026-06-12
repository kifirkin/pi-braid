/**
 * File Mutation Queue - serializes writes to the same file.
 *
 * Problem: Concurrent async writes to the same file can cause corruption.
 * Solution: Per-file write queue with TTL-based deduplication and immediate
 * processing for single writes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";

const _log = createLogger("file-mutation-queue");

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

    // New queue entry
    if (!this.queues.has(path)) this.queues.set(path, []);
    const queue = this.queues.get(path)!;
    const entry: QueueEntry = { data, queuedAt: Date.now(), resolve: () => {} };
    queue.push(entry);

    // Schedule processing: next microtask for single writes, or immediately when deep
    if (queue.length === 1) {
      setTimeout(() => this.processQueue(path), 0);
    } else if (queue.length > this.options.maxQueueDepth) {
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
    const queue = this.queues.get(path);
    if (!queue || queue.length === 0) return;

    this.processing.add(path);
    this.queues.delete(path);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(entry.data, null, 2), "utf-8");
        entry.resolve();
      } catch (err) {
        _log.error(`FileMutationQueue: failed to write ${path}:`, err);
        entry.resolve(); // Don't hang
      }
    }

    this.processing.delete(path);
  }
}

export const fileMutationQueue = new FileMutationQueue();
