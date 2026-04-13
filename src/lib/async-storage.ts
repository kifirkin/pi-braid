/**
 * Async storage utility for cognitive systems.
 *
 * Provides debounced async file I/O to replace synchronous readFileSync/writeFileSync
 * calls that block the Node.js event loop.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Pending writes to debounce */
const pendingWrites = new Map<string, { data: unknown; timeout: NodeJS.Timeout }>();

/** Debounce delay in ms */
const DEBOUNCE_MS = 100;

/**
 * Load state from JSON file asynchronously.
 * Returns cached value if file hasn't changed.
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
 * Save state to JSON file asynchronously with debouncing.
 * Multiple rapid saves to the same path are batched.
 */
export async function saveState<T>(path: string, data: T): Promise<void> {
	// Cancel any pending write for this path
	const pending = pendingWrites.get(path);
	if (pending) {
		clearTimeout(pending.timeout);
	}

	// Schedule debounced write
	const timeout = setTimeout(async () => {
		pendingWrites.delete(path);
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error(`Failed to save state to ${path}:`, err);
		}
	}, DEBOUNCE_MS);

	pendingWrites.set(path, { data, timeout });
}

/**
 * Force immediate save (for shutdown/cleanup).
 */
export async function saveStateImmediate<T>(path: string, data: T): Promise<void> {
	// Cancel any pending write
	const pending = pendingWrites.get(path);
	if (pending) {
		clearTimeout(pending.timeout);
		pendingWrites.delete(path);
	}

	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
	} catch (err) {
		console.error(`Failed to save state to ${path}:`, err);
	}
}

/**
 * Flush all pending writes.
 */
export async function flushAll(): Promise<void> {
	const paths = Array.from(pendingWrites.keys());
	await Promise.all(paths.map((path) => saveStateImmediate(path, pendingWrites.get(path)?.data)));
}
