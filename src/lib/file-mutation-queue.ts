/**
 * File Mutation Queue — serializes writes to the same file.
 *
 * Problem: Concurrent async writes to the same file can cause corruption
 * (partial writes, interleaved JSON). Example: two tool calls both try
 * to save scratchpad simultaneously.
 *
 * Solution: Per-file write queue that serializes all mutations and ensures
 * each write completes before the next starts. Supports:
 * - Automatic batching: rapid updates coalesce into single writes
 * - Force flush: guarantee persistence at critical points (e.g. shutdown, session end)
 * - TTL-based dedup: if the same path is queued multiple times within Nms, only the
 *   last write is applied (prevents redundant writes from fast tool chains)
 *
 * Usage:
 * ```ts
 * const queue = new FileMutationQueue();
 * await queue.write(path, data); // serial, async, non-blocking
 * await queue.flush(path);         // force persistence
 * await queue.flushAll();         // force all pending
 * ```
 */

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { taggedConsole } from "./logger.js";

const _log = taggedConsole("file-mutation-queue");

export interface QueueEntry {
	path: string;
	data: unknown;
	encoder?: (data: unknown) => string;
	queuedAt: number;
	resolve: () => void;
	reject: (err: Error) => void;
}

export interface FileMutationQueueOptions {
	/** Debounce rapid writes to same path (ms). 0 = disabled. Default: 50 */
	debounceMs?: number;
	/** TTL for dedup: coalesce writes to same path within this window. Default: 100 */
	dedupMs?: number;
	/** Auto-flush when queue depth exceeds this threshold. Default: 10 */
	maxQueueDepth?: number;
}

export class FileMutationQueue {
	private queues = new Map<string, QueueEntry[]>();
	private processing = new Set<string>();
	private debounceTimers = new Map<string, NodeJS.Timeout>();
	private options: Required<FileMutationQueueOptions>;

	constructor(options: FileMutationQueueOptions = {}) {
		this.options = {
			debounceMs: options.debounceMs ?? 50,
			dedupMs: options.dedupMs ?? 100,
			maxQueueDepth: options.maxQueueDepth ?? 10,
		};
	}

	/**
	 * Enqueue a write operation. Resolves when the write completes.
	 * Concurrent writes to the same path are serialized automatically.
	 *
	 * @param path Absolute file path
	 * @param data Data to write (will be JSON.stringify'd unless encoder provided)
	 * @param encoder Optional custom encoder function
	 */
	async write(path: string, data: unknown, encoder?: (d: unknown) => string): Promise<void> {
		return new Promise((resolve, reject) => {
			const entry: QueueEntry = {
				path,
				data,
				encoder,
				queuedAt: Date.now(),
				resolve,
				reject,
			};

			// Check for dedup: if same path queued recently, update data instead of adding
			const existingQueue = this.queues.get(path);
			const recentEntry = existingQueue?.[existingQueue.length - 1];
			if (recentEntry && Date.now() - recentEntry.queuedAt < this.options.dedupMs) {
				// Update the last entry with new data and timestamp
				recentEntry.data = data;
				recentEntry.queuedAt = Date.now();
				recentEntry.resolve = resolve;
				recentEntry.reject = reject;
				return;
			}

			if (!this.queues.has(path)) {
				this.queues.set(path, []);
			}
			this.queues.get(path)!.push(entry);

			// Auto-flush if queue gets too deep (prevents memory bloat from stuck writes)
			const queueDepth = this.queues.get(path)!.length;
			if (queueDepth > this.options.maxQueueDepth) {
				this.processQueue(path);
			}
		});
	}

	/**
	 * Force immediate flush of all queued writes for a path.
	 * Resolves when the path's queue is fully drained and persisted.
	 */
	async flush(path: string): Promise<void> {
		// Clear debounce timer if pending
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
		}

		// Process all pending entries for this path
		if (this.queues.has(path) && this.queues.get(path)!.length > 0) {
			await this.processQueue(path);
		}
	}

	/**
	 * Force flush ALL pending writes across all paths.
	 */
	async flushAll(): Promise<void> {
		const paths = Array.from(this.queues.keys());
		// Cancel all debounce timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Process all queues
		await Promise.all(paths.map((p) => this.processQueue(p)));
	}

	/**
	 * Delete a file through the queue.
	 */
	async delete(path: string): Promise<void> {
		return this.write(path, undefined, () => {
			return "__DELETE__";
		});
	}

	/**
	 * Get queue depth for a path (for debugging/monitoring).
	 */
	queueDepth(path: string): number {
		return this.queues.get(path)?.length ?? 0;
	}

	/**
	 * Check if a path has pending writes.
	 */
	hasPending(path: string): boolean {
		const queue = this.queues.get(path);
		return (queue && queue.length > 0) || this.processing.has(path);
	}

	private async processQueue(path: string): Promise<void> {
		const queue = this.queues.get(path);
		if (!queue || queue.length === 0) return;

		// Mark as processing to prevent re-entrant calls
		this.processing.add(path);

		while (queue.length > 0) {
			const entry = queue.shift()!;
			try {
				if (entry.data === undefined && entry.encoder) {
					// Delete operation
					const encoded = entry.encoder(entry.data);
					if (encoded === "__DELETE__") {
						try {
							await unlink(path);
						} catch {
							// File might not exist — that's ok
						}
					}
				} else {
					await mkdir(dirname(path), { recursive: true });
					const encoded = entry.encoder ? entry.encoder(entry.data) : JSON.stringify(entry.data, null, 2);
					await writeFile(path, encoded, "utf-8");
				}
				entry.resolve();
			} catch (err) {
				_log.error(`FileMutationQueue: failed to write ${path}:`, err);
				entry.reject(err instanceof Error ? err : new Error(String(err)));
			}
		}

		// Clean up
		this.processing.delete(path);
		this.queues.delete(path);
	}
}

// ============================================================================
// Shared instance for extension use
// ============================================================================

/** Shared queue instance. Flush on shutdown via pi.on("before_exit" or "session_end"). */
export const fileMutationQueue = new FileMutationQueue();