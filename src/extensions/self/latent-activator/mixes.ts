/**
 * Behavior combinations for common scenarios.
 *
 * Each mix is a tuple of AtomicBehaviors that work well together for
 * a given task type. Extracted from index.ts (was lines 311-331) to
 * keep the main file focused on extension logic. Pure data.
 */

import type { AtomicBehavior } from "./types.js";

export const BEHAVIOR_MIXES: Record<string, AtomicBehavior[]> = {
  "code-review": ["reviewer", "validator", "guardian", "meticulous"],
  "debugging": ["detective", "debugger", "forensic", "oracle"],
  "planning": ["planner", "architectural", "compass", "oracle"],
  "implementation": ["executor", "pragmatic", "scalpel", "catalyst"],
  "exploration": ["explorer", "wanderer", "bridge", "lens"],
  "reflection": ["mirror", "archivist", "witness", "mentor"],
  "crisis": ["catalyst", "warrior", "guardian", "hammer"],
  "learning": ["scientist", "research", "teacher", "explorer"],
  "research": ["research", "scientist", "detective", "archivist"],
  "refactoring": ["architectural", "meticulous", "artist", "scalpel"],
  "handover": ["witness", "translator", "archivist"],
};
