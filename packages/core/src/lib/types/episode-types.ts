/**
 * Episode Types - shared experience record definitions.
 *
 * Lives in lib/ so lib/utils/sop-suggestion.ts imports the types without a
 * lib->extensions dependency. Extensions that use Episode import from here,
 * not from each other.
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
  /** Session ID - enables cross-session contamination filtering. */
  sessionId: string;
  /** Quality score 0-1 (Decocted Experience 2604.03213): outcome x tool diversity x reasoning density. */
  quality?: number;
  /** Strategic SOP (high-level): Overall strategy used. */
  strategicSOP?: string;
  /** Functional SOP (mid-level): Key steps taken. */
  functionalSOP?: string[];
  /** Atomic SOP (low-level): Tool invocations - same as toolSequence. */
  atomicSOP?: string[];
}
