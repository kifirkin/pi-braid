/**
 * Unified Cognitive Memory System
 *
 * Merged from:
 * - memory extension: insight, pattern, preference, goal, error with utility scoring
 * - advanced-memory: episodic, semantic, procedural with relevance search
 *
 * Features:
 * - All memory categories unified in one system
 * - Utility-based scoring and automatic gating
 * - Text search with relevance scoring
 * - Tag-based filtering
 * - Auto-capture patterns and errors from actions
 * - Boost and evict capabilities
 * - Automatic consolidation
 *
 * Storage: ~/.pi/memory/memory.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Unified memory categories
export type CognitiveMemoryType =
	| "insight"
	| "pattern"
	| "preference"
	| "goal"
	| "error"
	| "episodic"
	| "semantic"
	| "procedural";

// Extended types for unified query across sources
export type MemorySource = CognitiveMemoryType | "scratchpad" | "reasoning" | "plan";

/**
 * Rich structured content for memories
 */
export interface MemoryContext {
	/** File paths involved */
	files?: string[];
	/** Error message or stack trace */
	error?: {
		message?: string;
		stack?: string;
		code?: string;
	};
	/** Solution or fix applied */
	solution?: string;
	/** Additional metadata */
	[key: string]: unknown;
}

/**
 * Link to related memories
 */
export interface MemoryLink {
	id: string;
	/** Relationship type */
	type: "fixes" | "related" | "supersedes" | "example";
	/** Auto-generated or user-specified */
	auto?: boolean;
}

export interface CognitiveMemoryEntry {
	id: string;
	content: string;
	type: CognitiveMemoryType;
	tags: string[];
	timestamp: number;
	accessCount: number;
	lastAccessed: number;
	source?: string;
	importance: number; // 0-1, higher = more important
	utility: number; // 0-1, derived score for sorting
	/** Structured context data */
	context?: MemoryContext;
	/** Links to related memories */
	related?: MemoryLink[];
	/** Optional TTL in milliseconds (0 = no expiration) */
	expiresAt?: number;
}

// Storage format
interface CognitiveMemoryStore {
	version: number;
	memories: CognitiveMemoryEntry[];
	lastConsolidation: number;
	turnCount: number;
}

// Constants
const MEMORY_DIR = path.join(os.homedir(), ".pi", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.json");

const MAX_ENTRIES = 200;
const MIN_UTILITY_THRESHOLD = 0.15;
const CONSOLIDATION_INTERVAL = 5;

// Utility calculation per category
const CATEGORY_BASE_UTILITY: Record<CognitiveMemoryType, number> = {
	goal: 0.9,
	error: 0.8,
	pattern: 0.7,
	episodic: 0.6,
	insight: 0.6,
	semantic: 0.5,
	preference: 0.5,
	procedural: 0.5,
};

// Storage Functions

function ensureMemoryDir(): void {
	if (!fs.existsSync(MEMORY_DIR)) {
		fs.mkdirSync(MEMORY_DIR, { recursive: true });
	}
}

function loadMemory(): CognitiveMemoryStore {
	ensureMemoryDir();
	try {
		if (fs.existsSync(MEMORY_FILE)) {
			const data = fs.readFileSync(MEMORY_FILE, "utf-8");
			const parsed = JSON.parse(data);

			// Handle migration from old format (entries) to new format (memories)
			if (parsed.entries && !parsed.memories) {
				// Migrate old entries to new format
				const migrated: CognitiveMemoryStore = {
					version: 1,
					memories: parsed.entries.map((e: any) => ({
						id: e.id,
						content: e.content,
						type: e.category, // old category maps to new type
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
				// Save migrated format
				saveMemory(migrated);
				return migrated;
			}

			return parsed;
		}
	} catch (e) {
		console.error("[CognitiveMemory] Load error:", e);
	}
	return { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
}

function saveMemory(store: CognitiveMemoryStore): void {
	ensureMemoryDir();
	fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}

function generateId(): string {
	return `mem-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

// Memory Logic

/**
 * Compute Jaccard similarity between two strings (word-level).
 * Returns 0-1 where 1 = identical word sets.
 */
function jaccardSimilarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
	if (wordsA.size === 0 && wordsB.size === 0) return 1;
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let intersection = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) intersection++;
	}
	const union = wordsA.size + wordsB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Generic/template content patterns that add no value */
const GENERIC_CONTENT_PATTERNS = [
	/auto-captured memory from enforcement/i,
	/auto-captured/i,
];

function shouldStore(content: string, type: CognitiveMemoryType, existingMemories: CognitiveMemoryEntry[]): boolean {
	// Errors and goals are always stored
	if (type === "error" || type === "goal") {
		return true;
	}

	// Reject generic/template content
	if (GENERIC_CONTENT_PATTERNS.some((p) => p.test(content))) {
		return false;
	}

	// Reject very short content (likely low-value)
	if (content.trim().length < 20) {
		return false;
	}

	// Check for duplicates using Jaccard similarity on full content
	const SIMILARITY_THRESHOLD = 0.6;
	const duplicate = existingMemories.find((m) => {
		// Same type is more likely a true duplicate
		if (m.type === type) {
			return jaccardSimilarity(m.content, content) > SIMILARITY_THRESHOLD;
		}
		// Cross-type check with higher threshold
		return jaccardSimilarity(m.content, content) > 0.8;
	});
	if (duplicate) {
		return false;
	}

	return true;
}

function calculateUtility(type: CognitiveMemoryType, content: string, importance: number): number {
	let base = CATEGORY_BASE_UTILITY[type];

	// Boost for important keywords
	const boostKeywords = ["fix", "solution", "pattern", "important", "critical", "remember", "key"];
	const hasBoost = boostKeywords.some((k) => content.toLowerCase().includes(k));
	if (hasBoost) {
		base = Math.min(1.0, base + 0.2);
	}

	// Blend with provided importance (0.7 base + 0.3 importance)
	return base * 0.7 + importance * 0.3;
}

function pruneMemories(memories: CognitiveMemoryEntry[]): CognitiveMemoryEntry[] {
	const now = Date.now();
	const RECENT_ACCESS_MS = 5 * 60 * 1000; // 5 minutes

	// Separate recently accessed memories (protected from pruning)
	const recent = memories.filter((m) => now - m.lastAccessed < RECENT_ACCESS_MS);
	const others = memories.filter((m) => now - m.lastAccessed >= RECENT_ACCESS_MS);

	// Sort others by utility descending, then by timestamp descending
	const sorted = [...others].sort((a, b) => {
		if (Math.abs(a.utility - b.utility) > 0.1) {
			return b.utility - a.utility;
		}
		return b.timestamp - a.timestamp;
	});

	// Allow MAX_ENTRIES - recent.length slots for non-recent memories
	const remainingSlots = Math.max(0, MAX_ENTRIES - recent.length);

	const pruned = sorted
		.filter((m, i) => {
			if (i < remainingSlots) {
				return true;
			}
			if (m.utility >= MIN_UTILITY_THRESHOLD) {
				return true;
			}
			return false;
		})
		.slice(0, MAX_ENTRIES - recent.length);

	// Recent memories are always kept, final result sorted and capped
	const combined = [...recent, ...pruned];
	const final = combined
		.sort((a, b) => {
			if (Math.abs(a.utility - b.utility) > 0.1) {
				return b.utility - a.utility;
			}
			return b.timestamp - a.timestamp;
		})
		.slice(0, MAX_ENTRIES);

	return final;
}

function consolidate(store: CognitiveMemoryStore): CognitiveMemoryStore {
	const now = Date.now();

	// Phase 1: Remove dead memories (utility decayed below meaningful threshold)
	const DEAD_UTILITY_THRESHOLD = 0.05;
	let alive = store.memories.filter(
		(m) => m.utility >= DEAD_UTILITY_THRESHOLD || m.type === "goal" || m.type === "error",
	);

	// Phase 2: Merge near-duplicate memories (Jaccard > 0.7, same type)
	const MERGE_THRESHOLD = 0.7;
	const merged: CognitiveMemoryEntry[] = [];
	const mergedIds = new Set<string>();

	for (const memory of alive) {
		if (mergedIds.has(memory.id)) continue;

		// Find similar memories of the same type
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
			// Merge: keep the one with highest utility, boost it
			duplicates.sort((a, b) => b.utility - a.utility);
			const best = { ...duplicates[0] };
			// Boost merged memory
			best.utility = Math.min(1.0, best.utility + 0.1 * (duplicates.length - 1));
			// Merge tags
			best.tags = [...new Set(duplicates.flatMap((d) => d.tags))];
			// Track merge count in accessCount
			best.accessCount = duplicates.reduce((sum, d) => sum + d.accessCount, 0);
			merged.push(best);
			mergedIds.add(memory.id);
		} else if (!mergedIds.has(memory.id)) {
			merged.push(memory);
		}
	}

	// Phase 3: Apply time-based decay
	const decayed = merged.map((m) => {
		const effectiveTime = Math.max(m.timestamp, m.lastAccessed || m.timestamp);
		const ageHours = (now - effectiveTime) / (1000 * 60 * 60);
		const decayFactor = Math.max(0.1, 1 - ageHours / 168); // Decay over 1 week
		return { ...m, utility: m.utility * decayFactor };
	});

	const pruned = pruneMemories(decayed);

	return {
		...store,
		memories: pruned,
		lastConsolidation: store.turnCount,
	};
}

// Public API

// Singleton instance for consistent state across tool calls
let _singletonInstance: CognitiveMemory | null = null;

export function getCognitiveMemory(): CognitiveMemory {
	if (!_singletonInstance) {
		_singletonInstance = new CognitiveMemory();
	}
	return _singletonInstance;
}

/**
 * Format timestamp for display
 */
export function formatMemoryTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const now = Date.now();
	const diffMs = now - timestamp;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	// Recent = show relative time
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;

	// Older = show date
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
	});
}

/**
 * Format memory entry for display with full details
 */
export function formatMemoryEntry(memory: CognitiveMemoryEntry, full = false): string {
	const time = formatMemoryTimestamp(memory.timestamp);
	const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
	const expired = memory.expiresAt && Date.now() > memory.expiresAt ? " [EXPIRED]" : "";

	if (full) {
		const source = memory.source ? `\n  Source: ${memory.source}` : "";
		const utility = ` (utility: ${memory.utility.toFixed(2)})`;
		let contextStr = "";
		if (memory.context) {
			if (memory.context.files?.length) {
				contextStr += `\n  Files: ${memory.context.files.join(", ")}`;
			}
			if (memory.context.error?.message) {
				contextStr += `\n  Error: ${memory.context.error.message}`;
			}
			if (memory.context.solution) {
				contextStr += `\n  Solution: ${memory.context.solution}`;
			}
		}
		let relatedStr = "";
		if (memory.related?.length) {
			relatedStr = `\n  Related: ${memory.related.map((r) => `${r.type}:${r.id.slice(0, 8)}`).join(", ")}`;
		}
		return `[${memory.type}] ID: ${memory.id} ${time}${tags}${expired}${utility}\n  ${memory.content}${contextStr}${relatedStr}${source}`;
	}

	// Truncated preview
	const preview = memory.content.length > 100 ? `${memory.content.slice(0, 100)}...` : memory.content;
	const idPreview = memory.id.length > 12 ? `${memory.id.slice(0, 12)}..` : memory.id;
	return `[${memory.type}] ${idPreview} ${time}${tags}${expired} - ${preview}`;
}

/**
 * Parse structured content from a JSON string
 */
export function parseStructuredContent(content: string): { summary: string; context?: MemoryContext } {
	try {
		const parsed = JSON.parse(content);
		if (parsed && typeof parsed === "object") {
			return {
				summary: parsed.summary || parsed.description || JSON.stringify(parsed).slice(0, 100),
				context: {
					files: parsed.files || parsed.file ? [parsed.files || parsed.file].flat() : undefined,
					error:
						parsed.error || parsed.stack
							? {
									message: parsed.error?.message || parsed.error,
									stack: parsed.stack,
									code: parsed.code,
								}
							: undefined,
					solution: parsed.solution || parsed.fix || parsed.resolution,
					...parsed,
				},
			};
		}
	} catch {
		// Not JSON, return as-is
	}
	return { summary: content };
}

/**
 * Auto-generate tags from content and context
 */
export function generateAutoTags(content: string, context?: MemoryContext): string[] {
	const tags: Set<string> = new Set();

	// Extract file extensions
	const extMatches = content.match(/\.([a-z]+):/gi);
	if (extMatches) {
		extMatches.forEach((m) => {
			const ext = m.slice(1, -1);
			if (ext.length <= 5) tags.add(ext);
		});
	}

	// Extract function/class names (PascalCase or camelCase)
	const nameMatches = content.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+/g);
	if (nameMatches) {
		nameMatches.slice(0, 2).forEach((n) => {
			tags.add(n);
		});
	}

	// Context-based tags
	if (context?.files?.length) {
		context.files.forEach((f) => {
			const ext = f.split(".").pop();
			if (ext && ext.length <= 5) tags.add(ext);
		});
	}

	if (context?.error) {
		tags.add("error");
		if (context.error.code) tags.add(context.error.code);
	}

	return Array.from(tags);
}

export class CognitiveMemory {
	private memoryStore: CognitiveMemoryStore;

	constructor() {
		this.memoryStore = loadMemory();
	}

	initialize(_storageDir?: string): void {
		// Always use global storage (~/.pi/memory/)
		this.memoryStore = loadMemory();
	}

	/**
	 * Find a memory by exact ID or by unique prefix.
	 * Returns undefined if not found or if the prefix matches multiple memories.
	 */
	private findById(id: string): CognitiveMemoryEntry | undefined {
		const exact = this.memoryStore.memories.find((m) => m.id === id);
		if (exact) return exact;

		// Prefix match - only resolve if exactly one match
		const matches = this.memoryStore.memories.filter((m) => m.id.startsWith(id));
		return matches.length === 1 ? matches[0] : undefined;
	}

	/**
	 * Find memory index by exact ID or unique prefix.
	 * Returns -1 when not found.
	 */
	private findIndexById(id: string): number {
		const exact = this.memoryStore.memories.findIndex((m) => m.id === id);
		if (exact !== -1) return exact;

		// Prefix match with exactly one result
		let matchIndex = -1;
		let matchCount = 0;
		for (let i = 0; i < this.memoryStore.memories.length; i++) {
			if (this.memoryStore.memories[i].id.startsWith(id)) {
				matchCount++;
				if (matchCount > 1) return -1; // ambiguous
				matchIndex = i;
			}
		}
		return matchCount === 1 ? matchIndex : -1;
	}

	store(
		content: string,
		type: CognitiveMemoryType,
		options?: {
			tags?: string[];
			source?: string;
			importance?: number;
			/** Structured context (files, error details, solution) */
			context?: MemoryContext;
			/** Links to related memory IDs */
			related?: MemoryLink[];
			/** TTL in milliseconds (optional) */
			ttl?: number;
		},
	): CognitiveMemoryEntry {
		const importance = options?.importance ?? 0.5;

		if (!shouldStore(content, type, this.memoryStore.memories)) {
			throw new Error("Duplicate or low-utility content");
		}

		const utility = calculateUtility(type, content, importance);

		// Auto-generate tags from content and context
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

		// Auto-link to related memories (bidirectional)
		if (options?.related?.length) {
			for (const link of options.related) {
				const relatedMemory = this.memoryStore.memories.find((m) => m.id === link.id);
				if (relatedMemory && relatedMemory.id !== memory.id) {
					if (!relatedMemory.related) relatedMemory.related = [];
					// Add reverse link if not exists
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

		// Prune if over limit
		if (this.memoryStore.memories.length > MAX_ENTRIES) {
			this.memoryStore.memories = pruneMemories(this.memoryStore.memories);
		}

		// Consolidate periodically
		if (this.memoryStore.turnCount - this.memoryStore.lastConsolidation >= CONSOLIDATION_INTERVAL) {
			this.memoryStore = consolidate(this.memoryStore);
		}

		saveMemory(this.memoryStore);
		return memory;
	}

	/**
	 * Filter out expired memories
	 */
	private filterExpired(memories: CognitiveMemoryEntry[]): CognitiveMemoryEntry[] {
		const now = Date.now();
		return memories.filter((m) => !m.expiresAt || m.expiresAt > now);
	}

	recall(
		query: string,
		options?: {
			type?: CognitiveMemoryType;
			limit?: number;
			tags?: string[];
		},
	): Array<{ memory: CognitiveMemoryEntry; relevance: number }> {
		const lowerQuery = query.toLowerCase();
		const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
		const limit = options?.limit ?? 5;

		const results: Array<{ memory: CognitiveMemoryEntry; relevance: number }> = [];

		for (const memory of this.filterExpired(this.memoryStore.memories)) {
			// Filter by type
			if (options?.type && memory.type !== options.type) continue;

			// Filter by tags
			if (options?.tags?.length) {
				const hasTag = options.tags.some((t) => memory.tags.includes(t));
				if (!hasTag) continue;
			}

			// Calculate relevance based on word matches
			const contentLower = memory.content.toLowerCase();
			let matches = 0;
			for (const word of queryWords) {
				if (contentLower.includes(word)) matches++;
			}

			// Boost for exact phrase match
			if (contentLower.includes(lowerQuery)) matches += queryWords.length;

			// Boost for tag matches
			for (const tag of memory.tags) {
				if (lowerQuery.includes(tag.toLowerCase())) matches += 2;
			}

			// Factor in utility
			const relevance = matches * (0.5 + memory.utility * 0.5);

			if (relevance > 0) {
				results.push({ memory, relevance });
			}
		}

		// Sort by relevance
		results.sort((a, b) => b.relevance - a.relevance);

		// Update access stats
		for (const r of results.slice(0, limit)) {
			r.memory.accessCount++;
			r.memory.lastAccessed = Date.now();
		}

		saveMemory(this.memoryStore);
		return results.slice(0, limit);
	}

	searchByTags(tags: string[]): CognitiveMemoryEntry[] {
		return this.memoryStore.memories
			.filter((m) => tags.some((t) => m.tags.includes(t)))
			.sort((a, b) => b.timestamp - a.timestamp);
	}

	getByType(type: CognitiveMemoryType): CognitiveMemoryEntry[] {
		return this.memoryStore.memories.filter((m) => m.type === type).sort((a, b) => b.timestamp - a.timestamp);
	}

	getRecent(limit = 10): CognitiveMemoryEntry[] {
		return [...this.memoryStore.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
	}

	getById(id: string): CognitiveMemoryEntry | undefined {
		const memory = this.findById(id);
		if (memory) {
			memory.accessCount++;
			memory.lastAccessed = Date.now();
			saveMemory(this.memoryStore);
		}
		return memory;
	}

	delete(id: string): boolean {
		const index = this.findIndexById(id);
		if (index === -1) {
			return false;
		}
		const memory = this.memoryStore.memories[index];
		this.memoryStore.memories.splice(index, 1);
		// Clean up references in related memories
		for (const m of this.memoryStore.memories) {
			if (m.related) {
				m.related = m.related.filter((r) => r.id !== memory.id);
			}
		}
		saveMemory(this.memoryStore);
		return true;
	}

	/**
	 * Link two memories together
	 */
	link(fromId: string, toId: string, type: MemoryLink["type"] = "related"): boolean {
		const from = this.findById(fromId);
		const to = this.findById(toId);

		if (!from || !to || from.id === to.id) {
			return false;
		}

		if (!from.related) from.related = [];
		if (!to.related) to.related = [];

		// Add forward link
		if (!from.related.find((r) => r.id === to.id)) {
			from.related.push({ id: to.id, type, auto: false });
		}

		// Add reverse link
		if (!to.related.find((r) => r.id === from.id)) {
			to.related.push({ id: from.id, type: type === "fixes" ? "supersedes" : "related", auto: true });
		}

		saveMemory(this.memoryStore);
		return true;
	}

	/**
	 * Unlink two memories
	 */
	unlink(fromId: string, toId: string): boolean {
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

		if (changed) {
			saveMemory(this.memoryStore);
		}
		return changed;
	}

	/**
	 * Get related memories
	 */
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

	/**
	 * Set expiration for a memory
	 */
	setExpiration(id: string, ttlMs: number): boolean {
		const memory = this.findById(id);
		if (!memory) return false;

		memory.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : undefined;
		saveMemory(this.memoryStore);
		return true;
	}

	/**
	 * Remove expiration (make permanent)
	 */
	removeExpiration(id: string): boolean {
		return this.setExpiration(id, 0);
	}

	/**
	 * Clean up expired memories
	 */
	cleanupExpired(): number {
		const before = this.memoryStore.memories.length;
		this.memoryStore.memories = this.filterExpired(this.memoryStore.memories);
		const removed = before - this.memoryStore.memories.length;
		if (removed > 0) {
			saveMemory(this.memoryStore);
		}
		return removed;
	}

	/**
	 * Find errors and their potential fixes
	 */
	findErrorFixPairs(): Array<{ error: CognitiveMemoryEntry; fix: CognitiveMemoryEntry }> {
		const errors = this.filterExpired(this.getByType("error"));
		const _patterns = this.filterExpired(this.getByType("pattern"));

		const pairs: Array<{ error: CognitiveMemoryEntry; fix: CognitiveMemoryEntry }> = [];

		for (const error of errors) {
			// Look for related patterns or insights that might be the fix
			const relatedFixes = this.getRelated(error.id, "fixes");
			for (const fix of relatedFixes) {
				pairs.push({ error, fix });
			}
		}

		return pairs;
	}

	consolidate(): { removed: number } {
		const before = this.memoryStore.memories.length;
		this.memoryStore = consolidate(this.memoryStore);
		const removed = before - this.memoryStore.memories.length;
		saveMemory(this.memoryStore);
		return { removed };
	}

	boost(id: string, amount: number = 0.2): boolean {
		const memory = this.findById(id);
		if (!memory) {
			return false;
		}
		memory.utility = Math.min(1.0, memory.utility + amount);
		saveMemory(this.memoryStore);
		return true;
	}

	clear(): void {
		this.memoryStore = { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
		saveMemory(this.memoryStore);
	}

	getStats(): {
		total: number;
		byType: Record<CognitiveMemoryType, number>;
		avgUtility: number;
	} {
		const byType: Record<CognitiveMemoryType, number> = {
			insight: 0,
			pattern: 0,
			preference: 0,
			goal: 0,
			error: 0,
			episodic: 0,
			semantic: 0,
			procedural: 0,
		};
		let totalUtility = 0;

		for (const m of this.memoryStore.memories) {
			byType[m.type]++;
			totalUtility += m.utility;
		}

		return {
			total: this.memoryStore.memories.length,
			byType,
			avgUtility: this.memoryStore.memories.length > 0 ? totalUtility / this.memoryStore.memories.length : 0,
		};
	}

	getAll(limit = 20): CognitiveMemoryEntry[] {
		return [...this.memoryStore.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
	}

	// Query DSL - Minimal SQL-like querying without SQLite dependency

	/**
	 * Parse a query DSL string into structured filters.
	 *
	 * Syntax:
	 * - "type:error" - filter by type
	 * - "source:memory" - filter by source
	 * - "tag:fix,error" - filter by tags (OR matching)
	 * - "since:7d" - within last 7 days (7d, 24h, 1h)
	 * - "utility:>0.7" - utility threshold
	 * - "fix bug" - text search (AND matching)
	 * - Combinations: "type:error source:memory fix bug"
	 */
	parseQuery(queryStr: string): {
		source?: string[];
		type?: string[];
		tags?: string[];
		text?: string;
		since?: number; // timestamp
		utility?: { op: ">" | "<"; value: number };
		limit?: number;
		sort?: "recent" | "utility";
	} {
		const result: ReturnType<typeof this.parseQuery> = {};
		const tokens = queryStr.trim().split(/\s+/);

		for (const token of tokens) {
			// type:error,source:pattern
			const typeMatch = token.match(/^type:(.+)$/i);
			if (typeMatch) {
				result.type = (result.type || []).concat(typeMatch[1].split(","));
				continue;
			}

			// source:memory,scratchpad
			const sourceMatch = token.match(/^source:(.+)$/i);
			if (sourceMatch) {
				result.source = (result.source || []).concat(sourceMatch[1].split(","));
				continue;
			}

			// tag:fix,error
			const tagMatch = token.match(/^tag:(.+)$/i);
			if (tagMatch) {
				result.tags = (result.tags || []).concat(tagMatch[1].split(","));
				continue;
			}

			// since:7d, 24h, 1h
			const sinceMatch = token.match(/^since:(\d+)([dh])$/i);
			if (sinceMatch) {
				const value = parseInt(sinceMatch[1], 10);
				const unit = sinceMatch[2].toLowerCase();
				const ms = unit === "d" ? value * 86400000 : value * 3600000;
				result.since = Date.now() - ms;
				continue;
			}

			// utility:>0.7, utility:<0.3
			const utilMatch = token.match(/^utility:([<>])([\d.]+)$/i);
			if (utilMatch) {
				result.utility = {
					op: utilMatch[1] as ">" | "<",
					value: parseFloat(utilMatch[2]),
				};
				continue;
			}

			// limit:10
			const limitMatch = token.match(/^limit:(\d+)$/i);
			if (limitMatch) {
				result.limit = parseInt(limitMatch[1], 10);
				continue;
			}

			// sort:recent, sort:utility
			const sortMatch = token.match(/^sort:(recent|utility)$/i);
			if (sortMatch) {
				result.sort = sortMatch[1].toLowerCase() as "recent" | "utility";
				continue;
			}

			// Text search - accumulate
			if (result.text) {
				result.text += ` ${token}`;
			} else {
				result.text = token;
			}
		}

		return result;
	}

	/**
	 * Execute a query using the DSL syntax.
	 *
	 * @example
	 * // Find recent errors
	 * query("type:error sort:recent limit:5")
	 *
	 * // Find patterns about bug fixes with high utility
	 * query("type:pattern tag:fix utility:>0.7")
	 *
	 * // Full-text search with filters
	 * query("type:error source:memory null pointer")
	 */
	query(queryStr: string): Array<{ memory: CognitiveMemoryEntry; relevance: number }> {
		const parsed = this.parseQuery(queryStr);
		return this.queryWithFilters(parsed);
	}

	/**
	 * Execute a query with pre-parsed filters.
	 */
	queryWithFilters(
		filters: ReturnType<typeof this.parseQuery>,
	): Array<{ memory: CognitiveMemoryEntry; relevance: number }> {
		const limit = filters.limit ?? 10;
		const sort = filters.sort ?? "recent";
		const results: Array<{ memory: CognitiveMemoryEntry; relevance: number }> = [];

		for (const memory of this.filterExpired(this.memoryStore.memories)) {
			// Filter by source (uses the source field, defaults to 'memory')
			if (filters.source?.length) {
				const memorySource = memory.source || "memory";
				if (!filters.source.includes(memorySource)) continue;
			}

			// Filter by type
			if (filters.type?.length) {
				if (!filters.type.includes(memory.type)) continue;
			}

			// Filter by tags (OR matching)
			if (filters.tags?.length) {
				const hasTag = filters.tags.some((t) => memory.tags.includes(t));
				if (!hasTag) continue;
			}

			// Filter by timestamp
			if (filters.since !== undefined) {
				if (memory.timestamp < filters.since) continue;
			}

			// Filter by utility
			if (filters.utility) {
				const { op, value } = filters.utility;
				if (op === ">" && memory.utility <= value) continue;
				if (op === "<" && memory.utility >= value) continue;
			}

			// Calculate text relevance
			let relevance = 0;
			if (filters.text) {
				const queryWords = filters.text
					.toLowerCase()
					.split(/\s+/)
					.filter((w) => w.length > 2);
				const contentLower = memory.content.toLowerCase();
				let matches = 0;
				for (const word of queryWords) {
					if (contentLower.includes(word)) matches++;
				}
				// Exact phrase boost
				if (contentLower.includes(filters.text.toLowerCase())) matches += queryWords.length;
				// Tag match boost
				for (const tag of memory.tags) {
					if (filters.text.toLowerCase().includes(tag.toLowerCase())) matches += 2;
				}
				relevance = matches * (0.5 + memory.utility * 0.5);
				if (relevance === 0) continue;
			} else {
				// No text filter - use utility as relevance
				relevance = memory.utility;
			}

			results.push({ memory, relevance });
		}

		// Sort
		if (sort === "utility") {
			results.sort((a, b) => b.relevance - a.relevance);
		} else {
			results.sort((a, b) => {
				if (Math.abs(a.relevance - b.relevance) > 0.1) {
					return b.relevance - a.relevance;
				}
				return b.memory.timestamp - a.memory.timestamp;
			});
		}

		// Update access stats
		for (const r of results.slice(0, limit)) {
			r.memory.accessCount++;
			r.memory.lastAccessed = Date.now();
		}

		saveMemory(this.memoryStore);
		return results.slice(0, limit);
	}

	/**
	 * Get memories by multiple types (OR logic).
	 */
	getByTypes(types: CognitiveMemoryType[]): CognitiveMemoryEntry[] {
		return this.memoryStore.memories.filter((m) => types.includes(m.type)).sort((a, b) => b.timestamp - a.timestamp);
	}

	/**
	 * Get memories with utility above threshold.
	 */
	getHighUtility(minUtility = 0.7): CognitiveMemoryEntry[] {
		return this.memoryStore.memories.filter((m) => m.utility >= minUtility).sort((a, b) => b.utility - a.utility);
	}

	/**
	 * Get memories from the last N hours.
	 */
	getRecentHours(hours: number): CognitiveMemoryEntry[] {
		const since = Date.now() - hours * 3600000;
		return this.memoryStore.memories.filter((m) => m.timestamp >= since).sort((a, b) => b.timestamp - a.timestamp);
	}
}

/**
 * Get memories formatted for system prompt injection
 *
 * Only includes high-utility entries (>= MIN_UTILITY_THRESHOLD) capped at 2 per category
 * to keep the prompt lean. Enforcement system handles memory usage nudges.
 */
export function getMemoryForPrompt(): string {
	const store = loadMemory();

	if (store.memories.length === 0) {
		return "";
	}

	const sections: string[] = [];
	const MAX_PER_CATEGORY = 3;
	const UTILITY_CUTOFF = 0.3;

	type SectionDef = { type: CognitiveMemoryType; heading: string; sort: "timestamp" | "utility" };
	const categories: SectionDef[] = [
		{ type: "goal", heading: "Current Goals", sort: "timestamp" },
		{ type: "pattern", heading: "Successful Patterns", sort: "utility" },
		{ type: "insight", heading: "Recent Insights", sort: "utility" },
		{ type: "error", heading: "Known Errors to Avoid", sort: "utility" },
	];

	for (const { type, heading, sort } of categories) {
		const entries = store.memories
			.filter((m) => m.type === type && m.utility >= UTILITY_CUTOFF)
			.sort((a, b) => (sort === "utility" ? b.utility - a.utility : b.timestamp - a.timestamp))
			.slice(0, MAX_PER_CATEGORY);

		if (entries.length > 0) {
			const headingLine = `## ${heading}`;
			const items = entries
				.map((e) => {
					const text = e.content.length > 300 ? `${e.content.slice(0, 300)}...` : e.content;
					return `- [${e.type}] ${text}`;
				})
				.join("\n");
			sections.push(`${headingLine}\n${items}`);
		}
	}

	if (sections.length === 0) {
		return "";
	}

	return `# Memory\n\n${sections.join("\n\n")}`;
}
