/**
 * Memory section for the prompt-builder.
 *
 * Surfaces persisted memory state as a pointer block so the agent knows
 * what it has available before starting work. Mirrors the skills and
 * project-docs pattern: directive-first, then a `<available_memories>`
 * block with counts and a few recent entries, no content injection.
 *
 * What is surfaced (read from on-disk canonical paths):
 *   - Episodes:   EPISODES_FILE (JSONL). Count + last 3 task summaries.
 *   - Semantic:   SEMANTIC_MEMORY_FILE (JSON). Count + type breakdown.
 *   - Heuristics: NOT surfaced here. Heuristics are session-scoped in
 *                 memory (three-memory-stores MemoryStoresState) and
 *                 are not persisted across sessions. The agent can
 *                 discover them via `memory` action=heuristics_list
 *                 when relevant.
 *
 * Empty state: returns "" so the section is omitted entirely.
 *
 * Cache: rendered string is cached by a fingerprint derived from the
 * underlying file paths + sizes. Invalidated on `RESOURCES_DISCOVER`
 * (mirrors the skills-section and project-docs-section invalidation
 * pattern) so the next before_agent_start re-reads after /reload or
 * session replacement.
 *
 * Why pointer-only (not content injection):
 *   - The same pattern that worked for skills and project docs.
 *   - The agent already has 90%+ of its tool calls on bash/read/edit;
 *     a visible block listing "you have N episodes, here are 3" is
 *     enough to flip the model from "ignore memory" to "recall first".
 *   - Full content injection would re-bloat the prompt (the 506-call
 *     evidence: cross-session memory was effectively invisible even
 *     though a past-insights whisper fires once per session).
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

/** Episode shape as serialized in EPISODES_FILE (subset used for the pointer). */
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
  episodes: {
    count: number;
    recent: EpisodeLine[];
    outcomes: { success: number; failure: number; partial: number };
  };
  semantic: {
    count: number;
    byType: Record<string, number>;
  };
}

interface MemorySectionCacheState {
  fingerprint?: string;
  section?: string;
}

// ── File readers ────────────────────────────────────────────────────────────

/** Parse the last N episodes from a JSONL file. Returns [] on any error. */
async function readRecentEpisodes(filePath: string, n: number): Promise<EpisodeLine[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const out: EpisodeLine[] = [];
    // Walk from the end - episodes are appended chronologically.
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        const ep = JSON.parse(lines[i]);
        if (ep && typeof ep === "object" && ep.task) {
          out.push(ep as EpisodeLine);
        }
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn(`readRecentEpisodes(${filePath}) failed: ${e}`);
    }
    return [];
  }
}

/** Count total episodes by streaming the JSONL. Best-effort. */
async function countEpisodes(filePath: string): Promise<{
  count: number;
  outcomes: { success: number; failure: number; partial: number };
}> {
  const outcomes = { success: 0, failure: 0, partial: 0 };
  let count = 0;
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const ep = JSON.parse(line) as { task?: unknown; outcome?: unknown } | null;
        if (ep && typeof ep === "object" && ep.task) {
          count++;
          const o = ep.outcome;
          if (o === "success" || o === "failure" || o === "partial") {
            outcomes[o]++;
          }
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
  return { count, outcomes };
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
  const [episodeStats, recent, semanticFile] = await Promise.all([
    countEpisodes(EPISODES_FILE),
    readRecentEpisodes(EPISODES_FILE, 3),
    readSemantic(SEMANTIC_MEMORY_FILE),
  ]);

  const byType: Record<string, number> = {};
  for (const m of semanticFile.memories ?? []) {
    const t = m.type ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  return {
    episodes: {
      count: episodeStats.count,
      recent,
      outcomes: episodeStats.outcomes,
    },
    semantic: {
      count: semanticFile.memories?.length ?? 0,
      byType,
    },
  };
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Stable fingerprint of the persisted memory state. Uses file paths +
 * mtime+size so the cache invalidates when the on-disk stores change.
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

function formatOutcome(outcome: string | undefined): string {
  if (outcome === "success") return "✅";
  if (outcome === "failure") return "❌";
  return "⚠️";
}

function renderMemoryBlock(snapshot: MemorySnapshot): string {
  const { episodes, semantic } = snapshot;

  // Empty state - skip the section entirely.
  if (episodes.count === 0 && semantic.count === 0) {
    return "";
  }

  const lines: string[] = [
    "Memory is your first knowledge in context. Before non-trivial work, recall from past sessions and evolved heuristics — you have seen similar tasks before. The `memory` tool covers recall (semantic), episodes (case-based), and heuristics (procedural rules).",
    "<available_memories>",
  ];

  // Episodes block
  lines.push("  <store name=\"episodes\">");
  lines.push(`    <count>${episodes.count}</count>`);
  if (episodes.outcomes.success + episodes.outcomes.failure + episodes.outcomes.partial > 0) {
    lines.push(
      `    <outcomes>success:${episodes.outcomes.success} failure:${episodes.outcomes.failure} partial:${episodes.outcomes.partial}</outcomes>`,
    );
  }
  if (episodes.recent.length > 0) {
    lines.push("    <recent>");
    for (const ep of episodes.recent) {
      const taskSnippet = (ep.task ?? "").slice(0, 100);
      // Skip project tag if missing or "unknown" - noisy default not worth rendering.
      const projectTag =
        ep.project && ep.project !== "unknown" ? ` [${ep.project}]` : "";
      const ageDays =
        ep.timestamp && Date.now() - ep.timestamp > 0
          ? Math.floor((Date.now() - ep.timestamp) / 86_400_000)
          : null;
      const ageTag = ageDays != null ? ` (${ageDays}d ago)` : "";
      lines.push(
        `      <episode outcome="${escapeXml(ep.outcome ?? "unknown")}"${projectTag}${ageTag}>${escapeXml(taskSnippet)}</episode>`,
      );
    }
    lines.push("    </recent>");
  }
  lines.push("  </store>");

  // Semantic block
  lines.push("  <store name=\"semantic\">");
  lines.push(`    <count>${semantic.count}</count>`);
  if (Object.keys(semantic.byType).length > 0) {
    const typeList = Object.entries(semantic.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`)
      .join(", ");
    lines.push(`    <by_type>${escapeXml(typeList)}</by_type>`);
  }
  lines.push("  </store>");

  // Heuristics pointer (session-scoped, not persisted)
  lines.push("  <store name=\"heuristics\" scope=\"session\">");
  lines.push("    Heuristics accumulate within the current session and are NOT persisted across sessions. Query via `memory` action=heuristics_list to see what applies.");
  lines.push("  </store>");

  lines.push("</available_memories>");
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
