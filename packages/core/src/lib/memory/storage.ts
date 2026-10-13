/**
 * Cognitive Memory - file I/O for persistent storage.
 *
 * The disk store is the shared baseline for every live pi process: writers
 * never rewrite it from their own snapshot. `saveMemory` re-reads the file
 * under a cross-process lock, merges the caller's records by entry id
 * (store-merge.ts), and persists the merged result atomically
 * (temp file + rename, via the file mutation queue). A caller that removed
 * ids from its snapshot passes them so deletions are expressed instead of
 * accidentally resurrecting the removed entries.
 */

import * as fs from "node:fs/promises";
import { fileMutationQueue } from "../utils/file-mutation-queue.js";
import { createLogger } from "../core/logger.js";
import { memoryDir, semanticMemoryFilePath, legacyMemoryFilePath } from "../config/braid-paths.js";
import { withStoreLock } from "./store-lock.js";
import { mergeStores, type MergeStoresOptions } from "./store-merge.js";
import type { CognitiveMemoryEntry, CognitiveMemoryStore } from "./types.js";

const _log = createLogger("semantic-memory:storage");

/** Exclusive lock guarding the read-merge-write cycle on the semantic store.
 *  Resolved through the live store path so the lock and the file it guards
 *  always name the same (possibly BRAID_HOME-pinned) store. */
export function semanticStoreLockFilePath(): string {
  return `${semanticMemoryFilePath()}.lock`;
}

async function ensureMemoryDir(): Promise<void> {
  await fs.mkdir(memoryDir(), { recursive: true });
}

/** Map the legacy `{entries: [...]}` format onto the current memories shape. Pure. */
function migrateEntriesShape(parsed: {
  entries: Array<Record<string, unknown>>;
  lastConsolidation?: number;
  turnCount?: number;
}): CognitiveMemoryStore {
  return {
    version: 1,
    memories: parsed.entries.map(
      (e: Record<string, unknown>) =>
        ({
          id: e.id,
          content: e.content,
          type: e.category,
          tags: e.tags || [],
          timestamp: e.timestamp,
          accessCount: 0,
          lastAccessed: e.timestamp,
          source: e.source,
          importance: e.utility,
          utility: e.utility,
        }) as CognitiveMemoryEntry,
    ),
    lastConsolidation: parsed.lastConsolidation || 0,
    turnCount: parsed.turnCount || 0,
  };
}

/**
 * Raw read of the current disk store. No migration side effects (those live
 * in loadMemory, which may legitimately write) — this reader must be safe to
 * call from inside the persistence lock.
 * Returns null when the file is absent or unreadable.
 */
export async function readStoreFile(): Promise<CognitiveMemoryStore | null> {
  try {
    const data = await fs.readFile(semanticMemoryFilePath(), "utf-8");
    const parsed = JSON.parse(data);
    if (parsed?.memories) return parsed as CognitiveMemoryStore;
    if (parsed?.entries) return migrateEntriesShape(parsed);
    return null;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      _log.error("Read error:", e);
    }
    return null;
  }
}

export async function loadMemory(): Promise<CognitiveMemoryStore> {
  try {
    await ensureMemoryDir();
  } catch (err) {
    // A reader degrades: a refused root (no absolute braid root resolves) is
    // read as an absent store, and the writer side is the loud one.
    _log.warn(`Semantic store root unavailable, starting empty: ${err}`);
  }

  // Prefer the current format; legacy sources are handled below.
  try {
    const data = await fs.readFile(semanticMemoryFilePath(), "utf-8");
    const parsed = JSON.parse(data);

    // Handle migration from old format (entries) to new format (memories)
    if (parsed.entries && !parsed.memories) {
      const migrated = migrateEntriesShape(parsed);
      await saveMemory(migrated);
      return migrated;
    }

    // After loading from new path, check if legacy memories need importing
    // This handles the case where semantic.json exists but legacy memories
    // were never migrated (e.g., migration condition missed the file format)
    const store = parsed as CognitiveMemoryStore;
    if (!store.migratedAt) {
      try {
        const legacyData = await fs.readFile(legacyMemoryFilePath(), "utf-8");
        const legacyParsed = JSON.parse(legacyData);
        if (legacyParsed.memories?.length > 0) {
          const existingIds = new Set(store.memories.map((m) => m.id));
          const newMemories = legacyParsed.memories.filter((m: any) => !existingIds.has(m.id));
          if (newMemories.length > 0) {
            _log.info(`Importing ${newMemories.length} legacy memories into semantic store`);
            store.memories.push(...newMemories);
          }
        }
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") {
          _log.warn("Legacy memory check failed:", e);
        }
      }
      store.migratedAt = Date.now();
      await saveMemory(store);
    }

    return store;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      _log.error("Load error (new path):", e);
    }
  }

  // Fallback: try the legacy pre-braid path (resolved off the live root, so a
  // pinned braid home migrates only its own predecessor).
  try {
    const legacyData = await fs.readFile(legacyMemoryFilePath(), "utf-8");
    const legacyParsed = JSON.parse(legacyData);

    if (legacyParsed.memories && legacyParsed.memories.length > 0) {
      _log.info(`Migrating ${legacyParsed.memories.length} memories from legacy path`);

      if (legacyParsed.entries && !legacyParsed.memories) {
        const migrated = migrateEntriesShape(legacyParsed);
        await saveMemory(migrated);
        return migrated;
      }

      // Migrate to new path for next load
      await saveMemory(legacyParsed);
      return legacyParsed;
    }
  } catch (e) {
    // ENOENT on legacy path is expected (fresh install or already migrated)
    if ((e as { code?: string }).code !== "ENOENT") {
      _log.error("Load error (legacy path):", e);
    }
  }

  return { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
}

/**
 * Merge-on-write persistence: re-read the disk store under the lock, union
 * the caller's records by entry id, and write the merged result atomically.
 * Returns the merged store; persistent callers (the CognitiveMemory class)
 * adopt it as their new in-memory snapshot so the next read sees what other
 * processes wrote.
 *
 * `opts.replaceAll` is for explicit wipes only. `opts.removeIds` carries the
 * caller's deletion intent (ids it removed from its snapshot since loading);
 * without it, a removed id would look like "never seen" and be resurrected.
 */
export async function saveMemory(
  local: CognitiveMemoryStore,
  opts: MergeStoresOptions = {},
): Promise<CognitiveMemoryStore> {
  await ensureMemoryDir();
  return withStoreLock(semanticStoreLockFilePath(), async () => {
    const disk = await readStoreFile();
    const merged = mergeStores(disk, local, opts);
    await fileMutationQueue.write(semanticMemoryFilePath(), merged);
    return merged;
  });
}
