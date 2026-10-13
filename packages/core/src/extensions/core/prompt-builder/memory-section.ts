/**
 * Memory section: surfaces persisted + session-scoped memory state as
 * plain-text pointer lines — a one-line directive, then one
 * `- <store> at <path>` line per store. `episodes` / `semantic` show the
 * on-disk path; `heuristics` is session-scoped (no path). Per-store entry
 * counts are NOT rendered (counts go stale at print time and carry no
 * behavioral value — read or query the stores on demand). Per-episode
 * snippets, outcome stats and per-type breakdowns are not surfaced either
 * (details live in the files).
 * Empty state still renders the directive + 3 pointer lines so the agent
 * knows the stores exist as concepts. The two paths are resolved on every
 * call, so a pinned braid home points at its own stores. Cached per session
 * (static content — no fingerprint needed); invalidated on RESOURCES_DISCOVER.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { episodesFilePath, semanticMemoryFilePath } from "../../../lib/config/braid-paths.js";

interface MemorySectionCacheState {
  section?: string;
}

/**
 * One `- <store> at <path>` pointer. The store path is resolved on every
 * call, so a pinned run names the tree the writers wrote to; a refused root
 * (no absolute braid home) names no directory, and the line says that
 * instead of pointing at the default tree's unreadable copy.
 */
function pointerLine(store: string, storePath: () => string): string {
  try {
    return `- ${store} at ${storePath()}`;
  } catch {
    return `- ${store} at (unresolved: no absolute braid root)`;
  }
}

/**
 * Render the memory pointer section as plain text + a one-line directive.
 * One `- <store> at <path>` line per store. Heuristics is session-scoped
 * and has no path. Same shape as the project-docs block.
 */
function renderMemoryBlock(): string {
  const lines: string[] = [
    "Memory stores — read or query on demand:",
    "",
    pointerLine("episodes", episodesFilePath),
    pointerLine("semantic", semanticMemoryFilePath),
    `- heuristics: session-scoped (no on-disk file)`,
  ];
  return lines.join("\n");
}

/** Get the cached section if already rendered, otherwise render + cache. */
export async function reconstructMemorySection(ctx: ExtensionContext): Promise<string> {
  const cache = getExtensionState<MemorySectionCacheState>(
    ctx,
    "prompt-builder/memory-cache",
    () => ({ section: undefined }),
  );
  if (cache.section !== undefined) {
    return cache.section;
  }
  cache.section = renderMemoryBlock();
  return cache.section;
}

/** Invalidate the cache. Called on `RESOURCES_DISCOVER`. */
export function resetMemorySectionCache(ctx: ExtensionContext): void {
  const cache = getExtensionState<MemorySectionCacheState>(
    ctx,
    "prompt-builder/memory-cache",
    () => ({ section: undefined }),
  );
  cache.section = undefined;
}
