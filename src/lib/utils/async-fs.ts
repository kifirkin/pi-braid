/**
 * Async filesystem utilities shared by extensions.
 *
 * Centralizes helpers that were previously duplicated across multiple
 * files (5 copies of `asyncExists` at the time of writing). The shape
 * is intentionally small - just the I/O primitives that show up in
 * several extensions.
 */

import { stat } from "node:fs/promises";

/**
 * Async-friendly path existence check.
 * Returns true if `stat(p)` resolves, false on any error (including ENOENT).
 *
 * Replaces `fs.existsSync` in async paths. The original sync version
 * blocks the event loop and is a known anti-pattern in the agent's
 * hot paths; the SDK's `loadProjectContextFiles` uses the same async
 * pattern (see `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js`).
 */
export async function asyncExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}
