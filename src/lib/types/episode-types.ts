/**
 * Episode Types - shared experience record definitions.
 *
 * Extracted from extensions/memory/three-memory-stores/types.ts so that
 * lib/utils/sop-suggestion.ts can import types without creating a lib->ext dependency.
 * Extensions that use Episode should import from here, not from each other.
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
