/**
 * Worker registry for multi-agent orchestration.
 *
 * Admission, lifecycle, and result-location records for agent workers.
 * The parent registers a worker before spawning it, updates the handle as
 * pane/session facts arrive, and closes the entry with an outcome and gate
 * evidence. `checkWorker` computes a verdict from evidence (output file,
 * session growth, branch commits, result schema) — never from the worker's
 * own claim alone.
 *
 * Registry file location: ~/.pi/agent/braid/projects/<sanitized-cwd>/workers.json
 * (per-CWD, beside locks.json, shared across all agents on the same project).
 *
 * A terminal completion is also judged for effect evidence — a deliverable
 * written during the run, a branch advance or recorded merge, or a gate that
 * exited 0. A completed close with none of the three is flagged, not refused:
 * the flag travels on the close result and the check verdict.
 *
 * Writes are atomic (temp file + rename) with mode 0600. Reads tolerate a
 * missing or corrupt file by returning an empty registry, like locks.ts.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { BRAID, getWorkersFilePath } from "../config/braid-paths.js";
import { getAllLocks, releaseLock } from "./locks.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type WorkerStatus =
  | "admitted"
  | "working"
  | "merged"
  | "completed"
  | "error"
  | "stalled"
  | "false-done"
  | "closed";

/** Terminal outcomes accepted by closeWorker. */
export type WorkerOutcome = "completed" | "error" | "stalled" | "false-done" | "closed";

export interface WorkerGate {
  cmd: string;
  exit: number;
  at: string;
}

/** One duplicate admission a live entry turned away, and the request it refused. */
export interface WorkerAdmissionRefusal {
  /** The request id whose admission this entry refused. */
  requestId: string;
  /** When the refusal was recorded. */
  at: string;
}

/**
 * Checkpoint fields a caller supplies. The registry stamps `at`, so a writer
 * cannot backdate a resume point.
 */
export interface WorkerCheckpointInput {
  /** Lifecycle phase the worker is in (e.g. "impl", "gates"). */
  phase: string;
  /** Last completed step within that phase (e.g. "commit", "typecheck"). */
  step: string;
}

export interface WorkerCheckpoint extends WorkerCheckpointInput {
  /** When the checkpoint was written. */
  at: string;
}

export interface WorkerEntry {
  workerId: string;
  spec: string;
  status: WorkerStatus;
  cwd: string;
  pane: string | null;
  workspace: string | null;
  workerSession: string | null;
  outputFile: string | null;
  branch: string | null;
  files: string[];
  spawnedAt: string;
  lastSeenAt: string | null;
  resultAt: string | null;
  /** Base tip this worker's work merges into; null until a merge lands. */
  mergeSha: string | null;
  /** When that merge landed. */
  mergedAt: string | null;
  closedAt: string | null;
  gates: WorkerGate[];
  /**
   * Duplicate admissions this row turned away while it was live: each records
   * the request id that was refused and when. Summed for the fleet's refusal
   * count, so the number is registry fact rather than an inference.
   */
  admissionRefusals: WorkerAdmissionRefusal[];
  /**
   * Exactly-once identity of the unit of work this entry admits, keyed by
   * `(workerId, step)` — see deriveRequestId. Null on a row admitted before
   * request ids existed, and no request ever matches such a row.
   */
  requestId: string | null;
  /**
   * Where the work stood when the entry was last written: the phase and the
   * last step completed in it. Null when the worker never recorded one, which
   * leaves the row with no resume point.
   */
  checkpoint: WorkerCheckpoint | null;
}

export interface WorkerRegistry {
  version: number;
  workers: Record<string, WorkerEntry>;
}

export interface RegisterWorkerInput {
  workerId: string;
  spec: string;
  cwd: string;
  files?: string[];
  branch?: string;
  outputFile?: string;
  /**
   * Worker handle, when the caller already has it at admission time. Absent
   * stays null: a handle is never invented, and a pane is a place to look, not
   * evidence that anything runs there.
   */
  pane?: string;
  /** Path to the worker's session .jsonl; the only liveness evidence the
   * registry holds, read as file mtime by evaluateWorker. */
  workerSession?: string;
  /**
   * Exactly-once request id for this submission. Defaults to the derived
   * `(workerId, step)` key for step 1, so a retried admission of the same work
   * resolves to the same request and reuses the entry it already admitted.
   */
  requestId?: string;
}

export interface RegisterWorkerResult {
  ok: boolean;
  entry?: WorkerEntry;
  reason?: string;
  /** True when a live entry already admitted this request and was reused. */
  reused?: boolean;
}

export interface UpdateWorkerPatch {
  pane?: string;
  workspace?: string;
  workerSession?: string;
  outputFile?: string;
  branch?: string;
  files?: string[];
  status?: WorkerStatus;
  /** Resume point to record; stamped with the write time. */
  checkpoint?: WorkerCheckpointInput;
}

export interface WorkerCheckOptions {
  /** herdr lifecycle state (idle|working|blocked|done|unknown), passed by the parent. */
  liveStatus?: string;
  /** Git repo root used for the branch-ahead count. */
  cwd?: string;
  /**
   * Branch recorded on this worker's lock rows. Used only when the entry has
   * no branch of its own (`entry.branch ?? fallbackBranch`); when omitted,
   * checkWorker reads the project lock table itself.
   */
  fallbackBranch?: string;
  /** Clock override for tests; defaults to Date.now(). */
  now?: number;
  /** Frozen-session threshold in seconds; defaults to 600. */
  stalledAfterSec?: number;
}

export interface WorkerCheckResult {
  workerId: string;
  status: WorkerVerdictStatus;
  reason: string;
  outputFile: string | null;
  outputExists: boolean;
  outputAgeSec: number | null;
  sessionGrowthAgeSec: number | null;
  branchAhead: number | null;
  schemaValid: boolean;
  /**
   * How many assistant messages back from the newest the result block was
   * found (0 = the last assistant message), or null when none was valid
   * within the scan window. Lets a parent tell a terminal block from a
   * near-terminal one.
   */
  resultSchemaMessageOffset: number | null;
  /** Request id the entry was admitted under, when it recorded one. */
  requestId: string | null;
  /** Resume point the entry carries, when it has one. */
  checkpoint: WorkerCheckpoint | null;
  gateSummary: string;
  /**
   * Effect evidence for a terminal completion, or null when the row is not
   * one (unclosed, or closed with a non-completed outcome). `none` true is
   * the no-effect-evidence flag: the close recorded a completion while the
   * row shows none of the three evidence kinds.
   */
  effectEvidence: WorkerEffectEvidence | null;
}

/**
 * A status the registry reports. `resumable` is derived, never stored: it says
 * the entry is mid-flight with a checkpoint to resume from, which is a
 * statement about evidence rather than a lifecycle state a caller sets. No
 * stored row carries it, so the on-disk status set is unchanged.
 */
export type WorkerVerdictStatus = WorkerStatus | "resumable";

// ── Constants ──────────────────────────────────────────────────────────────

export const WORKER_REGISTRY_VERSION = 1;

/**
 * Spec names a worker result may declare: the accepted set, and the one source
 * the tool schema renders from. `project` is in the set; the tool prose listed
 * only four before it rendered from here, which is the drift this list ends.
 */
export const WORKER_SPECS: readonly string[] = ["research", "impl", "verify", "audit", "project"];

export const WORKER_STATUSES: readonly WorkerStatus[] = [
  "admitted",
  "working",
  "merged",
  "completed",
  "error",
  "stalled",
  "false-done",
  "closed",
];

export const WORKER_OUTCOMES: readonly WorkerOutcome[] = [
  "completed",
  "error",
  "stalled",
  "false-done",
  "closed",
];

/** Statuses check-worker may report: the stored statuses plus `resumable`. */
export const WORKER_VERDICT_STATUSES: readonly WorkerVerdictStatus[] = [
  ...WORKER_STATUSES,
  "resumable",
];

/** Statuses a worker's result schema may self-report. */
export const RESULT_SCHEMA_STATUSES: readonly string[] = [
  "completed",
  "partial",
  "blocked",
  "error",
];

/**
 * The four roles a worker lifecycle's values can play. They are distinct
 * vocabularies that share words: `completed` is a stored status, a close
 * outcome, a computed verdict and a result attestation, so a bare value
 * means nothing until the layer names which one it is.
 */
export type WorkerStatusLayerRole =
  | "stored status"
  | "close outcome"
  | "computed verdict"
  | "result attestation";

/** One vocabulary in the status-layer table: its role, writer, and values. */
export interface WorkerStatusLayer {
  /** The role the values play; the four layers are never interchangeable. */
  role: WorkerStatusLayerRole;
  /** Who writes values in this layer. */
  owner: string;
  /** Accepted values, in reporting order. */
  values: readonly string[];
  /** What one value in this layer states, as a clause the tool schema reuses. */
  states: string;
}

/**
 * The four vocabularies a worker lifecycle speaks in, each with its values and
 * its writer. Readers (the tool schema, the tests, the report) render from this
 * table rather than restating the values, so a value added here reaches every
 * reader at once.
 */
export const WORKER_STATUS_LAYERS: readonly WorkerStatusLayer[] = [
  {
    role: "stored status",
    owner: "registry row (spawn admission, update-worker, close and merge writes)",
    values: WORKER_STATUSES,
    states: "the lifecycle state the registry row carries",
  },
  {
    role: "close outcome",
    owner: "close-worker call",
    values: WORKER_OUTCOMES,
    states: "the terminal outcome a close records",
  },
  {
    role: "computed verdict",
    owner: "check-worker",
    values: WORKER_VERDICT_STATUSES,
    states: "what check-worker derives from evidence, resumable never stored",
  },
  {
    role: "result attestation",
    owner: "worker's own result block",
    values: RESULT_SCHEMA_STATUSES,
    states: "what the worker's result block claims about its own result",
  },
];

const DEFAULT_STALLED_AFTER_SEC = 600;

/**
 * How many assistant messages back from the newest a result block may sit.
 * A worker that emits its validated block and then one closing prose line is
 * still terminal; a parent must be able to tell that block from a progress
 * note, so the offset is recorded in the verdict.
 */
const RESULT_SCHEMA_MAX_MESSAGES_BACK = 3;

// ── Status parsing ─────────────────────────────────────────────────────────

export function parseWorkerStatus(raw: string): WorkerStatus {
  const value = raw.trim() as WorkerStatus;
  if (!WORKER_STATUSES.includes(value)) {
    throw new Error(
      `Unknown worker status "${raw}". Expected one of: ${WORKER_STATUSES.join(", ")}`,
    );
  }
  return value;
}

export function parseWorkerOutcome(raw: string): WorkerOutcome {
  const value = raw.trim() as WorkerOutcome;
  if (!WORKER_OUTCOMES.includes(value)) {
    throw new Error(
      `Unknown worker outcome "${raw}". Expected one of: ${WORKER_OUTCOMES.join(", ")}`,
    );
  }
  return value;
}

// ── Registry I/O ───────────────────────────────────────────────────────────

function emptyRegistry(): WorkerRegistry {
  return { version: WORKER_REGISTRY_VERSION, workers: {} };
}

/**
 * Fill in what a row written before these fields existed lacks. The read path
 * writes nothing back: an entry with no request id or checkpoint reports null
 * for both and keeps every other fact it has, so reading a legacy registry
 * migrates nothing.
 */
function normalizeEntry(raw: WorkerEntry): WorkerEntry {
  const requestId =
    typeof raw.requestId === "string" && raw.requestId.length > 0 ? raw.requestId : null;
  return {
    ...raw,
    requestId,
    checkpoint: isCheckpoint(raw.checkpoint) ? raw.checkpoint : null,
    admissionRefusals: Array.isArray(raw.admissionRefusals) ? raw.admissionRefusals : [],
  };
}

function isCheckpoint(raw: unknown): raw is WorkerCheckpoint {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as { phase?: unknown; step?: unknown; at?: unknown };
  return (
    typeof value.phase === "string" &&
    value.phase.length > 0 &&
    typeof value.step === "string" &&
    value.step.length > 0 &&
    typeof value.at === "string"
  );
}

function loadRegistryFile(file: string): WorkerRegistry {
  try {
    if (!existsSync(file)) return emptyRegistry();
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return emptyRegistry();
    const parsed = JSON.parse(raw) as WorkerRegistry;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.workers ||
      typeof parsed.workers !== "object"
    ) {
      return emptyRegistry();
    }
    const workers: Record<string, WorkerEntry> = {};
    for (const [id, entry] of Object.entries(parsed.workers)) {
      if (entry && typeof entry === "object") workers[id] = normalizeEntry(entry);
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : WORKER_REGISTRY_VERSION,
      workers,
    };
  } catch {
    return emptyRegistry();
  }
}

/** Read the registry for a project cwd (defaults to process.cwd()). */
export function readWorkers(cwd?: string): WorkerRegistry {
  return loadRegistryFile(getWorkersFilePath(cwd ?? process.cwd()));
}

/**
 * Persist the registry atomically: temp file in the same directory, then
 * rename. Writes fail loudly (unlike lock writes) — a registry that
 * silently drops admissions is worse than a visible error.
 */
export function writeWorkers(registry: WorkerRegistry, cwd?: string): void {
  const file = getWorkersFilePath(cwd ?? process.cwd());
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(registry, null, 2), { encoding: "utf-8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

// ── Worker lookup ──────────────────────────────────────────────────────────

/**
 * Locate a worker entry. With an explicit cwd the lookup is scoped to that
 * project. Without one, the process cwd is tried first, then every project
 * registry under ~/.pi/agent/braid/projects — the parent often runs in its
 * own workspace while the worker's registry lives under the target repo.
 * Returns the registry plus the key used for writes (the entry's own cwd).
 */
function locateWorker(
  workerId: string,
  cwd?: string,
): { registry: WorkerRegistry; key: string } | null {
  const key = cwd ?? process.cwd();
  const registry = readWorkers(key);
  if (registry.workers[workerId]) return { registry, key };

  // A miss in the caller's own project is not proof the worker is unknown. A
  // project can be named differently by different callers while being one
  // directory, and an id-addressed action (check/update/close) that answered
  // "unknown" for a live row would leave it stranded. Walk every project
  // registry first; the caller's own key still wins when it has the row.
  const projectsDir = join(BRAID, "projects");
  try {
    for (const dirent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const other = loadRegistryFile(join(projectsDir, dirent.name, "workers.json"));
      const entry = other.workers[workerId];
      if (entry) return { registry: other, key: entry.cwd };
    }
  } catch {
    /* no projects dir yet */
  }
  return null;
}

// ── Request identity ───────────────────────────────────────────────────────

/**
 * The exactly-once identity of a unit of work: `(workerId, step)`. The step is
 * the submission attempt — 1 for the first — so a caller that retries the same
 * submission composes the same id and is recognized, while work admitted under
 * a later step gets its own id. Admission records the id on the entry, and a
 * submission whose id matches a live entry reuses that entry rather than
 * admitting a second one.
 */
export function deriveRequestId(workerId: string, step = 1): string {
  return `${workerId}:${step}`;
}

/** The request id an admission carries: the caller's, or the derived key. */
export function resolveRequestId(workerId: string, requestId?: string): string {
  const explicit = requestId?.trim();
  return explicit ? explicit : deriveRequestId(workerId);
}

/**
 * True when this entry admits the same request. A row with no recorded id
 * predates request identity, so nothing matches it: a legacy live entry keeps
 * refusing re-admission instead of being adopted silently by a new request.
 */
function isSameRequest(entry: WorkerEntry, requestId: string): boolean {
  return typeof entry.requestId === "string" && entry.requestId === requestId;
}

/** What a request states about the work, against what the entry recorded. */
function requestDifferences(
  entry: WorkerEntry,
  request: { spec?: string; files?: string[] },
): string[] {
  const differences: string[] = [];
  if (request.spec !== undefined && request.spec !== entry.spec) {
    differences.push(`spec "${entry.spec}" vs "${request.spec}"`);
  }
  if (request.files !== undefined) {
    const recorded = [...entry.files].sort();
    const requested = [...request.files].sort();
    const same =
      recorded.length === requested.length && recorded.every((file, i) => file === requested[i]);
    if (!same) {
      differences.push(`files [${recorded.join(", ")}] vs [${requested.join(", ")}]`);
    }
  }
  return differences;
}

export interface WorkerAdmissionDecision {
  action: "admit" | "reuse" | "refuse";
  entry?: WorkerEntry;
  reason?: string;
}

/**
 * What admitting `requestId` does to the live entry that may hold this worker.
 * Reuse only when the ids match *and* the request describes the same work: a
 * second live row for one worker is the duplicate this identity prevents, and
 * the same id carrying a different payload is a contradiction, not a retry. A
 * closed entry is no obstacle — retries past a close are countable.
 */
export function decideAdmission(
  existing: WorkerEntry | undefined,
  requestId: string,
  request: { spec?: string; files?: string[] },
): WorkerAdmissionDecision {
  if (!existing || existing.closedAt) return { action: "admit" };
  if (!isSameRequest(existing, requestId)) {
    return {
      action: "refuse",
      entry: existing,
      reason:
        `worker ${existing.workerId} is live (status ${existing.status}, ` +
        `${existing.requestId ? `requestId ${existing.requestId}` : "no requestId recorded"}); ` +
        `requestId ${requestId} is a different request — close the live entry to admit it`,
    };
  }
  const differences = requestDifferences(existing, request);
  if (differences.length > 0) {
    return {
      action: "refuse",
      entry: existing,
      reason:
        `requestId ${requestId} is already admitted and describes different work ` +
        `(${differences.join("; ")}) — a retry carries the same payload; close the live ` +
        `entry before admitting changed work`,
    };
  }
  return { action: "reuse", entry: existing };
}

/** Append a refusal to the live entry it was made against; no I/O. */
function appendAdmissionRefusal(entry: WorkerEntry, requestId: string): void {
  const refusals = Array.isArray(entry.admissionRefusals) ? entry.admissionRefusals : [];
  refusals.push({ requestId, at: new Date().toISOString() });
  entry.admissionRefusals = refusals;
}

/**
 * Persist a refused admission against the live worker that refused it. A
 * refusal leaves the row's lifecycle untouched — no status, no handle, no
 * lastSeenAt — and records only the request id and the time, so the count of
 * turned-away duplicates is readable from the registry instead of inferred.
 * Returns false when the worker is unknown or already closed: a closed row
 * refuses nothing.
 */
export function recordAdmissionRefusal(workerId: string, requestId: string, cwd?: string): boolean {
  const located = locateWorker(workerId, cwd);
  if (!located) return false;
  const entry = located.registry.workers[workerId];
  if (entry.closedAt) return false;
  appendAdmissionRefusal(entry, requestId);
  writeWorkers(located.registry, located.key);
  return true;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Admit a worker. Refuses when a live (not closed) entry exists for the
 * same workerId; a closed entry is rolled over (retries are countable).
 */
export function registerWorker(input: RegisterWorkerInput, cwd?: string): RegisterWorkerResult {
  if (!input.workerId) throw new Error("workerId is required");
  if (!input.spec) throw new Error("spec is required");
  if (!input.cwd) throw new Error("cwd is required");

  const key = cwd ?? input.cwd;
  const registry = readWorkers(key);
  const existing = registry.workers[input.workerId];
  const requestId = resolveRequestId(input.workerId, input.requestId);
  const decision = decideAdmission(existing, requestId, { spec: input.spec, files: input.files });
  if (decision.action === "reuse") {
    return { ok: true, entry: decision.entry, reused: true };
  }
  if (decision.action === "refuse") {
    // Record the refusal on the live entry so the fleet's refusal count is a
    // registry fact; a refusal changes no lifecycle field.
    if (existing && !existing.closedAt) {
      appendAdmissionRefusal(existing, requestId);
      writeWorkers(registry, key);
    }
    return { ok: false, reason: decision.reason, entry: decision.entry };
  }

  const nowIso = new Date().toISOString();
  const entry: WorkerEntry = {
    workerId: input.workerId,
    spec: input.spec,
    status: "admitted",
    cwd: input.cwd,
    pane: input.pane ?? null,
    workspace: null,
    workerSession: input.workerSession ?? null,
    outputFile: input.outputFile ?? null,
    branch: input.branch ?? null,
    files: input.files ?? [],
    spawnedAt: nowIso,
    lastSeenAt: nowIso,
    resultAt: null,
    mergeSha: null,
    mergedAt: null,
    closedAt: null,
    gates: [],
    admissionRefusals: [],
    requestId,
    checkpoint: null,
  };
  registry.workers[input.workerId] = entry;
  writeWorkers(registry, key);
  return { ok: true, entry };
}

/** Stamp a caller's checkpoint with the write time; reject an empty phase/step. */
function stampCheckpoint(input: WorkerCheckpointInput): WorkerCheckpoint {
  const phase = input.phase?.trim();
  const step = input.step?.trim();
  if (!phase) throw new Error("checkpoint.phase is required");
  if (!step) throw new Error("checkpoint.step is required");
  return { phase, step, at: new Date().toISOString() };
}

/** Merge handle fields into an entry; refreshes lastSeenAt. Null when unknown. */
export function updateWorker(
  workerId: string,
  patch: UpdateWorkerPatch,
  cwd?: string,
): WorkerEntry | null {
  const located = locateWorker(workerId, cwd);
  if (!located) return null;
  const entry = located.registry.workers[workerId];

  if (patch.pane !== undefined) entry.pane = patch.pane;
  if (patch.workspace !== undefined) entry.workspace = patch.workspace;
  if (patch.workerSession !== undefined) entry.workerSession = patch.workerSession;
  if (patch.outputFile !== undefined) entry.outputFile = patch.outputFile;
  if (patch.branch !== undefined) entry.branch = patch.branch;
  if (patch.files !== undefined) entry.files = patch.files;
  if (patch.status !== undefined) entry.status = parseWorkerStatus(patch.status);
  if (patch.checkpoint !== undefined) entry.checkpoint = stampCheckpoint(patch.checkpoint);
  entry.lastSeenAt = new Date().toISOString();

  writeWorkers(located.registry, located.key);
  return entry;
}

/**
 * Record that this worker's work was merged into a base branch.
 *
 * The write goes to the row's own project key rather than to the caller's
 * cwd, so the mark cannot land beside the row instead of on it. Returns null
 * when the worker has no row at all: a merge records what admission already
 * established and never invents an entry, because `spec` and `outputFile` are
 * facts only admission knows.
 */
export function recordWorkerMerge(
  workerId: string,
  info: { mergeSha: string; cwd?: string },
): WorkerEntry | null {
  const located = locateWorker(workerId, info.cwd);
  if (!located) return null;
  const entry = located.registry.workers[workerId];

  const nowIso = new Date().toISOString();
  // A closed row keeps its terminal status: the merge is recorded on it, but
  // the outcome of the close stands.
  if (!entry.closedAt) entry.status = "merged";
  entry.mergeSha = info.mergeSha;
  entry.mergedAt = nowIso;
  entry.lastSeenAt = nowIso;
  if (!entry.resultAt) entry.resultAt = nowIso;

  writeWorkers(located.registry, located.key);
  return entry;
}

/**
 * Refuse close-time gate evidence that cannot describe a real run: a
 * completed close with nothing recorded, a non-array value, or an entry whose
 * `cmd` is not a non-empty string or whose `exit` is not a number. Throws on
 * the first violation, before the caller writes anything.
 */
function assertGateEvidence(
  workerId: string,
  outcome: WorkerOutcome,
  gates: Array<{ cmd: string; exit: number }> | undefined,
): void {
  if (gates !== undefined && !Array.isArray(gates)) {
    throw new Error(
      `closeWorker: gates must be an array of { cmd, exit } entries (worker ${workerId})`,
    );
  }
  if (outcome === "completed" && (!gates || gates.length === 0)) {
    throw new Error(
      `closeWorker: a completed close requires non-empty gate evidence (worker ${workerId})`,
    );
  }
  if (!gates) return;
  for (let i = 0; i < gates.length; i++) {
    const gate: unknown = gates[i];
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new Error(
        `closeWorker: gates[${i}] must be an object carrying cmd and exit (worker ${workerId})`,
      );
    }
    const { cmd, exit } = gate as { cmd?: unknown; exit?: unknown };
    if (typeof cmd !== "string" || cmd.trim() === "") {
      throw new Error(
        `closeWorker: gates[${i}].cmd must be a non-empty string (worker ${workerId})`,
      );
    }
    if (typeof exit !== "number" || !Number.isFinite(exit)) {
      throw new Error(`closeWorker: gates[${i}].exit must be a number (worker ${workerId})`);
    }
  }
}

/**
 * Close an entry with a terminal outcome and optional gate evidence.
 * Already-closed entries are left untouched (first close wins); the checks
 * below run only on a close that would actually stamp the row, so a retried
 * close stays a silent no-op and an unknown worker still returns null.
 *
 * A completed close carries evidence: the reporter contract requires a
 * non-empty `gate_evidence` block, and a probe measured this path storing a
 * bare `completed` with no gates at all. That contradiction is refused now,
 * and each provided gate is shape-checked (non-empty `cmd`, numeric `exit`)
 * before any write — a violation leaves the row and the lock table untouched.
 *
 * Releases the worker's file locks: close is terminal, and a lock that
 * survives it blocks the next spawn on the same files. The release runs with
 * the entry's own project key so the lock table read is the same one
 * `acquireLock` wrote; `release-locks` stays the explicit override.
 */
export function closeWorker(
  workerId: string,
  outcome: WorkerOutcome,
  gates?: Array<{ cmd: string; exit: number }>,
  cwd?: string,
): WorkerEntry | null {
  const parsed = parseWorkerOutcome(outcome);
  const located = locateWorker(workerId, cwd);
  if (!located) return null;
  const entry = located.registry.workers[workerId];
  if (entry.closedAt) return entry;

  assertGateEvidence(workerId, parsed, gates);

  releaseLock(workerId, located.key);

  const nowIso = new Date().toISOString();
  entry.status = parsed;
  entry.closedAt = nowIso;
  entry.lastSeenAt = nowIso;
  if (parsed === "completed" && !entry.resultAt) entry.resultAt = nowIso;
  if (gates && gates.length > 0) {
    for (const gate of gates) {
      entry.gates.push({ cmd: gate.cmd, exit: gate.exit, at: nowIso });
    }
  }

  writeWorkers(located.registry, located.key);
  return entry;
}

// ── Result schema ──────────────────────────────────────────────────────────

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isResultSchema(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.worker === "string" &&
    obj.worker.length > 0 &&
    typeof obj.spec === "string" &&
    obj.spec.length > 0 &&
    typeof obj.status === "string" &&
    RESULT_SCHEMA_STATUSES.includes(obj.status) &&
    typeof obj.output_file === "string" &&
    obj.output_file.length > 0
  );
}

/**
 * Pull the newest valid result block out of one assistant message, or null.
 * Fenced ```json blocks are tried newest-first, then a bare JSON body.
 */
function extractResultBlock(content: unknown): Record<string, unknown> | null {
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  } else if (typeof content === "string") {
    texts.push(content);
  }
  const joined = texts.join("\n");

  const blocks = [...joined.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let b = blocks.length - 1; b >= 0; b--) {
    const parsed = tryParseObject(blocks[b]);
    if (parsed && isResultSchema(parsed)) return parsed;
  }
  const bare = tryParseObject(joined.trim());
  if (bare && isResultSchema(bare)) return bare;
  return null;
}

/** A located result block plus where it sat in the assistant-message tail. */
export interface ResultSchemaLocation {
  schema: Record<string, unknown>;
  /** Assistant messages back from the newest (0 = the last assistant message). */
  messageOffset: number;
}

/**
 * Locate the worker's result-schema block in the session file.
 *
 * Scans the last assistant message first. A worker that emits its validated
 * block and then one closing prose line still produced a terminal result, so
 * when that message yields no block the scan continues through at most
 * `maxMessagesBack` assistant messages and takes the most recent valid one.
 * The offset is returned so a caller can distinguish a terminal block (0) from
 * a near-terminal one. No valid block within the window is still a failure.
 */
export function locateResultSchema(
  sessionPath: string | null,
  maxMessagesBack = RESULT_SCHEMA_MAX_MESSAGES_BACK,
): ResultSchemaLocation | null {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  try {
    const lines = readFileSync(sessionPath, "utf-8").split("\n");
    let seen = 0;
    for (let i = lines.length - 1; i >= 0 && seen < maxMessagesBack; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = record.message as { role?: string; content?: unknown } | undefined;
      if (record.type !== "message" || message?.role !== "assistant") continue;

      const offset = seen;
      seen++;
      const parsed = extractResultBlock(message.content);
      if (parsed) return { schema: parsed, messageOffset: offset };
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the session carries a valid result block within the scan window. */
export function validateResultSchema(sessionPath: string | null): boolean {
  return locateResultSchema(sessionPath) !== null;
}

// ── Effect evidence ────────────────────────────────────────────────────────

/**
 * The phrase a terminal completion without effect evidence is flagged with,
 * in the close-worker result and in check-worker's verdict output. One
 * declared source: the renderers and the tests read it from here, so the
 * phrase cannot drift between the two surfaces.
 */
export const WORKER_EFFECT_EVIDENCE_FLAG = "no effect evidence";

/**
 * The three kinds of effect evidence a terminal completion is judged by. A
 * completion that produced none of them — no deliverable written during the
 * run, no commit landed, no gate reproduced — is the claims-without-artifacts
 * class the flag names.
 */
export interface WorkerEffectEvidence {
  /** The deliverable exists and its mtime is not before the worker spawned. */
  outputWritten: boolean;
  /** The worker's branch is ahead of its base, or a merge sha is recorded. */
  branchAdvanced: boolean;
  /** At least one recorded gate exited 0. */
  gatePassed: boolean;
  /** True when none of the three kinds holds. */
  none: boolean;
}

/** The facts effect evidence needs that the registry row alone cannot supply. */
export interface WorkerEffectFacts {
  /** The output file's mtime in ms, or null when it does not exist. */
  outputMtimeMs: number | null;
  /** Commits on the worker's branch beyond its base, or null when uncountable. */
  branchAhead: number | null;
}

/**
 * Judge a terminal completion's effect evidence. Pure over the entry and the
 * gathered facts: the deliverable was written during the run (mtime not
 * before spawnedAt), the branch advanced (ahead >= 1) or a merge sha stands
 * in for it, or a recorded gate exited 0. Any one kind is evidence; none is
 * the flag.
 */
export function workerEffectEvidence(
  entry: Pick<WorkerEntry, "spawnedAt" | "mergeSha" | "gates">,
  facts: WorkerEffectFacts,
): WorkerEffectEvidence {
  const spawnedAt = Date.parse(entry.spawnedAt);
  const outputWritten =
    facts.outputMtimeMs !== null && Number.isFinite(spawnedAt)
      ? facts.outputMtimeMs >= spawnedAt
      : false;
  const branchAdvanced =
    (typeof facts.branchAhead === "number" && facts.branchAhead >= 1) || Boolean(entry.mergeSha);
  const gatePassed = Array.isArray(entry.gates)
    ? entry.gates.some(
        (gate) =>
          gate !== null &&
          typeof gate === "object" &&
          typeof gate.exit === "number" &&
          Number.isFinite(gate.exit) &&
          gate.exit === 0,
      )
    : false;
  return {
    outputWritten,
    branchAdvanced,
    gatePassed,
    none: !outputWritten && !branchAdvanced && !gatePassed,
  };
}

/**
 * Gather the facts effect evidence needs and judge the entry: one stat for
 * the deliverable's mtime, one git rev-list for the branch count. The branch
 * is the entry's own — the worker's lock rows are released before a close is
 * judged, and a merge sha stands in for an advanced branch once the work
 * landed.
 */
export function workerEffectEvidenceForEntry(
  entry: WorkerEntry,
  opts: { cwd?: string } = {},
): WorkerEffectEvidence {
  return workerEffectEvidence(entry, {
    outputMtimeMs: fileMtimeMs(entry.outputFile),
    branchAhead: countBranchAhead(entry.branch, opts.cwd),
  });
}

// ── Verdict computation ────────────────────────────────────────────────────

function fileAgeSec(file: string | null, now: number): number | null {
  if (!file) return null;
  try {
    return Math.max(0, Math.round((now - statSync(file).mtimeMs) / 1000));
  } catch {
    return null;
  }
}

/** The file's mtime in ms, or null when it does not exist. */
function fileMtimeMs(file: string | null): number | null {
  if (!file) return null;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function countBranchAhead(branch: string | null, cwd?: string): number | null {
  if (!branch || !cwd) return null;
  try {
    const out = execFileSync("git", ["rev-list", "--count", `HEAD..${branch}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const count = Number.parseInt(out.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

function summarizeGates(gates: WorkerGate[]): string {
  if (!gates || gates.length === 0) return "no gates recorded";
  const failed = gates.filter((gate) => gate.exit !== 0);
  if (failed.length === 0) return `${gates.length}/${gates.length} passed`;
  return `${gates.length - failed.length}/${gates.length} passed; failing: ${failed
    .map((gate) => gate.cmd)
    .join(", ")}`;
}

function normalizeLiveStatus(raw?: string): "working" | "blocked" | "done" | "idle" | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === "working" || value === "blocked" || value === "done" || value === "idle") {
    return value;
  }
  return null;
}

/**
 * Compute the verdict for a worker entry. `completed` requires the output
 * file to exist and the result schema to parse (impl spec also requires at
 * least one commit on the worker branch); a live "done"/"idle" status with
 * missing evidence is encoded as `false-done`, never `completed`.
 *
 * The branch-ahead count uses `entry.branch`, falling back to the branch on
 * this worker's lock rows (`opts.fallbackBranch`) when the entry has none, so
 * an entry with a stale null branch does not hide a branch that carries the
 * worker's commit.
 *
 * Liveness, when the parent passes no live state, comes from the recorded
 * session file's mtime: written within the stall window reads as `working`,
 * frozen without an output reads as `stalled`, and no recorded session leaves
 * an admitted row as `admitted`. The pane is never read as liveness.
 *
 * A checkpoint changes only the two verdicts that would otherwise leave the
 * parent guessing: a frozen session, or no session evidence at all, reads as
 * `resumable` — never as a stale `working` — and the verdict carries the
 * phase, the last completed step, and the request id to resume under. A
 * recorded stall or false-done mark and a live status the parent passed stay
 * as they are: those are decisions and direct observations, not inferences a
 * checkpoint may override. Evidence of completion still wins over the resume
 * point.
 *
 * A row closed as `completed` also carries its effect evidence: whether the
 * deliverable was written during the run (mtime not before spawnedAt),
 * whether the branch advanced or a merge sha is recorded, and whether any
 * recorded gate exited 0. None of the three is the no-effect-evidence flag;
 * the flag is a field on the verdict, never a different status, and a row
 * that is not a terminal completion carries null.
 */
export function evaluateWorker(
  entry: WorkerEntry,
  opts: WorkerCheckOptions = {},
): WorkerCheckResult {
  const now = opts.now ?? Date.now();
  const stalledAfterSec = opts.stalledAfterSec ?? DEFAULT_STALLED_AFTER_SEC;

  const outputExists =
    typeof entry.outputFile === "string" &&
    entry.outputFile.length > 0 &&
    existsSync(entry.outputFile);
  const outputAgeSec = outputExists ? fileAgeSec(entry.outputFile, now) : null;
  const sessionGrowthAgeSec = fileAgeSec(entry.workerSession, now);
  const locatedResult = locateResultSchema(entry.workerSession);
  const schemaValid = locatedResult !== null;
  const resultSchemaMessageOffset = locatedResult?.messageOffset ?? null;
  const effectiveBranch = entry.branch ?? opts.fallbackBranch ?? null;
  const branchAhead = countBranchAhead(effectiveBranch, opts.cwd);
  const gateSummary = summarizeGates(entry.gates);
  const effectEvidence =
    entry.closedAt && entry.status === "completed"
      ? workerEffectEvidence(entry, {
          outputMtimeMs: fileMtimeMs(entry.outputFile),
          branchAhead,
        })
      : null;
  // The stall window is read once: a session written inside it is liveness a
  // checkpoint must not outrank, and it is the only case where a checkpoint
  // changes the verdict.
  const frozen = sessionGrowthAgeSec !== null && sessionGrowthAgeSec > stalledAfterSec;
  const requestId = entry.requestId ?? null;
  const checkpoint = entry.checkpoint ?? null;

  const base = {
    workerId: entry.workerId,
    outputFile: entry.outputFile,
    outputExists,
    outputAgeSec,
    sessionGrowthAgeSec,
    branchAhead,
    schemaValid,
    resultSchemaMessageOffset,
    requestId,
    checkpoint,
    gateSummary,
    effectEvidence,
  };

  const blockers: string[] = [];
  if (!outputExists) blockers.push("output file missing");
  if (!schemaValid) blockers.push("result schema missing");
  if (entry.spec === "impl" && !(typeof branchAhead === "number" && branchAhead > 0)) {
    blockers.push("no commit on worker branch");
  }
  const commitNote = entry.spec === "impl" ? " + commit present" : "";

  if (entry.closedAt) {
    return {
      ...base,
      status: "closed",
      reason: `closed ${entry.closedAt} with outcome ${entry.status}`,
    };
  }
  if (entry.status === "error") {
    return { ...base, status: "error", reason: "registry marked error" };
  }

  const live = normalizeLiveStatus(opts.liveStatus);
  if (live === "working") {
    return { ...base, status: "working", reason: "live status working" };
  }
  if (live === "blocked") {
    return { ...base, status: "stalled", reason: "live status blocked" };
  }
  if (live === "done" || live === "idle") {
    if (blockers.length === 0) {
      return {
        ...base,
        status: "completed",
        reason: `live status ${live}; output + schema verified${commitNote}`,
      };
    }
    return {
      ...base,
      status: "false-done",
      reason: `live status ${live} but ${blockers.join("; ")}`,
    };
  }

  // No usable live status: evidence wins over registry declarations.
  if (blockers.length === 0) {
    return { ...base, status: "completed", reason: `output + schema verified${commitNote}` };
  }
  if (entry.status === "stalled") {
    return {
      ...base,
      status: "stalled",
      reason: `registry marked stalled; ${blockers.join("; ")}`,
    };
  }
  if (entry.status === "false-done") {
    return {
      ...base,
      status: "false-done",
      reason: `registry marked false-done; ${blockers.join("; ")}`,
    };
  }
  if (entry.status === "merged") {
    // The work landed, so the row is not "in flight": an unclosed merged row
    // reports what is still missing from its record instead.
    return {
      ...base,
      status: "merged",
      reason: `merged at ${entry.mergedAt ?? "unknown"} but ${blockers.join("; ")}`,
    };
  }
  // A frozen session is where a crash leaves a row. With a checkpoint on disk
  // the resume point survives the crash, so the row reads as resumable rather
  // than stalled: where the work stopped is on record, not guessed.
  if (frozen) {
    if (checkpoint) {
      return {
        ...base,
        status: "resumable",
        reason:
          `no live status; session frozen for ${sessionGrowthAgeSec}s` +
          `${outputExists ? "" : " with no output"}; resume from checkpoint ` +
          `${checkpoint.phase}/${checkpoint.step} (${checkpoint.at})` +
          `${requestId ? ` under requestId ${requestId}` : ""}`,
      };
    }
    if (!outputExists) {
      return {
        ...base,
        status: "stalled",
        reason: `worker session frozen for ${sessionGrowthAgeSec}s with no output`,
      };
    }
  }
  // A recorded session file that is still being written is the one liveness
  // signal the registry owns: the parent does not have to hand a live state to
  // check-worker before an admitted row reads as more than "not yet observed".
  // The pane is deliberately not consulted: it is a place to look, not proof
  // that a process runs there, and the tool never queries herdr itself.
  if (sessionGrowthAgeSec !== null) {
    return {
      ...base,
      status: "working",
      reason: `session file active ${sessionGrowthAgeSec}s ago${entry.pane ? ` (pane ${entry.pane})` : ""}`,
    };
  }
  // No session handle, or the recorded one is gone: there is no liveness
  // evidence at all. A checkpoint still says where the work stopped, so the
  // row reads as resumable; without one it is only "not yet observed".
  if (checkpoint) {
    return {
      ...base,
      status: "resumable",
      reason:
        `no live status and ${
          entry.workerSession
            ? `recorded session ${entry.workerSession} is gone`
            : "no session handle recorded (register-worker/update-worker `workerSession`)"
        }; resume from checkpoint ${checkpoint.phase}/${checkpoint.step} (${checkpoint.at})` +
        `${requestId ? ` under requestId ${requestId}` : ""}`,
    };
  }
  if (entry.status === "admitted") {
    return {
      ...base,
      status: "admitted",
      reason:
        "no live status and no session handle recorded (register-worker/update-worker `workerSession`); not yet observed running",
    };
  }
  return { ...base, status: "working", reason: "no live status; in flight" };
}

/**
 * The branch recorded on this worker's lock rows in the given project, or
 * undefined. Used as the branch fallback when the registry entry has none:
 * every lock row carries the branch `acquireLock` was given.
 */
function lockBranchFor(workerId: string, projectCwd: string): string | undefined {
  for (const lock of Object.values(getAllLocks(projectCwd))) {
    if (lock.workerId === workerId) return lock.branch;
  }
  return undefined;
}

/**
 * Read the registry and compute the verdict; null when the worker is unknown.
 * Resolves the branch fallback from the lock table at the entry's own project
 * key, so a worker located across registries still reads its own locks.
 */
export function checkWorker(
  workerId: string,
  opts: WorkerCheckOptions = {},
): WorkerCheckResult | null {
  const located = locateWorker(workerId, opts.cwd);
  if (!located) return null;
  const fallbackBranch = opts.fallbackBranch ?? lockBranchFor(workerId, located.key);
  return evaluateWorker(located.registry.workers[workerId], { ...opts, fallbackBranch });
}

// ── Fleet statistics ───────────────────────────────────────────────────────

/** Spawn→result latency over the entries that recorded a result time. */
export interface WorkerLatencySummary {
  /** How many entries contributed a delta; the sample the median is over. */
  sample: number;
  /** Median delta in milliseconds, or null when the sample is empty. */
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/** A registry's fleet numbers: what a seat needs to judge its own health. */
export interface WorkerStats {
  /** Every row in the registry. */
  total: number;
  /** Rows with no close time — still in flight, or never closed. */
  live: number;
  /** Rows with a close time; the denominator of the completion rate. */
  closed: number;
  /** Closed rows whose terminal status is `completed`. */
  completed: number;
  /** completed / closed, or null when nothing is closed — no rate to state. */
  completionRate: number | null;
  /** Spawn→result latency; the sample is stated, never implied by a number. */
  latency: WorkerLatencySummary;
  /** Duplicate admissions refused across all rows, summed from their records. */
  admissionRefusals: number;
}

/** Median of a non-empty list; the mean of the middle pair on an even count. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * The spawn→result delta an entry recorded, or null when it has none. A row
 * with no result time — a worker still in flight, or one that closed without a
 * result — contributes nothing: it must not enter the median. A malformed or
 * backwards pair is no delta either.
 */
function resultLatencyMs(entry: WorkerEntry): number | null {
  if (!entry.spawnedAt || !entry.resultAt) return null;
  const spawned = Date.parse(entry.spawnedAt);
  const result = Date.parse(entry.resultAt);
  if (!Number.isFinite(spawned) || !Number.isFinite(result)) return null;
  const delta = result - spawned;
  return delta >= 0 ? delta : null;
}

/**
 * Compute a registry's fleet statistics. Pure over the registry value: no
 * clock, no disk, no verdicts. The latency sample is the entries that recorded
 * a result time, so an in-flight row is excluded rather than counted at its
 * close; the completion rate is over closed rows. Every number states its own
 * denominator, so a small sample reads as small.
 */
export function computeWorkerStats(registry: WorkerRegistry): WorkerStats {
  const entries = Object.values(registry.workers);
  const closed = entries.filter((entry) => Boolean(entry.closedAt));
  const completed = closed.filter((entry) => entry.status === "completed").length;
  const latencies: number[] = [];
  let admissionRefusals = 0;
  for (const entry of entries) {
    const delta = resultLatencyMs(entry);
    if (delta !== null) latencies.push(delta);
    if (Array.isArray(entry.admissionRefusals)) admissionRefusals += entry.admissionRefusals.length;
  }
  return {
    total: entries.length,
    live: entries.length - closed.length,
    closed: closed.length,
    completed,
    completionRate: closed.length === 0 ? null : completed / closed.length,
    latency: {
      sample: latencies.length,
      medianMs: median(latencies),
      minMs: latencies.length === 0 ? null : Math.min(...latencies),
      maxMs: latencies.length === 0 ? null : Math.max(...latencies),
    },
    admissionRefusals,
  };
}
