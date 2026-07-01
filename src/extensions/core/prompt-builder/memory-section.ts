/**
 * Memory section for the prompt-builder.
 *
 * Surfaces persisted + session-scoped memory state as a pointer block so
 * the agent knows what it has available before starting work. Mirrors the
 * skills and project-docs pattern: directive-first, then a
 * `<available_memories>` block with self-closing `<store>` entries that
 * carry their discoverability info (name + count + path or scope).
 *
 * Per-entry convention (matches skills and project-docs 1:1):
 *   - `<store name="..." count="N" path="..." />` for persisted stores
 *     (episodes, semantic). Path is the on-disk canonical location so the
 *     agent can `read` the file or invoke `memory` and find the data.
 *   - `<store name="heuristics" scope="session" />` for the session-scoped
 *     store. No path because heuristics don't persist.
 *
 * What is NOT in the block (mirrors skills):
 *   - Per-episode task snippets -- the data quality is dominated by the
 *     `session_outcome` placeholder sentinel and never tells the agent
 *     anything actionable. Details live in the file; the agent reads it
 *     on demand or invokes `memory` action=episodes_search.
 *   - Aggregate outcome stats (success/failure/partial counts) -- vanity
 *     metrics. If the agent cares, it queries; if it doesn't, the line
 *     is just decoration.
 *   - Per-type breakdown of semantic memories -- same reason.
 *
 * Empty state: still renders the directive + 3 self-closing `<store>`
 * entries (counts will be 0). Tells the agent the stores exist as
 * concepts; counts let it see at a glance whether there's anything to
 * recall. Rendering at 0 mirrors skills' "Skills (0 available): ...".
 *
 * Cache: rendered string is cached by a fingerprint derived from the
 * underlying file paths + mtime + size. Invalidated on `RESOURCES_DISCOVER`
 * (mirrors the skills and project-docs invalidation pattern) so the next
 * before_agent_start re-reads after /reload or session replacement.
 */

import { readFile, stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import {
  EPISODES_FILE,
  SEMANTIC_MEMORY_FILE,
} from "../../../lib/config/braid-paths.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("prompt-builder:memory-section");

// ── Types ───────────────────────────────────────────────────────────────────

/** Episode shape as serialized in EPISODES_FILE (subset used for the count). */
interface EpisodeLine {
  id?: string;
  task?: string;
  outcome?: "success" | "failure" | "partial";
  timestamp?: number;
  project?: string;
}

/** Semantic memory shape as serialized in SEMANTIC_MEMORY_FILE. */
interface SemanticFileShape {
  version?: number;
  memories?: Array<{
    id?: string;
    type?: string;
    content?: string;
    timestamp?: number;
  }>;
}

/** Aggregated view of persisted memory state, used to render the block. */
interface MemorySnapshot {
  episodes: { count: number };
  semantic: { count: number };
}

interface MemorySectionCacheState {
  fingerprint?: string;
  section?: string;
}

// ── File readers (counts only -- no content surfaced to the prompt) ─────────

/** Count total episodes by streaming the JSONL. Best-effort. */
async function countEpisodes(filePath: string): Promise<number> {
  let count = 0;
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const ep = JSON.parse(line) as { task?: unknown } | null;
        if (ep && typeof ep === "object" && ep.task) {
          count++;
        }
      } catch {
        /* skip */
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn(`countEpisodes(${filePath}) failed: ${e}`);
    }
  }
  return count;
}

/** Read the semantic store; return empty shape on any error. */
async function readSemantic(filePath: string): Promise<SemanticFileShape> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as SemanticFileShape;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn(`readSemantic(${filePath}) failed: ${e}`);
    }
    return { version: 1, memories: [] };
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function buildMemorySnapshot(): Promise<MemorySnapshot> {
  const [episodesCount, semanticFile] = await Promise.all([
    countEpisodes(EPISODES_FILE),
    readSemantic(SEMANTIC_MEMORY_FILE),
  ]);

  return {
    episodes: { count: episodesCount },
    semantic: { count: semanticFile.memories?.length ?? 0 },
  };
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Stable fingerprint of the persisted memory state. Uses file paths +
 * mtime + size so the cache invalidates when the on-disk stores change.
 * Cheap stat calls; no content reads.
 */
async function fingerprintMemoryFiles(): Promise<string> {
  const sources = [EPISODES_FILE, SEMANTIC_MEMORY_FILE];
  const parts: string[] = [];
  for (const p of sources) {
    try {
      const s = await stat(p);
      parts.push(`${p}:${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push(`${p}:missing`);
    }
  }
  return parts.join("|");
}

// ── Section render ─────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the `<available_memories>` block + a one-line directive.
 * Self-closing `<store>` entries carry name + count + path (or scope).
 * This is the uniform pointer style used by skills and project-docs.
 */
function renderMemoryBlock(snapshot: MemorySnapshot): string {
  const { episodes, semantic } = snapshot;

  const lines: string[] = [
    "Memory (episodes, semantic, heuristics): use `memory` to recall before non-trivial work. Stores live at the paths below; read or query on demand.",
    "<available_memories>",
    `  <store name="episodes" count="${episodes.count}" path="${escapeXml(EPISODES_FILE)}" />`,
    `  <store name="semantic" count="${semantic.count}" path="${escapeXml(SEMANTIC_MEMORY_FILE)}" />`,
    `  <store name="heuristics" scope="session" />`,
    "</available_memories>",
  ];
  return lines.join("\n");
}

// ── Cache + public API ─────────────────────────────────────────────────────

/** Get the cached section if the fingerprint matches, otherwise render + cache. */
export async function reconstructMemorySection(ctx: ExtensionContext): Promise<string> {
  const fingerprint = await fingerprintMemoryFiles();
  const cache = getExtensionState<MemorySectionCacheState>(
    ctx,
    "prompt-builder/memory-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  if (cache.fingerprint === fingerprint && cache.section !== undefined) {
    return cache.section;
  }
  const snapshot = await buildMemorySnapshot();
  const section = renderMemoryBlock(snapshot);
  cache.fingerprint = fingerprint;
  cache.section = section;
  return section;
}

/** Invalidate the cache. Called on `RESOURCES_DISCOVER`. */
export function resetMemorySectionCache(ctx: ExtensionContext): void {
  const cache = getExtensionState<MemorySectionCacheState>(
    ctx,
    "prompt-builder/memory-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  cache.fingerprint = undefined;
  cache.section = undefined;
}
