/**
 * Cognitive Memory — backward-compatible barrel re-export.
 *
 * All existing imports from "../../../lib/cognitive-memory.js" still work.
 * The actual implementation is in cognitive-memory/index.ts.
 */

// Re-export types
export type {
  CognitiveMemoryType,
  MemorySource,
  MemoryContext,
  MemoryLink,
  CognitiveMemoryEntry,
  CognitiveMemoryStore,
} from "./cognitive-memory/types.js";

// Re-export classes and functions
export { CognitiveMemory, getCognitiveMemory } from "./cognitive-memory/index.js";
export {
  formatMemoryTimestamp,
  formatMemoryEntry,
  parseStructuredContent,
  generateAutoTags,
} from "./cognitive-memory/utils.js";
