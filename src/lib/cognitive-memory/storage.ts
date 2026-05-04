/**
 * Cognitive Memory — file I/O for persistent storage.
 */

import * as fs from "node:fs/promises";
import { fileMutationQueue } from "../file-mutation-queue.js";
import { createLogger } from "../logger.js";
import { MEMORY_DIR, MEMORY_FILE } from "./constants.js";
import type { CognitiveMemoryStore } from "./types.js";

const _log = createLogger("cognitive-memory:storage");

async function ensureMemoryDir(): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

export async function loadMemory(): Promise<CognitiveMemoryStore> {
  await ensureMemoryDir();
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

    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      _log.error("Load error:", e);
    }
  }
  return { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
}

export async function saveMemory(store: CognitiveMemoryStore): Promise<void> {
  await ensureMemoryDir();
  await fileMutationQueue.write(MEMORY_FILE, store);
}
