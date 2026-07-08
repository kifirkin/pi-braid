/**
 * Cognitive Memory - type definitions.
 */

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

  /**
   * Project identifier for session isolation (provenance tracking).
   * Set automatically from ctx.cwd when stored via memory_store.
   * Empty/undefined = legacy entry (pre-LP-3) — included in all queries.
   */
  projectId?: string;
}

// Storage format
export interface CognitiveMemoryStore {
  version: number;
  memories: CognitiveMemoryEntry[];
  lastConsolidation: number;
  turnCount: number;
  /** Timestamp of legacy memory migration (undefined = not yet migrated) */
  migratedAt?: number;
}
