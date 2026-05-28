/**
 * Cognitive Memory — file I/O for persistent storage.
 */

import * as fs from "node:fs/promises";
import { fileMutationQueue } from "../utils/file-mutation-queue.js";
import { createLogger } from "../core/logger.js";
import { MEMORY_DIR, MEMORY_FILE, LEGACY_MEMORY_FILE_PATH } from "./constants.js";
import type { CognitiveMemoryStore } from "./types.js";

const _log = createLogger("cognitive-memory:storage");

async function ensureMemoryDir(): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

export async function loadMemory(): Promise<CognitiveMemoryStore> {
  await ensureMemoryDir();

  // Try new path first
  try {
    const data = await fs.readFile(MEMORY_FILE, "utf-8");
    const parsed = JSON.parse(data);

    // Handle migration from old format (entries) to new format (memories)
    if (parsed.entries && !parsed.memories) {
      const migrated: CognitiveMemoryStore = {
        version: 1,
        memories: parsed.entries.map((e: any) => ({
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
        })),
        lastConsolidation: parsed.lastConsolidation || 0,
        turnCount: parsed.turnCount || 0,
      };
      await saveMemory(migrated);
      return migrated;
    }

    // After loading from new path, check if legacy memories need importing
    // This handles the case where semantic.json exists but legacy memories
    // were never migrated (e.g., migration condition missed the file format)
    const store = parsed as CognitiveMemoryStore;
    if (!store.migratedAt) {
      try {
        const legacyData = await fs.readFile(LEGACY_MEMORY_FILE_PATH, "utf-8");
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

  // Fallback: try legacy path (~/.pi/memory/memory.json)
  try {
    const legacyData = await fs.readFile(LEGACY_MEMORY_FILE_PATH, "utf-8");
    const legacyParsed = JSON.parse(legacyData);

    if (legacyParsed.memories && legacyParsed.memories.length > 0) {
      _log.info(`Migrating ${legacyParsed.memories.length} memories from legacy path`);

      if (legacyParsed.entries && !legacyParsed.memories) {
        const migrated: CognitiveMemoryStore = {
          version: 1,
          memories: legacyParsed.entries.map((e: any) => ({
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
          })),
          lastConsolidation: legacyParsed.lastConsolidation || 0,
          turnCount: legacyParsed.turnCount || 0,
        };
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

export async function saveMemory(store: CognitiveMemoryStore): Promise<void> {
  await ensureMemoryDir();
  await fileMutationQueue.write(MEMORY_FILE, store);
}
