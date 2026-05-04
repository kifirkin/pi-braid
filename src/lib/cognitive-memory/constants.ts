/**
 * Cognitive Memory — constants and configuration.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { CognitiveMemoryType } from "./types.js";

// Storage paths
export const MEMORY_DIR = path.join(os.homedir(), ".pi", "memory");
export const MEMORY_FILE = path.join(MEMORY_DIR, "memory.json");

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
