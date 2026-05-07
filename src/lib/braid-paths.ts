/**
 * Braid Paths — centralized storage paths under ~/.pi/agent/braid/
 *
 * All braid-specific persistent storage is consolidated here.
 * This makes it easy to find, audit, and migrate braid data.
 *
 * Directory layout:
 *   ~/.pi/
 *   ├── agent/
 *   │   ├── braid/              ← ALL braid data
 *   │   │   ├── memory/
 *   │   │   │   ├── semantic.json      (cognitive-memory: semantic + episodic memories)
 *   │   │   │   └── episodes.jsonl    (three-memory-stores: retrospective episodes)
 *   │   │   ├── checkpoints/          (state-checkpoint: extension state snapshots)
 *   │   │   ├── errors/               (error-capture: classified error log)
 *   │   │   ├── feedback/             (feedback: per-model preferences + nudge history)
 *   │   │   ├── retry-state.json      (retry: command/state persistence)
 *   │   │   ├── tools-config.json     (assistant: custom tools config)
 *   │   │   ├── session-recall.json   (session-recall: cross-session history)
 *   │   │   └── scratchpads/         (scratchpad: task state per project)
 *   │   └── settings.json       (pi-native + braid config)
 *   ├── logs/
 *   │   └── braid-metrics.jsonl  (analytics: tool call metrics + A/B variants)
 *   └── memory/
 *       └── memory.json          (cognitive-memory legacy path — kept for migration compat)
 *
 * Paths NOT under braid/ (appropriate elsewhere):
 *   - ~/.pi/logs/braid-metrics.jsonl  → logs directory
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
export const MEMORY_DIR = path.join(BRAID, "memory");
export const CHECKPOINT_DIR = path.join(BRAID, "checkpoints");
export const ERROR_DIR = path.join(BRAID, "errors");
export const FEEDBACK_DIR = path.join(BRAID, "feedback");
export const SCRATCHPAD_DIR = path.join(BRAID, "scratchpads");

// ── File paths ─────────────────────────────────────────────────────────────

/** Cognitive-memory semantic + episodic store */
export const SEMANTIC_MEMORY_FILE = path.join(MEMORY_DIR, "semantic.json");

/** Legacy path for cognitive-memory (kept for graceful migration) */
export const LEGACY_MEMORY_FILE = path.join(PI, "memory", "memory.json");

/** Three-memory-stores retrospective episodes */
export const EPISODES_FILE = path.join(MEMORY_DIR, "episodes.jsonl");

/** Legacy path for episodes (migrated in v0.2.0-alpha.6) */
export const LEGACY_EPISODES_FILE = path.join(AGENT, "memory", "episodes.jsonl");

/** State-checkpoint: extension state snapshots */
export const CHECKPOINT_FILE = (sessionId: string) =>
  path.join(CHECKPOINT_DIR, `checkpoint-${sessionId}.json`);

/** Error-capture: classified error log */
export const ERROR_LOG_FILE = path.join(ERROR_DIR, "errors.jsonl");
export const ERROR_FILE = ERROR_LOG_FILE;

/** Feedback: per-model preferences + nudge history */
export const FEEDBACK_FILE = path.join(FEEDBACK_DIR, "feedback.json");

/** Feedback: analytics export */
export const FEEDBACK_ANALYTICS_FILE = path.join(FEEDBACK_DIR, "analytics.jsonl");

/** Retry: command + state persistence */
export const RETRY_STATE_FILE = path.join(BRAID, "retry-state.json");

/** Assistant: custom tools config */
export const TOOLS_CONFIG_FILE = path.join(BRAID, "tools-config.json");

/** Session-recall: cross-session history */
export const SESSION_RECALL_FILE = path.join(BRAID, "session-recall.json");

// ── Log paths (NOT under braid/ — logs directory is appropriate) ─────────

/** Analytics: tool call metrics + A/B variant tracking */
export const METRICS_FILE = path.join(PI, "logs", "braid-metrics.jsonl");

// ── Ensure directories exist ─────────────────────────────────────────────

/**
 * Get all braid directories that should exist on disk.
 * Useful for initialization and health checks.
 */
export function getAllBraidDirs(): string[] {
  return [
    BRAID,
    MEMORY_DIR,
    CHECKPOINT_DIR,
    ERROR_DIR,
    FEEDBACK_DIR,
    SCRATCHPAD_DIR,
  ];
}
