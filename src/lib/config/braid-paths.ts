/**
 * Braid Paths - centralized storage paths under ~/.pi/agent/braid/
 *
 * All braid-specific persistent storage is consolidated here.
 * This makes it easy to find, audit, and migrate braid data.
 *
 * Directory layout:
 *   ~/.pi/
 *   ├── agent/
 *   │   ├── braid/              ← ALL braid data
 *   │   │   ├── memory/
 *   │   │   │   ├── semantic.json      (lib/memory: semantic + episodic memories)
 *   │   │   │   ├── episodes.jsonl    (three-memory-stores: retrospective episodes)
 *   │   │   │   └── projects/         (project-scoped memory)
 *   │   │   ├── checkpoints/          (state-checkpoint: extension state snapshots)
 *   │   │   ├── errors/               (error-capture: classified error log)
 *   │   │   ├── feedback/             (feedback: per-model preferences + nudge history)
 *   │   │   ├── metrics/
 *   │   │   │   ├── braid-metrics.jsonl  (analytics: tool call metrics + A/B variants)
 *   │   │   │   └── degradation.json     (degradation detector state)
 *   │   │   ├── session-recall.json   (session-recall: cross-session history)
 *   │   │   └── scratchpads/         (scratchpad: task state per project)
 *   │   └── settings.json       (pi-native + braid config)
 *   └── memory/
 *       └── memory.json          (lib/memory legacy path - kept for migration compat)
 *
 * Paths NOT under braid/ (appropriate elsewhere):
 *   - ~/.pi/agent/settings.json       → pi-native config location
 *   - ~/.pi/agent/sessions/         → pi-native session storage
 */

import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();
const PI = path.join(HOME, ".pi");
const AGENT = path.join(PI, "agent");
const BRAID = path.join(AGENT, "braid");

// ── Base directories ────────────────────────────────────────────────────────

export const BRAID_DIR = BRAID;
export { BRAID };
export { AGENT };
export const MEMORY_DIR = path.join(BRAID, "memory");
export const CHECKPOINT_DIR = path.join(BRAID, "checkpoints");
export const ERROR_DIR = path.join(BRAID, "errors");
export const SCRATCHPAD_DIR = path.join(BRAID, "scratchpads");
export const METRICS_DIR = path.join(BRAID, "metrics");
export const HEALTHCHECK_DIR = path.join(BRAID, "healthcheck");

// ── File paths ─────────────────────────────────────────────────────────────

/** lib/memory semantic + episodic store */
export const SEMANTIC_MEMORY_FILE = path.join(MEMORY_DIR, "semantic.json");

/** Evidence pool: cross-session evidence + conflict persistence */
export const EVIDENCE_POOL_FILE = path.join(BRAID, "evidence-pool.json");

/** Legacy path for lib/memory (kept for graceful migration) */
export const LEGACY_MEMORY_FILE = path.join(PI, "memory", "memory.json");

/** Three-memory-stores retrospective episodes */
export const EPISODES_FILE = path.join(MEMORY_DIR, "episodes.jsonl");

/** Error-capture: classified error log */
export const ERROR_LOG_FILE = path.join(ERROR_DIR, "errors.jsonl");
export const ERROR_FILE = ERROR_LOG_FILE;

/** Consolidation: behavioral hints from successful patterns */
export const CONSOLIDATED_HINTS_FILE = path.join(BRAID, "consolidated-hints.jsonl");

/** Analytics: tool call metrics + A/B variant tracking */
export const METRICS_FILE = path.join(METRICS_DIR, "braid-metrics.jsonl");

/** Degradation detector: health metrics state */
export const DEGRADATION_FILE = path.join(METRICS_DIR, "degradation.json");

// ── Ensure directories exist ─────────────────────────────────────────────
