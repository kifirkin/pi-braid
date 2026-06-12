/**
 * Cognitive Memory - constants and configuration.
 */

import {
  SEMANTIC_MEMORY_FILE,
  LEGACY_MEMORY_FILE,
  MEMORY_DIR as BRAID_MEMORY_DIR,
} from "../config/braid-paths.js";
import type { CognitiveMemoryType } from "./types.js";

// Storage paths - consolidated under ~/.pi/agent/braid/memory/
export const MEMORY_DIR = BRAID_MEMORY_DIR;
export const MEMORY_FILE = SEMANTIC_MEMORY_FILE;

/** Legacy path (~/.pi/memory/memory.json) kept for graceful migration */
export const LEGACY_MEMORY_FILE_PATH = LEGACY_MEMORY_FILE;

// Constraints
export const MAX_ENTRIES = 200;
export const MIN_UTILITY_THRESHOLD = 0.15;
export const CONSOLIDATION_INTERVAL = 5;

// Utility calculation per category
export const CATEGORY_BASE_UTILITY: Record<CognitiveMemoryType, number> = {
  goal: 0.9,
  error: 0.8,
  pattern: 0.7,
  episodic: 0.6,
  insight: 0.6,
  semantic: 0.5,
  preference: 0.5,
  procedural: 0.5,
};
