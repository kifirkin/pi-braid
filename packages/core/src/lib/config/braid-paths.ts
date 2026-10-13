/**
 * Braid Paths - centralized storage paths for braid's persistent data.
 *
 * All braid-specific persistent storage is consolidated here.
 * This makes it easy to find, audit, and migrate braid data.
 *
 * Canonical local registry for packages/core (and, through the `pi-braid/lib`
 * public entry, for packages/contrib). Restored from its own local content
 * when the temporary `export * from "pi-braid-lib"` wholesale re-export was
 * retired (see packages/core/docs/archive/monorepo-architecture-review.md).
 */

import * as path from "node:path";
import * as os from "node:os";
import { realpathSync } from "node:fs";

// The module-load constants below are the PRECOMPUTED DEFAULT for the paths
// declared from them. They are read-side compatibility, not a base to write
// from: `os.homedir()` is folded once, at import, so a home that is relative
// or blank makes every one of them relative to whatever cwd the process has.
// Durable-write callers must resolve through the accessors (braidDir(),
// offloadDir(), getTimerFilePath(), ...) instead.
const HOME = os.homedir();
const PI = path.join(HOME, ".pi");
const AGENT = path.join(PI, "agent");
const BRAID = path.join(AGENT, "braid");

/** `os.homedir()` when it resolves an absolute path, else null. */
function absoluteHome(): string | null {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return null;
  }
  return home && path.isAbsolute(home) ? home : null;
}

/**
 * Root for braid's persistent state, overridable per process via BRAID_HOME
 * (read on every call). Callers that WRITE durable state must resolve through
 * this accessor instead of a precomputed const, so test harnesses can pin
 * the whole braid tree into a tmpdir and prove the live tree was untouched.
 *
 * The no-override leg is derived here, on every call, and must be absolute:
 * with `HOME=.` or `HOME=""` the old module-load fallback produced a RELATIVE
 * root, so a module toggle (or any other default-leg writer) created
 * `.pi/agent/braid/...` inside the user's project. The override leg carries
 * the same rule for the same reason: a relative BRAID_HOME resolves against
 * whatever cwd the process has, so a pinned run started from a project wrote
 * braid's whole state tree into that project. A root that is not absolute
 * names no directory braid owns, so this throws instead of returning one;
 * callers that can skip (a writer) or degrade (a reader) decide what to do
 * with the refusal. BRAID_HOME wins whenever it is set to an absolute path.
 */
export function braidDir(): string {
  const override = process.env.BRAID_HOME;
  if (override && override.trim()) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `braid: BRAID_HOME must be an absolute path (got "${override}"): a ` +
          "relative override resolves against whatever cwd the process has, " +
          "so the whole braid state tree lands in the session's project. Set " +
          "BRAID_HOME to an absolute directory, or unset it.",
      );
    }
    return path.resolve(override);
  }
  const home = absoluteHome();
  if (home === null) {
    throw new Error(
      "braid: BRAID_HOME is not set and os.homedir() does not resolve an " +
        "absolute path, so braid's state directory cannot be derived without " +
        "writing beside the cwd. Set BRAID_HOME (or HOME) to an absolute " +
        "directory.",
    );
  }
  return path.join(home, ".pi", "agent", "braid");
}

// ── Base directories ────────────────────────────────────────────────────────

export const BRAID_DIR = BRAID;
export { BRAID };
export { AGENT };
export const MEMORY_DIR = path.join(BRAID, "memory");
export const CHECKPOINT_DIR = path.join(BRAID, "checkpoints");
export const ERROR_DIR = path.join(BRAID, "errors");
export const SCRATCHPAD_DIR = path.join(BRAID, "scratchpads");
export const METRICS_DIR = path.join(BRAID, "metrics");
export const TELEMETRY_DIR = path.join(BRAID, "telemetry");
export const HEALTHCHECK_DIR = path.join(BRAID, "healthcheck");
/** Lossless flush target for offloaded stale tool results. Precomputed from
 *  the default root: a caller that WRITES here must resolve through
 *  `offloadDir()` so BRAID_HOME pinning applies (see braidDir()). */
export const OFFLOAD_DIR = path.join(BRAID, "offload");

/** Offload root, resolved on every call (BRAID_HOME pinning honored). Also
 *  the containment root `offload_recover` accepts stub paths under, so writer
 *  and reader can never disagree about where a flush landed. */
export function offloadDir(): string {
  return path.join(braidDir(), "offload");
}

/** Memory root (semantic + episodic stores), resolved on every call. */
export function memoryDir(): string {
  return path.join(braidDir(), "memory");
}

/** Session checkpoints root, resolved on every call. */
export function checkpointDir(): string {
  return path.join(braidDir(), "checkpoints");
}

/** Error-capture root, resolved on every call. */
export function errorDir(): string {
  return path.join(braidDir(), "errors");
}

/** Scratchpad root (one dir per project slug), resolved on every call. */
export function scratchpadDir(): string {
  return path.join(braidDir(), "scratchpads");
}

/** Healthcheck scratch and report root, resolved on every call. Durable-write
 *  state: the probes and the saved report must follow a pinned BRAID_HOME. */
export function healthcheckDir(): string {
  return path.join(braidDir(), "healthcheck");
}

/** Analytics metrics root, resolved on every call. */
export function metricsDir(): string {
  return path.join(braidDir(), "metrics");
}

/** Telemetry sink root (context-heartbeat JSONL), resolved on every call. */
export function telemetryDir(): string {
  return path.join(braidDir(), "telemetry");
}

/** Workspace snapshot root, resolved on every call. */
export function snapshotDir(): string {
  return path.join(braidDir(), "snapshots");
}

/** Per-project store root (locks, workers, timers, module overrides,
 *  deliverables), resolved on every call. */
export function projectsDir(): string {
  return path.join(braidDir(), "projects");
}

// ── File paths ─────────────────────────────────────────────────────────────

/** lib/memory semantic + episodic store */
export const SEMANTIC_MEMORY_FILE = path.join(MEMORY_DIR, "semantic.json");

/** Semantic store, resolved on every call (durable-write base). */
export function semanticMemoryFilePath(): string {
  return path.join(memoryDir(), "semantic.json");
}

/** Evidence pool: cross-session evidence + conflict persistence */
export const EVIDENCE_POOL_FILE = path.join(BRAID, "evidence-pool.json");

/** Evidence pool store, resolved on every call (durable-write base). */
export function evidencePoolFilePath(): string {
  return path.join(braidDir(), "evidence-pool.json");
}

/** Legacy path for lib/memory (kept for graceful migration) */
export const LEGACY_MEMORY_FILE = path.join(PI, "memory", "memory.json");

/** Legacy pre-braid memory store, resolved on every call. The one path here
 *  that is not a child of the live root: the old layout kept the store at
 *  `<old root>/memory/memory.json`, with the braid home two levels below the
 *  old root (`<old root>/agent/braid`), so this derives the source from the
 *  live root the same way the precomputed default names it. Under a pinned
 *  root that is the pin's own (normally absent) predecessor, never the store
 *  under the developer's default tree: a read that imports prior state has to
 *  follow the pin with everything else. Readers degrade when the root refuses
 *  (see braidDir()): no source, no import. */
export function legacyMemoryFilePath(): string {
  return path.join(braidDir(), "..", "..", "memory", "memory.json");
}

/** Three-memory-stores retrospective episodes */
export const EPISODES_FILE = path.join(MEMORY_DIR, "episodes.jsonl");

/** Episodic store, resolved on every call (durable-write base). */
export function episodesFilePath(): string {
  return path.join(memoryDir(), "episodes.jsonl");
}

/** Memory write gate: append-only per-decision log (measurement hook). */
export const WRITE_LOG_FILE = path.join(MEMORY_DIR, "write-log.jsonl");

/** Write-decision log, resolved on every call (durable-write base). */
export function writeLogFilePath(): string {
  return path.join(memoryDir(), "write-log.jsonl");
}

/** Error-capture: classified error log */
export const ERROR_LOG_FILE = path.join(ERROR_DIR, "errors.jsonl");
export const ERROR_FILE = ERROR_LOG_FILE;

/** Classified error log, resolved on every call (durable-write base). */
export function errorsFilePath(): string {
  return path.join(errorDir(), "errors.jsonl");
}

/** Consolidation: behavioral hints from successful patterns */
export const CONSOLIDATED_HINTS_FILE = path.join(BRAID, "consolidated-hints.jsonl");

/** Consolidated hints log, resolved on every call (durable-write base). */
export function consolidatedHintsFilePath(): string {
  return path.join(braidDir(), "consolidated-hints.jsonl");
}

/** Analytics: tool call metrics + A/B variant tracking */
export const METRICS_FILE = path.join(METRICS_DIR, "braid-metrics.jsonl");

/** Analytics metrics log, resolved on every call (durable-write base). */
export function metricsFilePath(): string {
  return path.join(metricsDir(), "braid-metrics.jsonl");
}

/** Degradation detector: health metrics state */
export const DEGRADATION_FILE = path.join(METRICS_DIR, "degradation.json");

/** Degradation state, resolved on every call (durable-write base). */
export function degradationFilePath(): string {
  return path.join(metricsDir(), "degradation.json");
}

/** Shown-signals persistence: survive process restart for session resume dedup */
export const SHOWN_SIGNALS_FILE = path.join(BRAID, "shown-signals.json");

/** Shown-signals index, resolved on every call (write-through cache base). */
export function shownSignalsFilePath(): string {
  return path.join(braidDir(), "shown-signals.json");
}

/** Persistent one-shot timers (JSONL): survive process restart.
 *  Legacy precomputed path — kept for compatibility. Durable-write callers
 *  must resolve their actual path through getTimerFilePath, which routes
 *  through braidDir() so BRAID_HOME pinning is honored. */
export const PENDING_TIMERS_FILE = path.join(BRAID, "pending-timers.jsonl");

/** Orchestrator file-lock registry: track which files are locked by which worker. */
export const LOCK_FILE = path.join(BRAID, "locks.json");

/** Orchestrator worker registry: track worker lifecycle and result locations. */
export const WORKERS_FILE = path.join(BRAID, "workers.json");

/** Skills adoption: cross-session per-skill usage counters. */
export const SKILLS_USAGE_FILE = path.join(BRAID, "skills-usage.json");

/** Skills adoption: durable per-session adoption records (append-only JSONL). */
export const SKILLS_SESSIONS_FILE = path.join(BRAID, "skills-sessions.jsonl");

/** Braid config home (session profiles and future braid-owned settings). */
export const BRAID_CONFIG_FILE = path.join(BRAID, "config.json");

/**
 * Sanitize a filesystem path for use as a directory name.
 *
 * The path is canonicalized through realpath before it becomes a key, so one
 * directory reached through two spellings (a symlink such as /tmp or
 * /var/folders on macOS, versus the real path a process reports as its cwd)
 * keys to ONE store. Without it a row written under one spelling is invisible
 * to a caller using the other, and a second store forks off. A path that does
 * not exist yet cannot be canonicalized, so it keeps its lexical form.
 */
function sanitizePathForDir(p: string): string {
  let canonical = path.resolve(p);
  try {
    canonical = realpathSync(canonical);
  } catch {
    /* not on disk yet: key on the lexical path */
  }
  return canonical
    .replace(/[/:]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

/** Sanitize a single path segment for use as a file/dir name (no resolve). */
function sanitizeSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);
}

/** File name (sans `.json`) of the cross-session tag file for one project.
 *  One rule for the three sites that touch that file: the tag writer
 *  (register-tool-call), the context-lifecycle proposal merge and the
 *  session-start discoverability signal. It lived inline at those sites, so a
 *  second spelling split the file in two: the writer's, which the proposal
 *  merge matched, and the discoverability reader's `--wrapped--` form (the
 *  scratchpad/sessions convention), which matched nothing the writer ever
 *  wrote and silently muted the `tags_prior` signal. */
export function tagsSlugFromCwd(cwd?: string): string {
  if (!cwd) return "default";
  return cwd.split("/").filter(Boolean).join("-") || "default";
}

/**
 * Get the lossless flush file path for one offloaded tool result.
 * Layout: <offload dir>/<sessionId>/<toolName>-<toolCallId>.txt.
 * The stub embedded in the LLM context carries this path; recovery = read it.
 */
export function getOffloadFilePath(
  sessionId: string,
  toolCallId: string,
  toolName: string,
): string {
  return path.join(
    offloadDir(),
    sanitizeSegment(sessionId || "anonymous"),
    `${sanitizeSegment(toolName || "unknown")}-${sanitizeSegment(toolCallId || "unknown")}.txt`,
  );
}

/** Get the per-CWD pending timers file path.
 *  Resolves through braidDir() — this file is DURABLE WRITE state, and the
 *  braidDir() contract requires write paths to honor BRAID_HOME so test
 *  harnesses can pin the whole braid tree into a tmpdir. A precomputed
 *  const here would silently write test fixtures into the live store. */
export function getTimerFilePath(cwd?: string): string {
  if (!cwd) return path.join(braidDir(), "pending-timers.jsonl");
  const projectDir = sanitizePathForDir(cwd);
  return path.join(projectsDir(), projectDir, "pending-timers.jsonl");
}

/** Get the per-CWD module overrides store path.
 *  Braid's own record of the runtime module toggles (`braid.modules` values a
 *  toggle persisted), kept out of the user's project: writing it into
 *  `<cwd>/.pi/settings.json` made braid create files in a stranger's repo.
 *  Resolves through braidDir() — durable write state, so BRAID_HOME pinning
 *  must move it. A `braid.modules` block in pi's agent-directory settings file
 *  stays an INPUT (see the loader's read order); it is never written. The cwd
 *  is required: a store at the braid root names no project and has no writer
 *  in production, so it would only be a second, silently divergent location. */
export function getModuleOverridesFilePath(cwd: string): string {
  if (!cwd) {
    throw new Error(
      "getModuleOverridesFilePath needs the project cwd: the module store is " +
        "per project, and a store at the braid root names none.",
    );
  }
  const projectDir = sanitizePathForDir(cwd);
  return path.join(projectsDir(), projectDir, "module-overrides.json");
}

/** Get the per-CWD lock file path.
 *  Resolves through braidDir() (and projectsDir() for the project leg): the
 *  registry is DURABLE WRITE state, so BRAID_HOME pinning must move it; the
 *  precomputed LOCK_FILE leg is the read-side default beside the braid root. */
export function getLockFilePath(cwd?: string): string {
  if (!cwd) return path.join(braidDir(), "locks.json");
  const projectDir = sanitizePathForDir(cwd);
  return path.join(projectsDir(), projectDir, "locks.json");
}

/** Get the per-CWD worker registry path (beside locks.json). Durable write
 *  state: same braidDir() leg as getLockFilePath. */
export function getWorkersFilePath(cwd?: string): string {
  if (!cwd) return path.join(braidDir(), "workers.json");
  const projectDir = sanitizePathForDir(cwd);
  return path.join(projectsDir(), projectDir, "workers.json");
}

/** Get the per-CWD deliverables manifest path (session-touched files the
 *  verification judge reads as ground truth). Durable write state: resolves
 *  through braidDir() so BRAID_HOME pinning is honored, and lives under the
 *  braid home — never under <repo>/.braid, which polluted every project a
 *  session ran in. */
export function getDeliverablesFilePath(cwd?: string): string {
  if (!cwd) return path.join(braidDir(), "deliverables.jsonl");
  const projectDir = sanitizePathForDir(cwd);
  return path.join(projectsDir(), projectDir, "deliverables.jsonl");
}

/** Get the skills adoption usage file path. Durable write state: resolves
 *  through braidDir() so BRAID_HOME pinning is honored. */
export function getSkillsUsageFilePath(): string {
  return path.join(braidDir(), "skills-usage.json");
}

/** Get the per-session skills adoption records path (append-only JSONL).
 *  Durable write state: same braidDir() leg as getSkillsUsageFilePath. */
export function getSkillsSessionsFilePath(): string {
  return path.join(braidDir(), "skills-sessions.jsonl");
}

/** Get the braid config home path (BRAID_CONFIG_FILE). Resolved through
 *  braidDir() so a pinned braid tree reads its own config, not the default one. */
export function getBraidConfigFilePath(): string {
  return path.join(braidDir(), "config.json");
}
