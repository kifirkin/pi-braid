/**
 * Three Memory Stores — type definitions
 *
 * Extracted from index.ts for maintainability and shared access.
 */

/** Episode (experience) record */
export interface Episode {
  id: string;
  task: string;
  solution: string;
  outcome: "success" | "failure" | "partial";
  similarity: number;
  timestamp: number;
  toolSequence: string[];
  tags: string[];
  /** Project path where this episode was created. Provenance tag (HaluMem 2511.03506). */
  project: string;
  /** Session ID — enables cross-session contamination filtering. */
  sessionId: string;
  /** Quality score 0-1 (Decocted Experience 2604.03213): outcome × tool diversity × reasoning density. */
  quality?: number;
  /** Strategic SOP (high-level): Overall strategy used. */
  strategicSOP?: string;
  /** Functional SOP (mid-level): Key steps taken. */
  functionalSOP?: string[];
  /** Atomic SOP (low-level): Tool invocations — same as toolSequence. */
  atomicSOP?: string[];
}

/** Heuristic rule — procedural knowledge derived from experience */
export interface HeuristicRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
  successRate: number;
  uses: number;
  successes: number;
  lastUsed: number;
  created: number;
  /** Source: "sop" for success-derived, "principle" for failure-derived */
  ruleType?: "sop" | "principle";
}

/** Tool usage statistics per task type */
export interface ToolStat {
  tool: string;
  taskType: string;
  attempts: number;
  successes: number;
  lastAttempt: number;
  avgDuration: number;
}

/** Internal module state */
export interface MemoryStoresState {
  episodes: Episode[];
  heuristics: HeuristicRule[];
  toolStats: Map<string, ToolStat>;
  currentSessionTools: string[];
  sessionStartTime: number;
  lastSkillType: string;
  skillTransitionCount: number;
  recentErrors: string[];
  /** Current session ID — enables cross-session contamination filtering. */
  currentSessionId: string;
  /** Session-scoped recall cooldown timestamp (prevents cross-session leak). */
  lastRecallTime: number;
  /** Hashes of last-emitted semantic recall entries for deduplication. */
  lastSemanticRecallHashes: string[];
  /** Signature of last-emitted episode recall (title + episode IDs) for deduplication. */
  lastEpisodeRecallSignature: string;
  /** Separate cooldown timestamp for semantic recall path (avoids interfering with episode recall). */
  lastSemanticRecallTime: number;
}
