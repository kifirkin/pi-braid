/**
 * Orchestrator library — multi-agent coordination utilities.
 *
 * Provides file-lock registry, branch management, conflict detection,
 * and merge verification for orchestrating parallel agent workers.
 */

export { acquireLock, releaseLock, getConflicts, getAllLocks } from "./locks.js";

export type { LockEntry, LockRegistry, Conflict } from "./locks.js";

export {
  createWorkerBranch,
  deleteWorkerBranch,
  getDiff,
  branchExists,
  getCurrentBranch,
  findRepoRoot,
  gitAvailable,
  worktreeForBranch,
} from "./branch.js";

export { scanAddedLinesForSlop } from "./slop-scanner.js";

export type { SlopHit } from "./slop-scanner.js";

export {
  WORKER_REGISTRY_VERSION,
  WORKER_SPECS,
  WORKER_STATUSES,
  WORKER_OUTCOMES,
  WORKER_VERDICT_STATUSES,
  WORKER_STATUS_LAYERS,
  RESULT_SCHEMA_STATUSES,
  parseWorkerStatus,
  parseWorkerOutcome,
  readWorkers,
  writeWorkers,
  deriveRequestId,
  resolveRequestId,
  decideAdmission,
  recordAdmissionRefusal,
  registerWorker,
  updateWorker,
  closeWorker,
  recordWorkerMerge,
  validateResultSchema,
  locateResultSchema,
  evaluateWorker,
  checkWorker,
  computeWorkerStats,
  WORKER_EFFECT_EVIDENCE_FLAG,
  workerEffectEvidence,
  workerEffectEvidenceForEntry,
  firstCommandToken,
  findTopLevelDecoration,
  findGateRowViolation,
  closeGateRefusalLogPath,
  logCloseGateRefusal,
  parsePopulationStamp,
  readPopulationStamps,
  populationRefusalDetail,
} from "./workers.js";

export type {
  WorkerStatus,
  WorkerVerdictStatus,
  WorkerOutcome,
  WorkerStatusLayer,
  WorkerStatusLayerRole,
  WorkerGate,
  WorkerCheckpoint,
  WorkerCheckpointInput,
  WorkerAdmissionDecision,
  WorkerAdmissionRefusal,
  WorkerEntry,
  WorkerRegistry,
  RegisterWorkerInput,
  RegisterWorkerResult,
  UpdateWorkerPatch,
  WorkerCheckOptions,
  WorkerCheckResult,
  WorkerEffectEvidence,
  WorkerEffectFacts,
  WorkerStats,
  WorkerLatencySummary,
  GateRowPredicate,
  GateRowViolation,
  CloseGateRefusalRecord,
  ResultSchemaLocation,
  PopulationStamp,
  PopulationVerdict,
  PopulationRowRead,
  PopulationRead,
  PopulationCensus,
} from "./workers.js";
