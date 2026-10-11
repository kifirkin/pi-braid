/**
 * Unified Cognitive Memory System - CognitiveMemory class.
 *
 * The class and all re-exports. Types, constants, storage, and utility
 * helpers are in sibling modules (types.ts, constants.ts, storage.ts, utils.ts).
 */

import { createLogger } from "../core/logger.js";
import type {
  CognitiveMemoryType,
  CognitiveMemoryEntry,
  CognitiveMemoryStore,
  MemoryContext,
  MemoryLink,
} from "./types.js";
import { MAX_ENTRIES, CONSOLIDATION_INTERVAL } from "./constants.js";
import { loadMemory, saveMemory } from "./storage.js";
import { generateAutoTags, generateId } from "./utils.js";

// MAX_ENTRIES, MIN_UTILITY_THRESHOLD, CATEGORY_BASE_UTILITY are
// re-exported from ./lifecycle.ts (the lifecycle module owns them).
// CONSOLIDATION_INTERVAL stays here.

const _log = createLogger("semantic-memory");

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

// shouldStore, calculateUtility, pruneMemories, consolidate, and the
// constants (MAX_ENTRIES, MIN_UTILITY_THRESHOLD, CATEGORY_BASE_UTILITY)
// are now in ./lifecycle.ts. The class below uses them.
import { shouldStore, calculateUtility, pruneMemories, consolidate } from "./lifecycle.js";

// INTENTIONAL: CognitiveMemory is a cross-session knowledge base (memories
// from past sessions inform new sessions via memory-recall). The singleton
// pattern here means all callers share the same in-memory store, which is
// the desired behavior for cross-session recall.
//
// If pi ever runs in a process model that requires per-session memory
// isolation, this should be replaced with a per-session lookup via
// `getExtensionState(ctx, "cognitive-memory", factory)`.
//
// Named "process-global" to distinguish this from the per-session pattern
// in `extension-state.ts`. The singleton slot lives in
// `lib/state/global-state.ts` so all process-global mirrors are colocated.

import { getCognitiveMemoryInstance, setCognitiveMemoryInstance } from "../state/global-state.js";

// Typed wrapper: the getCognitiveMemoryInstance global getter returns
// `unknown` to keep the slot declaration free of imports of the heavy
// CognitiveMemory class. This wrapper centralizes the cast instead of
// scattering `as CognitiveMemory | null` at every use site.
function getCognitiveMemoryTyped(): CognitiveMemory | null {
  const inst = getCognitiveMemoryInstance();
  return (inst ?? null) as CognitiveMemory | null;
}

export function getCognitiveMemory(): CognitiveMemory {
  let instance = getCognitiveMemoryTyped();
  if (!instance) {
    instance = new CognitiveMemory();
    setCognitiveMemoryInstance(instance);
  }
  return instance;
}

export class CognitiveMemory {
  private memoryStore: CognitiveMemoryStore;
  /**
   * Ids this process deliberately removed (delete, consolidation, prune,
   * expiry) since its last persist. saveMemory unions the disk store with
   * the local snapshot, which cannot tell "removed" from "never seen";
   * these ids are how deletion intent survives the merge.
   */
  private removedIds = new Set<string>();
  /**
   * Timestamp of the last entry this store minted. Consecutive stores can
   * land in the same millisecond, and equal timestamps leave every recency
   * sort with an ambiguous order; minting a strictly increasing value makes
   * recency total at the source. Math.max keeps it monotone when the wall
   * clock steps backwards.
   */
  private lastIssuedTimestamp = 0;

  constructor() {
    this.memoryStore = { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
  }

  async init(): Promise<void> {
    this.memoryStore = await loadMemory();
    this.removedIds.clear();
  }

  initialize(_storageDir?: string): void {
    // Synchronous init is a no-op; use init() for async disk loading
  }

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

  /**
   * Strictly increasing entry timestamp, never behind the wall clock. Two
   * entries stored by this process can never share a timestamp, so
   * newest-first comparisons are total.
   */
  private nextTimestamp(): number {
    this.lastIssuedTimestamp = Math.max(Date.now(), this.lastIssuedTimestamp + 1);
    return this.lastIssuedTimestamp;
  }

  /**
   * Track which ids a snapshot-replacing mutation removed, so the next
   * persist drops them on disk instead of resurrecting them from the union.
   */
  private trackRemovals(mutate: () => void): void {
    const before = new Set(this.memoryStore.memories.map((m) => m.id));
    mutate();
    for (const m of this.memoryStore.memories) before.delete(m.id);
    for (const id of before) this.removedIds.add(id);
  }

  /**
   * Merge-on-write persist: re-reads the disk store, unions this process's
   * records with whatever other processes wrote since this snapshot was
   * loaded, and adopts the merged result. A concurrent writer's entry
   * therefore survives this process's persist — a stale-snapshot rewrite
   * (as recall()'s access-counter bumps would do without the merge) erases
   * newer entries.
   */
  private async persist(): Promise<void> {
    const merged = await saveMemory(this.memoryStore, { removeIds: this.removedIds });
    this.removedIds.clear();
    this.memoryStore = merged;
  }

  /**
   * Run a consolidation (or any store-replacing transform) with removal
   * tracking, then persist durably.
   */
  private async consolidateAndPersist(): Promise<void> {
    this.trackRemovals(() => {
      this.memoryStore = consolidate(this.memoryStore);
    });
    await this.persist();
  }

  /**
   * Find existing entries from a different project whose content overlaps
   * significantly with the given content. Used by memory_store to surface
   * cross-project conflicts.
   * Returns at most one entry per conflicting project.
   */
  findCrossProjectConflicts(
    content: string,
    projectId: string | undefined,
  ): Array<{ conflict: CognitiveMemoryEntry; overlap: number }> {
    if (!projectId) return [];
    const words = content
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length === 0) return [];

    const seenProjects = new Set<string>();
    const results: Array<{ conflict: CognitiveMemoryEntry; overlap: number }> = [];

    for (const m of this.memoryStore.memories) {
      if (!m.projectId || m.projectId === projectId) continue;
      if (seenProjects.has(m.projectId)) continue;

      const mWords = m.content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (mWords.length === 0) continue;

      const wordSet = new Set(words);
      let overlap = 0;
      for (const w of mWords) {
        if (wordSet.has(w)) overlap++;
      }
      const overlapRatio = overlap / Math.max(words.length, 1);
      if (overlapRatio > 0.3) {
        seenProjects.add(m.projectId);
        results.push({ conflict: m, overlap: overlapRatio });
      }
    }
    return results;
  }

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
      /** Project identifier for session isolation. Derived from ctx.cwd by the caller. */
      projectId?: string;
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
    const timestamp = this.nextTimestamp();

    const memory: CognitiveMemoryEntry = {
      id: generateId(),
      content: content.slice(0, 10000),
      type,
      tags: allTags,
      timestamp,
      accessCount: 0,
      lastAccessed: timestamp,
      source: options?.source,
      importance,
      utility,
      context: options?.context,
      related: options?.related,
      expiresAt: options?.ttl ? timestamp + options.ttl : undefined,
      projectId: options?.projectId,
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
      this.trackRemovals(() => {
        this.memoryStore.memories = pruneMemories(this.memoryStore.memories);
      });
    }

    if (this.memoryStore.turnCount - this.memoryStore.lastConsolidation >= CONSOLIDATION_INTERVAL) {
      this.trackRemovals(() => {
        this.memoryStore = consolidate(this.memoryStore);
      });
    }

    await this.persist();
    return memory;
  }

  async recall(
    query: string,
    options?: {
      type?: CognitiveMemoryType;
      limit?: number;
      tags?: string[];
      /**
       * Project path for provenance-aware filtering.
       * When set, recall filters to entries with matching projectId;
       * entries without a projectId are unscoped and stay included.
       * Use deriveProjectIdFromCwd(cwd) to produce the normalized form.
       */
      currentProject?: string;
      /**
       * Project scope for recall.
       * - "current" (default when currentProject is set): only include entries
       *   from the current project (entries without a projectId are
       *   unscoped and stay included).
       * - "all": include all entries regardless of project.
       */
      projectScope?: "current" | "all";
      /** Penalize memories from a different session (cross-session contamination guard). */
      currentSessionId?: string;
      /** Number of times a memory was accessed before - higher = more useful. */
      accessBoost?: number;
    },
  ): Promise<Array<{ memory: CognitiveMemoryEntry; relevance: number }>> {
    const lowerQuery = query.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
    const limit = options?.limit ?? 5;

    const results: Array<{ memory: CognitiveMemoryEntry; relevance: number }> = [];

    for (const memory of this.filterExpired(this.memoryStore.memories)) {
      if (options?.type && memory.type !== options.type) continue;
      if (options?.tags?.length && !options.tags.some((t) => memory.tags.includes(t))) continue;

      // Project-scoped isolation: skip entries from other projects unless
      // projectScope is "all" or the entry has no projectId (unscoped).
      if (
        options?.currentProject &&
        options?.projectScope !== "all" &&
        memory.projectId &&
        memory.projectId !== options.currentProject
      ) {
        continue;
      }

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
      if (relevance > 0) {
        // Freshness scoring: penalize stale memories.
        // Half-life of 7 days (604800000ms) - after 7 days, relevance decays by 50%.
        // This ensures recent insights surface above old ones with equal utility.
        const ageMs = Date.now() - memory.timestamp;
        const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
        const freshnessFactor = Math.pow(0.5, ageMs / HALF_LIFE_MS);
        let adjustedRelevance = relevance * (0.4 + 0.6 * freshnessFactor);

        // Context-aware boost for same-project entries (tag-based match)
        if (options?.currentProject && memory.projectId === options.currentProject) {
          adjustedRelevance *= 1.3; // +30% for same-project memories (provenance match)
        }
        // Fallback boost for entries tagged with project path (no projectId)
        if (
          options?.currentProject &&
          !memory.projectId &&
          memory.tags.some((t) => t.includes(options.currentProject!))
        ) {
          adjustedRelevance *= 1.3; // +30% for same-project tag match
        }
        if (options?.currentSessionId && memory.context?.error) {
          // Memories with error context from the current session are highly relevant
          adjustedRelevance *= 1.2;
        }
        if (memory.accessCount > (options?.accessBoost ?? 5)) {
          adjustedRelevance *= 1.15; // +15% for frequently accessed (high utility)
        }
        if (memory.type === "error" || memory.type === "goal") {
          adjustedRelevance *= 1.1; // +10% for error/goal memories (operationally important)
        }

        results.push({ memory, relevance: adjustedRelevance });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);

    for (const r of results.slice(0, limit)) {
      r.memory.accessCount++;
      r.memory.lastAccessed = Date.now();
    }

    await this.persist();
    return results.slice(0, limit);
  }

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
      await this.persist();
    }
    return memory;
  }

  /** Synchronous getById for consolidation operations (no side-effects). */
  getByIdSync(id: string): CognitiveMemoryEntry | undefined {
    return this.findById(id);
  }

  /** Delete a memory by ID. Used during consolidation to remove merged entries. */
  deleteById(id: string): boolean {
    const idx = this.findIndexById(id);
    if (idx === -1) return false;
    this.memoryStore.memories.splice(idx, 1);
    return true;
  }

  getAll(limit = 20): CognitiveMemoryEntry[] {
    return [...this.memoryStore.memories]
      .sort((a, b) => b.utility - a.utility)
      .slice(0, limit)
      .filter((m) => !m.expiresAt || m.expiresAt > Date.now());
  }

  async delete(id: string): Promise<boolean> {
    const index = this.findIndexById(id);
    if (index === -1) return false;
    const memory = this.memoryStore.memories[index];
    this.removedIds.add(id);
    this.memoryStore.memories.splice(index, 1);
    for (const m of this.memoryStore.memories) {
      if (m.related) {
        m.related = m.related.filter((r) => r.id !== memory.id);
      }
    }
    await this.persist();
    return true;
  }

  remove(id: string): boolean {
    // Synchronous remove (legacy API)
    const idx = this.findIndexById(id);
    if (idx === -1) return false;
    const removed = this.memoryStore.memories[idx];
    this.removedIds.add(id);
    for (const m of this.memoryStore.memories) {
      if (m.related) {
        m.related = m.related.filter((l) => l.id !== removed.id);
      }
    }
    this.memoryStore.memories.splice(idx, 1);
    saveMemory(this.memoryStore, { removeIds: this.removedIds }).catch((e) =>
      _log.error("save failed:", e),
    );
    return true;
  }

  async updateTags(id: string, tags: string[]): Promise<boolean> {
    const idx = this.findIndexById(id);
    if (idx === -1) return false;
    this.memoryStore.memories[idx].tags = [...new Set(tags)];
    await this.persist();
    return true;
  }

  async boost(id: string, amount = 0.2): Promise<boolean> {
    const memory = this.findById(id);
    if (!memory) return false;
    memory.utility = Math.min(1.0, memory.utility + amount);
    await this.persist();
    return true;
  }

  evict(id: string): boolean {
    return this.remove(id);
  }

  clear(): void {
    // Explicit wipe: empty the local store, then write it as-is instead of
    // union-merging with the disk contents, which would resurrect entries.
    this.trackRemovals(() => {
      this.memoryStore.memories = [];
    });
    saveMemory(this.memoryStore, { replaceAll: true }).catch((err) =>
      _log.error("save failed:", err),
    );
  }

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

    await this.persist();
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

    if (changed) await this.persist();
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

    saveMemory(this.memoryStore, { removeIds: this.removedIds }).catch((e) =>
      _log.error("save failed:", e),
    );
    return true;
  }

  async setExpiration(id: string, ttlMs: number): Promise<boolean> {
    const memory = this.findById(id);
    if (!memory) return false;
    memory.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : undefined;
    await this.persist();
    return true;
  }

  removeExpiration(id: string): Promise<boolean> {
    return this.setExpiration(id, 0);
  }

  async cleanupExpired(): Promise<number> {
    const before = this.memoryStore.memories.length;
    this.trackRemovals(() => {
      this.memoryStore.memories = this.filterExpired(this.memoryStore.memories);
    });
    const removed = before - this.memoryStore.memories.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  async consolidate(): Promise<{ removed: number }> {
    const before = this.memoryStore.memories.length;
    await this.consolidateAndPersist();
    const removed = before - this.memoryStore.memories.length;
    return { removed };
  }

  forceConsolidation(): CognitiveMemoryStore {
    this.trackRemovals(() => {
      this.memoryStore = consolidate(this.memoryStore);
    });
    saveMemory(this.memoryStore, { removeIds: this.removedIds }).catch((e) =>
      _log.error("save failed:", e),
    );
    return { ...this.memoryStore };
  }

  trackTurn(): void {
    this.memoryStore.turnCount++;
    if (
      this.memoryStore.turnCount > 0 &&
      this.memoryStore.turnCount % CONSOLIDATION_INTERVAL === 0
    ) {
      this.trackRemovals(() => {
        this.memoryStore = consolidate(this.memoryStore);
      });
      saveMemory(this.memoryStore, { removeIds: this.removedIds }).catch((e) =>
        _log.error("save failed:", e),
      );
    }
  }

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

  protected updateTurnCount(turn: number): void {
    this.memoryStore.turnCount = turn;
  }

  getMemoryStore(): CognitiveMemoryStore {
    return this.memoryStore;
  }
}
