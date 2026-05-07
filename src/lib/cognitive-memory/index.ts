/**
 * Unified Cognitive Memory System — CognitiveMemory class.
 *
 * The class and all re-exports. Types, constants, storage, and utility
 * helpers are in sibling modules (types.ts, constants.ts, storage.ts, utils.ts).
 */

import { createLogger } from "../logger.js";
import type {
  CognitiveMemoryType,
  CognitiveMemoryEntry,
  CognitiveMemoryStore,
  MemoryContext,
  MemoryLink,
} from "./types.js";
import {
  MAX_ENTRIES,
  MIN_UTILITY_THRESHOLD,
  CONSOLIDATION_INTERVAL,
  CATEGORY_BASE_UTILITY,
} from "./constants.js";
import { loadMemory, saveMemory } from "./storage.js";
import {
  jaccardSimilarity,
  generateAutoTags,
  generateId,
  formatMemoryTimestamp,
  formatMemoryEntry,
} from "./utils.js";

const _log = createLogger("cognitive-memory");

// ── Re-exports for backward compatibility ─────────────────────────────────────

export type {
  CognitiveMemoryType,
  MemorySource,
  MemoryContext,
  MemoryLink,
  CognitiveMemoryEntry,
  CognitiveMemoryStore,
} from "./types.js";
export {
  formatMemoryTimestamp,
  formatMemoryEntry,
  parseStructuredContent,
  generateAutoTags,
} from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────────

const GENERIC_CONTENT_PATTERNS = [/auto-captured memory from enforcement/i, /auto-captured/i];

// ── Memory Logic ─────────────────────────────────────────────────────────────

function shouldStore(
  content: string,
  type: CognitiveMemoryType,
  existingMemories: CognitiveMemoryEntry[],
): boolean {
  if (type === "error" || type === "goal") return true;
  if (GENERIC_CONTENT_PATTERNS.some((p) => p.test(content))) return false;
  if (content.trim().length < 20) return false;

  const SIMILARITY_THRESHOLD = 0.6;
  const duplicate = existingMemories.find((m) => {
    if (m.type === type) return jaccardSimilarity(m.content, content) > SIMILARITY_THRESHOLD;
    return jaccardSimilarity(m.content, content) > 0.8;
  });
  return !duplicate;
}

function calculateUtility(type: CognitiveMemoryType, content: string, importance: number): number {
  let base = CATEGORY_BASE_UTILITY[type] ?? 0.5;
  const boostKeywords = ["fix", "solution", "pattern", "important", "critical", "remember", "key"];
  if (boostKeywords.some((k) => content.toLowerCase().includes(k))) {
    base = Math.min(1.0, base + 0.2);
  }
  return base * 0.7 + importance * 0.3;
}

function pruneMemories(memories: CognitiveMemoryEntry[]): CognitiveMemoryEntry[] {
  const now = Date.now();
  const RECENT_ACCESS_MS = 5 * 60 * 1000;

  const recent = memories.filter((m) => now - m.lastAccessed < RECENT_ACCESS_MS);
  const others = memories.filter((m) => now - m.lastAccessed >= RECENT_ACCESS_MS);

  const sorted = [...others].sort((a, b) => {
    if (Math.abs(a.utility - b.utility) > 0.1) return b.utility - a.utility;
    return b.timestamp - a.timestamp;
  });

  const remainingSlots = Math.max(0, MAX_ENTRIES - recent.length);
  const pruned = sorted
    .filter((m, i) => i < remainingSlots || m.utility >= MIN_UTILITY_THRESHOLD)
    .slice(0, remainingSlots);

  const combined = [...recent, ...pruned];
  return combined
    .sort((a, b) => {
      if (Math.abs(a.utility - b.utility) > 0.1) return b.utility - a.utility;
      return b.timestamp - a.timestamp;
    })
    .slice(0, MAX_ENTRIES);
}

function consolidate(store: CognitiveMemoryStore): CognitiveMemoryStore {
  const now = Date.now();
  const DEAD_UTILITY_THRESHOLD = 0.05;

  const alive = store.memories.filter(
    (m) => m.utility >= DEAD_UTILITY_THRESHOLD || m.type === "goal" || m.type === "error",
  );

  const MERGE_THRESHOLD = 0.7;
  const merged: CognitiveMemoryEntry[] = [];
  const mergedIds = new Set<string>();

  for (const memory of alive) {
    if (mergedIds.has(memory.id)) continue;

    const duplicates: CognitiveMemoryEntry[] = [memory];
    for (const other of alive) {
      if (other.id === memory.id || mergedIds.has(other.id)) continue;
      if (other.type !== memory.type) continue;
      if (jaccardSimilarity(memory.content, other.content) > MERGE_THRESHOLD) {
        duplicates.push(other);
        mergedIds.add(other.id);
      }
    }

    if (duplicates.length > 1) {
      duplicates.sort((a, b) => b.utility - a.utility);
      const best = { ...duplicates[0] };
      best.utility = Math.min(1.0, best.utility + 0.1 * (duplicates.length - 1));
      best.tags = [...new Set(duplicates.flatMap((d) => d.tags))];
      best.accessCount = duplicates.reduce((sum, d) => sum + d.accessCount, 0);
      merged.push(best);
      mergedIds.add(memory.id);
    } else if (!mergedIds.has(memory.id)) {
      merged.push(memory);
    }
  }

  const decayed = merged.map((m) => {
    const effectiveTime = Math.max(m.timestamp, m.lastAccessed || m.timestamp);
    const ageHours = (now - effectiveTime) / (1000 * 60 * 60);
    const decayFactor = Math.max(0.1, 1 - ageHours / 168);
    return { ...m, utility: m.utility * decayFactor };
  });

  const pruned = pruneMemories(decayed);
  return { ...store, memories: pruned, lastConsolidation: store.turnCount };
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _singletonInstance: CognitiveMemory | null = null;

export function getCognitiveMemory(): CognitiveMemory {
  if (!_singletonInstance) {
    _singletonInstance = new CognitiveMemory();
  }
  return _singletonInstance;
}

// ── Main Class ───────────────────────────────────────────────────────────────

export class CognitiveMemory {
  private memoryStore: CognitiveMemoryStore;
  private _initialized: boolean = false;

  constructor() {
    this.memoryStore = { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
  }

  async init(): Promise<void> {
    this.memoryStore = await loadMemory();
    this._initialized = true;
  }

  initialize(_storageDir?: string): void {
    // Synchronous init is a no-op; use init() for async disk loading
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private findById(id: string): CognitiveMemoryEntry | undefined {
    const exact = this.memoryStore.memories.find((m) => m.id === id);
    if (exact) return exact;
    const matches = this.memoryStore.memories.filter((m) => m.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private findIndexById(id: string): number {
    const exact = this.memoryStore.memories.findIndex((m) => m.id === id);
    if (exact !== -1) return exact;
    let matchIndex = -1;
    let matchCount = 0;
    for (let i = 0; i < this.memoryStore.memories.length; i++) {
      if (this.memoryStore.memories[i].id.startsWith(id)) {
        matchCount++;
        if (matchCount > 1) return -1;
        matchIndex = i;
      }
    }
    return matchCount === 1 ? matchIndex : -1;
  }

  private filterExpired(memories: CognitiveMemoryEntry[]): CognitiveMemoryEntry[] {
    const now = Date.now();
    return memories.filter((m) => !m.expiresAt || m.expiresAt > now);
  }

  // ── Store ──────────────────────────────────────────────────────────────

  async store(
    content: string,
    type: CognitiveMemoryType,
    options?: {
      tags?: string[];
      source?: string;
      importance?: number;
      context?: MemoryContext;
      related?: MemoryLink[];
      ttl?: number;
    },
  ): Promise<CognitiveMemoryEntry> {
    const importance = options?.importance ?? 0.5;

    if (!shouldStore(content, type, this.memoryStore.memories)) {
      throw new Error("Duplicate or low-utility content");
    }

    const utility = calculateUtility(type, content, importance);
    const autoTags = generateAutoTags(content, options?.context);
    const providedTags = options?.tags || [];
    const allTags = [...new Set([...providedTags, ...autoTags])];

    const memory: CognitiveMemoryEntry = {
      id: generateId(),
      content: content.slice(0, 10000),
      type,
      tags: allTags,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      source: options?.source,
      importance,
      utility,
      context: options?.context,
      related: options?.related,
      expiresAt: options?.ttl ? Date.now() + options.ttl : undefined,
    };

    this.memoryStore.memories.push(memory);

    if (options?.related?.length) {
      for (const link of options.related) {
        const relatedMemory = this.memoryStore.memories.find((m) => m.id === link.id);
        if (relatedMemory && relatedMemory.id !== memory.id) {
          if (!relatedMemory.related) relatedMemory.related = [];
          if (!relatedMemory.related.find((r) => r.id === memory.id)) {
            relatedMemory.related.push({
              id: memory.id,
              type: link.type === "fixes" ? "related" : "supersedes",
              auto: true,
            });
          }
        }
      }
    }

    this.memoryStore.turnCount++;

    if (this.memoryStore.memories.length > MAX_ENTRIES) {
      this.memoryStore.memories = pruneMemories(this.memoryStore.memories);
    }

    if (this.memoryStore.turnCount - this.memoryStore.lastConsolidation >= CONSOLIDATION_INTERVAL) {
      this.memoryStore = consolidate(this.memoryStore);
    }

    await saveMemory(this.memoryStore);
    return memory;
  }

  // ── Recall ──────────────────────────────────────────────────────────────

  async recall(
    query: string,
    options?: { type?: CognitiveMemoryType; limit?: number; tags?: string[] },
  ): Promise<Array<{ memory: CognitiveMemoryEntry; relevance: number }>> {
    const lowerQuery = query.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
    const limit = options?.limit ?? 5;

    const results: Array<{ memory: CognitiveMemoryEntry; relevance: number }> = [];

    for (const memory of this.filterExpired(this.memoryStore.memories)) {
      if (options?.type && memory.type !== options.type) continue;
      if (options?.tags?.length && !options.tags.some((t) => memory.tags.includes(t))) continue;

      const contentLower = memory.content.toLowerCase();
      let matches = 0;
      for (const word of queryWords) {
        if (contentLower.includes(word)) matches++;
      }
      if (contentLower.includes(lowerQuery)) matches += queryWords.length;
      for (const tag of memory.tags) {
        if (lowerQuery.includes(tag.toLowerCase())) matches += 2;
      }

      const relevance = matches * (0.5 + memory.utility * 0.5);
      if (relevance > 0) results.push({ memory, relevance });
    }

    results.sort((a, b) => b.relevance - a.relevance);

    for (const r of results.slice(0, limit)) {
      r.memory.accessCount++;
      r.memory.lastAccessed = Date.now();
    }

    await saveMemory(this.memoryStore);
    return results.slice(0, limit);
  }

  // ── Search / Query ──────────────────────────────────────────────────────

  searchByTags(tags: string[]): CognitiveMemoryEntry[] {
    return this.memoryStore.memories
      .filter((m) => tags.some((t) => m.tags.includes(t)))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getByType(type: CognitiveMemoryType): CognitiveMemoryEntry[] {
    return this.memoryStore.memories
      .filter((m) => m.type === type)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getRecent(limit = 10): CognitiveMemoryEntry[] {
    return [...this.memoryStore.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async getById(id: string): Promise<CognitiveMemoryEntry | undefined> {
    const memory = this.findById(id);
    if (memory) {
      memory.accessCount++;
      memory.lastAccessed = Date.now();
      await saveMemory(this.memoryStore);
    }
    return memory;
  }

  getAll(limit = 20): CognitiveMemoryEntry[] {
    return [...this.memoryStore.memories]
      .sort((a, b) => b.utility - a.utility)
      .slice(0, limit)
      .filter((m) => !m.expiresAt || m.expiresAt > Date.now());
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const index = this.findIndexById(id);
    if (index === -1) return false;
    const memory = this.memoryStore.memories[index];
    this.memoryStore.memories.splice(index, 1);
    for (const m of this.memoryStore.memories) {
      if (m.related) {
        m.related = m.related.filter((r) => r.id !== memory.id);
      }
    }
    await saveMemory(this.memoryStore);
    return true;
  }

  remove(id: string): boolean {
    // Synchronous remove (legacy API)
    const idx = this.findIndexById(id);
    if (idx === -1) return false;
    const removed = this.memoryStore.memories[idx];
    for (const m of this.memoryStore.memories) {
      if (m.related) {
        m.related = m.related.filter((l) => l.id !== removed.id);
      }
    }
    this.memoryStore.memories.splice(idx, 1);
    saveMemory(this.memoryStore).catch((e) => _log.error("save failed:", e));
    return true;
  }

  async updateTags(id: string, tags: string[]): Promise<boolean> {
    const idx = this.findIndexById(id);
    if (idx === -1) return false;
    this.memoryStore.memories[idx].tags = [...new Set(tags)];
    await saveMemory(this.memoryStore);
    return true;
  }

  async boost(id: string, amount = 0.2): Promise<boolean> {
    const memory = this.findById(id);
    if (!memory) return false;
    memory.utility = Math.min(1.0, memory.utility + amount);
    await saveMemory(this.memoryStore);
    return true;
  }

  evict(id: string): boolean {
    return this.remove(id);
  }

  clear(): void {
    this.memoryStore.memories = [];
    saveMemory(this.memoryStore).catch((e) => _log.error("save failed:", e));
  }

  // ── Linking ─────────────────────────────────────────────────────────────

  async link(fromId: string, toId: string, type: MemoryLink["type"] = "related"): Promise<boolean> {
    const from = this.findById(fromId);
    const to = this.findById(toId);
    if (!from || !to || from.id === to.id) return false;

    if (!from.related) from.related = [];
    if (!to.related) to.related = [];

    if (!from.related.find((r) => r.id === to.id)) {
      from.related.push({ id: to.id, type, auto: false });
    }
    if (!to.related.find((r) => r.id === from.id)) {
      to.related.push({
        id: from.id,
        type: type === "fixes" ? "supersedes" : "related",
        auto: true,
      });
    }

    await saveMemory(this.memoryStore);
    return true;
  }

  async unlink(fromId: string, toId: string): Promise<boolean> {
    const from = this.findById(fromId);
    const to = this.findById(toId);
    let changed = false;

    if (from?.related) {
      const before = from.related.length;
      from.related = from.related.filter((r) => r.id !== (to?.id || toId));
      changed = changed || from.related.length !== before;
    }
    if (to?.related) {
      const before = to.related.length;
      to.related = to.related.filter((r) => r.id !== (from?.id || fromId));
      changed = changed || to.related.length !== before;
    }

    if (changed) await saveMemory(this.memoryStore);
    return changed;
  }

  getRelated(id: string, type?: MemoryLink["type"]): CognitiveMemoryEntry[] {
    const memory = this.findById(id);
    if (!memory?.related) return [];
    return this.filterExpired(
      memory.related
        .filter((r) => !type || r.type === type)
        .map((r) => this.memoryStore.memories.find((m) => m.id === r.id))
        .filter((m): m is CognitiveMemoryEntry => m !== undefined),
    );
  }

  addRelatedMemory(
    memoryId: string,
    relatedId: string,
    relationship: MemoryLink["type"] = "related",
  ): boolean {
    const memory = this.findById(memoryId);
    const related = this.findById(relatedId);
    if (!memory || !related) return false;

    if (!memory.related) memory.related = [];
    if (!memory.related.some((l) => l.id === related.id)) {
      memory.related.push({ id: related.id, type: relationship, auto: false });
    }
    if (!related.related) related.related = [];
    if (!related.related.some((l) => l.id === memory.id)) {
      related.related.push({ id: memory.id, type: relationship, auto: false });
    }

    saveMemory(this.memoryStore).catch((e) => _log.error("save failed:", e));
    return true;
  }

  // ── Expiration ─────────────────────────────────────────────────────────

  async setExpiration(id: string, ttlMs: number): Promise<boolean> {
    const memory = this.findById(id);
    if (!memory) return false;
    memory.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : undefined;
    await saveMemory(this.memoryStore);
    return true;
  }

  removeExpiration(id: string): Promise<boolean> {
    return this.setExpiration(id, 0);
  }

  async cleanupExpired(): Promise<number> {
    const before = this.memoryStore.memories.length;
    this.memoryStore.memories = this.filterExpired(this.memoryStore.memories);
    const removed = before - this.memoryStore.memories.length;
    if (removed > 0) await saveMemory(this.memoryStore);
    return removed;
  }

  // ── Consolidation ────────────────────────────────────────────────────

  async consolidate(): Promise<{ removed: number }> {
    const before = this.memoryStore.memories.length;
    this.memoryStore = consolidate(this.memoryStore);
    const removed = before - this.memoryStore.memories.length;
    await saveMemory(this.memoryStore);
    return { removed };
  }

  forceConsolidation(): CognitiveMemoryStore {
    this.memoryStore = consolidate(this.memoryStore);
    saveMemory(this.memoryStore).catch((e) => _log.error("save failed:", e));
    return { ...this.memoryStore };
  }

  trackTurn(): void {
    this.memoryStore.turnCount++;
    if (
      this.memoryStore.turnCount > 0 &&
      this.memoryStore.turnCount % CONSOLIDATION_INTERVAL === 0
    ) {
      this.memoryStore = consolidate(this.memoryStore);
      saveMemory(this.memoryStore).catch((e) => _log.error("save failed:", e));
    }
  }

  // ── Stats & Reporting ──────────────────────────────────────────────────

  getStats(): {
    total: number;
    byType: Record<string, number>;
    avgUtility: number;
    lastConsolidation: number;
  } {
    const byType: Record<string, number> = {};
    let totalUtility = 0;
    for (const m of this.memoryStore.memories) {
      byType[m.type] = (byType[m.type] || 0) + 1;
      totalUtility += m.utility;
    }
    return {
      total: this.memoryStore.memories.length,
      byType,
      avgUtility:
        this.memoryStore.memories.length > 0 ? totalUtility / this.memoryStore.memories.length : 0,
      lastConsolidation: this.memoryStore.lastConsolidation,
    };
  }

  getMemoryForPrompt(limit = 5): CognitiveMemoryEntry[] {
    return this.memoryStore.memories
      .filter(
        (m) =>
          (m.type === "error" || m.type === "pattern" || m.type === "goal") &&
          !(m.expiresAt && Date.now() > m.expiresAt),
      )
      .sort((a, b) => b.utility - a.utility)
      .slice(0, limit);
  }

  findErrorFixPairs(): Array<{ error: CognitiveMemoryEntry; fix: CognitiveMemoryEntry }> {
    const errors = this.filterExpired(this.getByType("error"));
    const pairs: Array<{ error: CognitiveMemoryEntry; fix: CognitiveMemoryEntry }> = [];
    for (const error of errors) {
      const relatedFixes = this.getRelated(error.id, "fixes");
      for (const fix of relatedFixes) {
        pairs.push({ error, fix });
      }
    }
    return pairs;
  }

  // ── Testing / internal ────────────────────────────────────────────────

  protected updateTurnCount(turn: number): void {
    this.memoryStore.turnCount = turn;
  }

  getMemoryStore(): CognitiveMemoryStore {
    return this.memoryStore;
  }
}
