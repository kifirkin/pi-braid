/**
 * Orchestrator extension — multi-agent coordination.
 *
 * Registers the `orchestrate` tool for managing parallel agent workers.
 * Supports branch-per-worker, a per-project worker registry (admission,
 * lifecycle, structured result-location verdicts), file-lock awareness,
 * conflict detection, and merge verification.
 *
 * Git operations auto-detect the repo root from the `files` parameter,
 * so orchestrate works from ANY cwd (including ~/.pi/agent). Falls back
 * to lock-only coordination when no git repo is found.
 *
 * Workers can be spawned via herdr (recommended) or manual instructions.
 *
 * This is the implementation counterpart to skills/orchestrator/SKILL.md.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";
import {
  acquireLock,
  releaseLock,
  getConflicts,
  getAllLocks,
  createWorkerBranch,
  deleteWorkerBranch,
  getDiff,
  getCurrentBranch,
  findRepoRoot,
  branchExists,
  gitAvailable,
  worktreeForBranch,
  scanAddedLinesForSlop,
  registerWorker,
  updateWorker,
  closeWorker,
  recordWorkerMerge,
  readWorkers,
  checkWorker,
  parseWorkerStatus,
  parseWorkerOutcome,
  decideAdmission,
  recordAdmissionRefusal,
  resolveRequestId,
  computeWorkerStats,
  workerEffectEvidenceForEntry,
  WORKER_EFFECT_EVIDENCE_FLAG,
  WORKER_SPECS,
  WORKER_OUTCOMES,
  WORKER_STATUSES,
  WORKER_STATUS_LAYERS,
  type Conflict,
  type SlopHit,
  type UpdateWorkerPatch,
  type WorkerCheckResult,
  type WorkerEffectEvidence,
  type WorkerEntry,
  type WorkerStats,
} from "../../lib/orchestrator/index.js";

const log = createLogger("orchestrator");

// Helpers

/**
 * Resolve the repo root: explicit `cwd` param wins, otherwise auto-detect
 * from file paths. Returns undefined if no git repo is found.
 */
function resolveCwd(cwd?: string, files?: string[]): string | undefined {
  if (cwd) return cwd;
  if (files && files.length > 0) return findRepoRoot(files);
  return undefined;
}

/**
 * The files in `files` currently held by a worker other than `workerId`.
 * The read-only half of lock booking: a caller uses it to refuse before it
 * mutates anything (spawn-worker checks before it creates a branch).
 */
function filesHeldByOthers(
  files: string[] | undefined,
  workerId: string,
  cwd: string | undefined,
): Conflict[] {
  if (!files || files.length === 0) return [];
  return getConflicts(files, cwd).filter((c) => c.lockedBy !== workerId);
}

/**
 * Write the worker's lock rows for its declared files — the one seat where
 * spawn-worker, register-worker and update-worker turn files into locks, so
 * the three cannot drift on which files a worker holds. A file another worker
 * holds blocks the whole booking and nothing is written; a row the same worker
 * already holds is refreshed with the current branch. `files` absent or empty
 * is a no-op. Returns the blocking rows (empty on success).
 */
function bookWorkerLocks(
  workerId: string,
  files: string[] | undefined,
  branch: string,
  cwd: string | undefined,
): Conflict[] {
  if (!files || files.length === 0) return [];
  const blockers = filesHeldByOthers(files, workerId, cwd);
  if (blockers.length > 0) return blockers;
  if (!acquireLock(files, workerId, branch, cwd)) {
    return filesHeldByOthers(files, workerId, cwd);
  }
  return [];
}

/** Render lock conflicts as the indented block the CONFLICT refusals print. */
function conflictLines(conflicts: Conflict[]): string {
  return conflicts.map((c) => `  ${c.file} — locked by ${c.lockedBy} (${c.branch})`).join("\n");
}

/**
 * Git plumbing for the merge path. verify-and-merge must be able to read and
 * advance a ref without checking it out: the shared worktree is usually parked
 * on a worker branch and other agents read it, so switching branches is not
 * ours to do. These helpers return undefined/no on any git failure rather than
 * throwing, so a merge refusal is always reported, never a crash.
 */
function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Resolve a ref to its commit SHA, or undefined when the ref does not exist. */
function revParse(ref: string, repoRoot: string): string | undefined {
  return git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** True when `ancestor` is reachable from `descendant`. */
function isAncestor(ancestor: string, descendant: string, repoRoot: string): boolean {
  return git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;
}

/** Reject a ref git could read as an option, or that carries shell metacharacters. */
function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
}

/**
 * What a merge attempt produced: the report to print, plus the base tip when
 * this call actually advanced the base. The two travel together so the audit
 * mark can never be written for a merge that did not happen.
 */
interface MergeOutcome {
  report: string;
  /** The base ref's commit after a merge this call performed; null otherwise. */
  mergeSha: string | null;
  /** Branch the caller's worktree is on after the attempt; "unknown" without git. */
  worktreeBranch: string;
}

/**
 * Resolve the merge base explicitly, then merge the worker branch into it and
 * assert the base actually moved. Never infers the base from HEAD; never leaves
 * the worktree on a different branch; never claims a merge it did not perform.
 */
function verifyAndMergeBase(
  workerId: string,
  workerBranch: string,
  base: string,
  repoRoot: string | undefined,
): MergeOutcome {
  /** A refusal or no-op: nothing was merged, so nothing may be marked merged. */
  const nothingMerged = (report: string): MergeOutcome => ({
    report,
    mergeSha: null,
    worktreeBranch: getCurrentBranch(repoRoot),
  });

  if (!repoRoot || !gitAvailable(repoRoot)) {
    return nothingMerged(
      `Cannot verify ${workerBranch}: no git repository resolved (pass cwd). No merge performed.`,
    );
  }
  if (!isSafeRef(base) || !isSafeRef(workerBranch)) {
    return nothingMerged(
      `Refusing to merge: unsafe ref name (base="${base}", branch="${workerBranch}").`,
    );
  }
  if (!branchExists(workerBranch, repoRoot)) {
    return nothingMerged(
      `Cannot verify ${workerBranch}: branch does not exist. No merge performed.`,
    );
  }

  const baseBefore = revParse(base, repoRoot);
  if (!baseBefore) {
    return nothingMerged(`Cannot merge into "${base}": base branch not found. No merge performed.`);
  }
  const tip = revParse(workerBranch, repoRoot);
  if (!tip) {
    return nothingMerged(
      `Cannot verify ${workerBranch}: branch has no commit. No merge performed.`,
    );
  }

  const short = (sha: string) => sha.slice(0, 12);
  const diff = getDiff(workerBranch, base, repoRoot);
  const scan = surfaceScanReport(diff);

  const finish = (
    lead: string,
    deletedLead: string,
    mergeSha: string | null,
    extraWorktreeNote = "",
  ): MergeOutcome => {
    // Where the caller's tree sits is part of the merge result, not a detail:
    // this tool never switches the shared worktree's branch, so after a merge
    // made from a tree parked on the worker branch, the next commit lands on
    // that branch, not on the base. Say so on a line of its own.
    const head = getCurrentBranch(repoRoot);
    const onWorkerBranch = head === workerBranch;
    const worktreeNote =
      head === base
        ? `\nWorktree: on ${base} (the merge target).`
        : `\nWorktree: ${repoRoot} stays on ${head}, not ${base} (this tool never switches branches), so a commit made there now lands on ${head}. Switch it first: git -C ${repoRoot} checkout ${base}`;
    const settleBlock = extraWorktreeNote ? `\n${extraWorktreeNote}` : "";

    releaseLock(workerId, repoRoot);
    deleteWorkerBranch(workerBranch, repoRoot);
    const deleted = !branchExists(workerBranch, repoRoot);
    // The third thing a finished merge does, beside releasing locks and
    // dropping the branch: mark the worker's audit row. It rides on the line
    // below the merge claim so a reader cannot take the claim without seeing
    // what the registry now says.
    const audit = mergeAuditNote(workerId, mergeSha, repoRoot);
    return {
      report: `${lead}${audit}\nBranch: ${workerBranch} (${
        deleted ? "deleted" : onWorkerBranch ? "kept: this worktree is on it" : deletedLead
      })${worktreeNote}${settleBlock}\nDiff summary:\n${diff.slice(0, 2000)}\n${scan}`,
      mergeSha,
      worktreeBranch: head,
    };
  };

  // The base already holds the worker's work: nothing to merge, and saying
  // "merged" here would be a false success.
  if (isAncestor(tip, base, repoRoot)) {
    return finish(
      `Worker ${workerId} already contained in ${base}: ${short(tip)} is an ancestor of ${base} (${short(baseBefore)}). Nothing merged.`,
      "kept: still checked out",
      null,
    );
  }

  // Set when the fast-forward happened in a worktree other than the caller's;
  // the report names where the base's tree moved, so a reader can act on it.
  let settleNote = "";
  const current = getCurrentBranch(repoRoot);

  if (current === base) {
    // The base is the checked-out branch, so merging in place is the only
    // result that keeps index and worktree coherent. Refuse when the worktree
    // carries uncommitted changes: a merge would sweep another worker's edits
    // into the commit.
    const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty === undefined || dirty.length > 0) {
      return nothingMerged(
        `NOT merged: worktree on ${base} has uncommitted changes; refusing to merge over them. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
      );
    }
    if (git(repoRoot, ["merge", "--no-edit", workerBranch]) === undefined) {
      return nothingMerged(
        `NOT merged: git merge ${workerBranch} into ${base} failed (conflict or refusal). Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
      );
    }
  } else {
    // The base is not checked out in the caller's worktree. It may still be
    // checked out in another one (the primary checkout holding main while the
    // seat's cwd is a worker worktree is the normal flow). Advancing the ref
    // with plumbing there moves HEAD to the merge commit while leaving that
    // worktree's index and files on the old tip: `git status` reads as a staged
    // inverse of the merge and the merged files are absent from its tree. Merge
    // in the worktree that holds the base so ref and tree move together.
    if (!isAncestor(base, workerBranch, repoRoot)) {
      return nothingMerged(
        `NOT merged: ${base} and ${workerBranch} have diverged, and the caller's worktree is on ${current}. Refusing to change a worktree's checkout to resolve it. Merge ${base} manually. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
      );
    }
    const holder = worktreeForBranch(base, repoRoot);
    if (holder) {
      // The holder is a different worktree: `current === base` was handled
      // above. Refuse over uncommitted changes there, since a merge would fold
      // another seat's edits into the ref move.
      const dirty = git(holder, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty === undefined || dirty.length > 0) {
        return nothingMerged(
          `NOT merged: worktree ${holder} holds ${base} with uncommitted changes; refusing to merge over them. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
        );
      }
      if (git(holder, ["merge", "--ff-only", workerBranch]) === undefined) {
        return nothingMerged(
          `NOT merged: fast-forward of ${base} in ${holder} to ${short(tip)} failed. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
        );
      }
      settleNote = `The base worktree ${holder} was fast-forwarded in place, so its ref and files moved together.`;
    } else if (git(repoRoot, ["update-ref", `refs/heads/${base}`, tip]) === undefined) {
      // No worktree has the base, so the ref is the only place the merge lives:
      // advancing it alone leaves no tree inconsistent.
      return nothingMerged(
        `NOT merged: fast-forward of ${base} to ${short(tip)} failed. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
      );
    }
  }

  // Verify before reporting: the base ref must actually hold the worker's work.
  const baseAfter = revParse(base, repoRoot);
  if (!baseAfter || baseAfter === baseBefore) {
    return nothingMerged(
      `NOT merged: ${base} did not move (still ${short(
        baseBefore,
      )}) after the merge attempt. No merge is claimed. Locks and branch kept.`,
    );
  }

  return finish(
    `Worker ${workerId} merged into ${base} at ${short(baseAfter)} (was ${short(baseBefore)}).`,
    "kept: branch is checked out in a worktree",
    baseAfter,
    settleNote,
  );
}

/**
 * The audit-row half of a merge report, on the line below the merge claim. A
 * merge that moved the base must leave the worker's registry row present and
 * marked with the sha it landed on, so `close-worker` still finds the row and a
 * later reader can see what became of the worker. A merge that finds no row
 * says so here, at merge time, instead of surfacing as an inexplicable "No
 * registry entry" at close time. Empty when no merge happened: a refusal
 * changes no audit state.
 */
function mergeAuditNote(
  workerId: string,
  mergeSha: string | null,
  cwd: string | undefined,
): string {
  if (!mergeSha) return "";
  const stamped = recordWorkerMerge(workerId, { mergeSha, cwd });
  if (!stamped) {
    return `\nAudit row: NO registry entry for ${workerId}; the merge is recorded in git only. Register the row if this worker needs closing.`;
  }
  return `\nAudit row: ${workerId} marked merged at ${mergeSha.slice(0, 12)} (status ${
    stamped.status
  }).`;
}

/**
 * Advisory surface-discipline check over the worker diff. Returns a short
 * report block: findings listed as warnings, or a note that the scan was
 * unavailable. A scanner failure must never fail the merge path — this is
 * a shadow gate until false-positive data justifies hardening it.
 */
function surfaceScanReport(diff: string): string {
  try {
    const hits: SlopHit[] = scanAddedLinesForSlop(diff);
    if (hits.length === 0) return "";
    const listed = hits
      .slice(0, 20)
      .map((h) => `  [${h.pattern}] added-line ${h.line}: ${h.excerpt}`)
      .join("\n");
    const overflow = hits.length > 20 ? `\n  … ${hits.length - 20} more` : "";
    return `Surface-discipline warning (advisory, non-blocking): ${hits.length} added-line hit(s):
${listed}${overflow}
`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Surface-discipline scan unavailable (advisory): ${reason}\n`;
  }
}

/** Uniform tool-result shape for the registry actions. */
function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** One-line registry listing for a worker entry. */
function workerLine(entry: WorkerEntry): string {
  const closed = entry.closedAt ? `  closed=${entry.closedAt}` : "";
  return `  ${entry.workerId}  spec=${entry.spec}  status=${entry.status}  pane=${
    entry.pane ?? "-"
  }  session=${entry.workerSession ?? "-"}  output=${
    entry.outputFile ?? "-"
  }  branch=${entry.branch ?? "-"}${closed}`;
}

/**
 * Render the fleet statistics as the block `list-workers` appends when stats
 * are requested. The latency line prints its sample, so a median over a
 * handful of rows cannot read as a distribution.
 */
function formatWorkerStats(stats: WorkerStats): string {
  const rate =
    stats.completionRate === null
      ? "no closed rows"
      : `${(stats.completionRate * 100).toFixed(1)}%`;
  const latency =
    stats.latency.sample === 0
      ? "no result times recorded"
      : `median=${stats.latency.medianMs}ms min=${stats.latency.minMs}ms max=${stats.latency.maxMs}ms`;
  return [
    `stats: closed=${stats.closed}/${stats.total} completed=${stats.completed} (${rate})`,
    `  spawn->result: ${latency} (sample ${stats.latency.sample})`,
    `  duplicate admissions refused: ${stats.admissionRefusals}`,
  ].join("\n");
}

/** Render the check-worker verdict as a labeled block (details carry the object). */
function formatCheckVerdict(verdict: WorkerCheckResult): string {
  const age = verdict.outputExists ? `age ${verdict.outputAgeSec}s` : "missing";
  return [
    `Worker ${verdict.workerId}`,
    `status: ${verdict.status}`,
    `reason: ${verdict.reason}`,
    `outputFile: ${verdict.outputFile ?? "-"} (${age})`,
    `sessionGrowthAgeSec: ${verdict.sessionGrowthAgeSec ?? "-"}`,
    `branchAhead: ${verdict.branchAhead ?? "-"}`,
    `schemaValid: ${verdict.schemaValid}`,
    `resultSchemaMessageOffset: ${verdict.resultSchemaMessageOffset ?? "-"}`,
    `requestId: ${verdict.requestId ?? "-"}`,
    `checkpoint: ${
      verdict.checkpoint
        ? `${verdict.checkpoint.phase}/${verdict.checkpoint.step} (${verdict.checkpoint.at})`
        : "-"
    }`,
    `gateSummary: ${verdict.gateSummary}`,
    `effectEvidence: ${formatEffectEvidence(verdict.effectEvidence)}`,
  ].join("\n");
}

/**
 * Render the effect-evidence field of a verdict: the three kinds as flags,
 * or the declared flag phrase when none holds. Null (not a terminal
 * completion) reads like the other absent fields.
 */
function formatEffectEvidence(evidence: WorkerEffectEvidence | null): string {
  if (!evidence) return "-";
  const parts = [
    `output=${evidence.outputWritten}`,
    `branch=${evidence.branchAdvanced}`,
    `gate=${evidence.gatePassed}`,
  ];
  return evidence.none ? `${WORKER_EFFECT_EVIDENCE_FLAG} (${parts.join(" ")})` : parts.join(" ");
}

/** The gaps a no-effect-evidence flag names, as the close report prints them. */
function effectEvidenceGaps(evidence: WorkerEffectEvidence): string {
  const gaps: string[] = [];
  if (!evidence.outputWritten) gaps.push("no output file written during the run");
  if (!evidence.branchAdvanced) gaps.push("no branch advance or recorded merge");
  if (!evidence.gatePassed) gaps.push("no passing gate");
  return gaps.join(", ");
}

/**
 * What a reused admission reports: the live entry's own facts, so the caller
 * resumes the worker that already exists instead of the one it thought it was
 * creating. Reuse is read-only — no branch, no lock, no second row.
 */
function reuseReport(entry: WorkerEntry, requestId: string): string {
  const checkpoint = entry.checkpoint
    ? `${entry.checkpoint.phase}/${entry.checkpoint.step} (${entry.checkpoint.at})`
    : "none recorded";
  return `Worker ${entry.workerId} is already admitted under requestId ${requestId} (status ${entry.status}); reusing that entry, no duplicate was created.
Branch: ${entry.branch ?? "-"} (existing)
Files locked: ${entry.files.length > 0 ? entry.files.join(", ") : "-"}
Spec: ${entry.spec}
Output: ${entry.outputFile ?? "-"}
Checkpoint: ${checkpoint}

Resume the worker from its checkpoint, or close it (orchestrate action=close-worker) to admit a fresh attempt.`;
}

// Tool Definition

/**
 * The four lifecycle vocabularies as one clause, rendered from
 * WORKER_STATUS_LAYERS so the tool schema never restates a vocabulary value.
 */
function renderStatusLayers(): string {
  return WORKER_STATUS_LAYERS.map(
    (layer) => `${layer.role} (${layer.values.join("|")}), ${layer.states}`,
  ).join("; ");
}

const orchestrateTool: ToolDefinition<any, any, any> = {
  name: "orchestrate",
  label: "Orchestrate",
  promptSnippet: "Coordinate parallel agent workers (spawn/check/merge, locks)",
  description:
    "Coordinate parallel agent workers to prevent edit conflicts. Auto-detects the repo root (cwd overrides); without git, lock-only. verify-and-merge requires workerId, merges into an explicit base branch (default main), and claims success only when that base ref actually advanced. It never switches a worktree's branch: the caller's tree is left on the branch it was on, named in the report, and a branch is dropped only when it is actually gone. " +
    `Worker lifecycle speaks in four vocabularies: ${renderStatusLayers()}.`,
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("spawn-worker"),
        Type.Literal("register-worker"),
        Type.Literal("update-worker"),
        Type.Literal("check-worker"),
        Type.Literal("list-workers"),
        Type.Literal("close-worker"),
        Type.Literal("verify-and-merge"),
        Type.Literal("release-locks"),
        Type.Literal("list-locks"),
        Type.Literal("check-conflicts"),
      ],
      { description: "The orchestration action to perform" },
    ),
    workerId: Type.Optional(
      Type.String({
        description:
          "Unique worker identifier (e.g. w1). Required by spawn-worker, register-worker, update-worker, check-worker, close-worker, and verify-and-merge.",
      }),
    ),
    slug: Type.Optional(
      Type.String({ description: "Kebab-case task description. Required for spawn-worker." }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "File paths the worker will modify. Required for spawn-worker and check-conflicts; register/update-worker book them as lock rows.",
      }),
    ),
    branch: Type.Optional(
      Type.String({
        description:
          "Branch name. register/update-worker record it; verify-and-merge resolves it from this argument, the worker's entry, or its lock rows.",
      }),
    ),
    requestId: Type.Optional(
      Type.String({
        description:
          "spawn-worker/register-worker: exactly-once request id for this submission, defaulting to `<workerId>:1` (the workerId plus submission-step key). A retried admission of the same work reuses the entry that request admitted instead of admitting a duplicate.",
      }),
    ),
    baseBranch: Type.Optional(
      Type.String({
        description:
          "verify-and-merge: the branch the worker's work is merged into (default: main).",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Git repo root (auto-detected from files if omitted)." }),
    ),
    spec: Type.Optional(
      Type.String({
        description: `Worker spec (${WORKER_SPECS.join("|")}). Required for spawn-worker and register-worker.`,
      }),
    ),
    outputFile: Type.Optional(
      Type.String({
        description:
          "Deliverable path the worker must produce. Required for spawn-worker; also register/update-worker.",
      }),
    ),
    pane: Type.Optional(
      Type.String({
        description:
          "Worker pane ID (register-worker/update-worker). Recorded as a handle only: check-worker does not read it as liveness.",
      }),
    ),
    workspace: Type.Optional(Type.String({ description: "Worker workspace ID (update-worker)." })),
    workerSession: Type.Optional(
      Type.String({
        description:
          "Worker session .jsonl path (register-worker/update-worker). check-worker reads its mtime: a session file written within the last 600s reports status working without a live state.",
      }),
    ),
    status: Type.Optional(
      Type.String({
        description: "Lifecycle status for update-worker (see the tool description).",
      }),
    ),
    phase: Type.Optional(
      Type.String({
        description:
          "update-worker: checkpoint phase the worker is in (e.g. impl, gates). Requires lastStep; the registry stamps the time.",
      }),
    ),
    lastStep: Type.Optional(
      Type.String({
        description:
          "update-worker: last completed step within phase (e.g. commit, typecheck). Requires phase. check-worker reports this checkpoint when the worker is mid-flight with no live evidence.",
      }),
    ),
    outcome: Type.Optional(
      Type.String({
        description: `Terminal outcome for close-worker (${WORKER_OUTCOMES.join("|")}).`,
      }),
    ),
    gates: Type.Optional(
      Type.Array(Type.Object({ cmd: Type.String(), exit: Type.Number() }), {
        description:
          "Gate evidence for close-worker: command plus exit code, recorded with a timestamp. " +
          `A completed close whose entry carries none of a fresh output file, a branch advance or ` +
          `merge, and a passing gate is flagged "${WORKER_EFFECT_EVIDENCE_FLAG}" (advisory, non-blocking). ` +
          "Every row is also read for well-formedness at close time (parses under sh -n, first token " +
          "resolves, no top-level decoration, exit 0 under a completed outcome); the read ships in " +
          "shadow mode, so a failing row is logged and the close proceeds, until " +
          'braid.orchestrator.closeGateWellFormedness is set to "enforce".',
      }),
    ),
    includeClosed: Type.Optional(
      Type.Boolean({ description: "list-workers: include closed entries (default false)." }),
    ),
    includeStats: Type.Optional(
      Type.Boolean({
        description:
          "list-workers: append fleet statistics (spawn->result latency, completion rate, duplicate admissions refused) after the listing (default false). The latency line prints its own sample size.",
      }),
    ),
    liveStatus: Type.Optional(
      Type.String({
        description:
          "check-worker: herdr lifecycle state (idle|working|blocked|done|unknown) passed by the parent; the tool never queries herdr itself.",
      }),
    ),
  }),
  execute: async (
    _id: string,
    params: {
      action: string;
      workerId?: string;
      slug?: string;
      files?: string[];
      branch?: string;
      baseBranch?: string;
      cwd?: string;
      spec?: string;
      outputFile?: string;
      pane?: string;
      workspace?: string;
      workerSession?: string;
      status?: string;
      phase?: string;
      lastStep?: string;
      requestId?: string;
      outcome?: string;
      gates?: Array<{ cmd: string; exit: number }>;
      includeClosed?: boolean;
      includeStats?: boolean;
      liveStatus?: string;
    },
    _signal: AbortSignal,
    _onUpdate: unknown,
    _ctx: unknown,
  ) => {
    const {
      action,
      workerId,
      slug,
      files,
      branch,
      baseBranch,
      cwd: explicitCwd,
      spec,
      outputFile,
      pane,
      workspace,
      workerSession,
      status,
      phase,
      lastStep,
      requestId,
      outcome,
      gates,
      includeClosed,
      includeStats,
      liveStatus,
    } = params;

    const repoRoot = resolveCwd(explicitCwd, files);

    switch (action) {
      case "spawn-worker": {
        if (!workerId || !slug || !files || files.length === 0) {
          throw new Error("spawn-worker requires workerId, slug, and files");
        }
        if (!spec || !outputFile) {
          throw new Error(
            "spawn-worker requires spec and outputFile: both are written into the worker registry " +
              "entry, and a worker with no registry entry is invisible to list-workers and check-worker.",
          );
        }

        // The registry key is the same project key the locks use, so a repo-less
        // spawn still lands beside its lock file and list-workers sees it.
        const projectCwd = repoRoot ?? process.cwd();

        // Identity before admission: a retried spawn carries the same
        // (workerId, step) request id as the submission it is retrying, so it
        // reuses the entry that submission admitted instead of adding a second
        // live row for one worker. A different request, or the same id
        // describing different work, is refused with both ids named.
        const effectiveRequestId = resolveRequestId(workerId, requestId);
        const existing = readWorkers(projectCwd).workers[workerId];
        const decision = decideAdmission(existing, effectiveRequestId, { spec, files });
        if (decision.action === "reuse" && decision.entry) {
          return textResult(reuseReport(decision.entry, effectiveRequestId), {
            entry: decision.entry,
            reused: true,
          });
        }
        if (decision.action === "refuse") {
          // Record the refusal before it is reported: the fleet's refusal count
          // is registry fact, and this pre-check is where a duplicate spawn is
          // turned away. No branch or lock exists yet, so nothing else to undo.
          recordAdmissionRefusal(workerId, effectiveRequestId, projectCwd);
          throw new Error(`spawn-worker: ${decision.reason}.`);
        }

        const conflicts = filesHeldByOthers(files, workerId, repoRoot);
        if (conflicts.length > 0) {
          return textResult(
            `CONFLICT: ${conflicts.length} file(s) already locked by other workers:\n${conflictLines(
              conflicts,
            )}\n\nResolve conflicts before spawning this worker.`,
          );
        }

        const branchName = createWorkerBranch(workerId, slug, undefined, repoRoot);

        // Re-booked after branch creation: a file grabbed between the gate
        // above and here still loses the race, and the branch goes with it.
        if (bookWorkerLocks(workerId, files, branchName, repoRoot).length > 0) {
          deleteWorkerBranch(branchName, repoRoot);
          return textResult("Failed to acquire locks (race condition). Try again.");
        }

        let registered;
        try {
          registered = registerWorker(
            {
              workerId,
              spec,
              cwd: projectCwd,
              files,
              branch: branchName,
              outputFile,
              requestId: effectiveRequestId,
            },
            projectCwd,
          );
        } catch (err) {
          releaseLock(workerId, repoRoot);
          deleteWorkerBranch(branchName, repoRoot);
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `spawn-worker: registering ${workerId} failed (${reason}). Locks released and branch ` +
              `${branchName} deleted; no half-made worker.`,
            { cause: err },
          );
        }
        if (!registered.ok) {
          releaseLock(workerId, repoRoot);
          deleteWorkerBranch(branchName, repoRoot);
          return textResult(
            `Worker ${workerId} not spawned: ${registered.reason}. Locks released and branch ` +
              `${branchName} deleted; no half-made worker.`,
          );
        }
        // The same request landed between the decision above and this write.
        // The entry that request admitted is the worker; the branch created
        // here is stray unless it is that entry's own, and reporting it as the
        // worker's branch would be a false statement about where the work is.
        if (registered.reused && registered.entry) {
          if (registered.entry.branch !== branchName) deleteWorkerBranch(branchName, repoRoot);
          return textResult(reuseReport(registered.entry, effectiveRequestId), {
            entry: registered.entry,
            reused: true,
          });
        }

        return textResult(
          `Worker ${workerId} ready and registered.
Branch: ${branchName}
Files locked: ${files.join(", ")}
Spec: ${spec}
Output: ${outputFile}

To spawn the worker:
1. Use herdr to create a new pane
2. Pass the branch name and locked files to the worker
3. The worker should: git checkout ${branchName}, make changes, commit, then signal completion

When the worker signals completion, use orchestrate action=verify-and-merge to review and merge.`,
          { entry: registered.entry },
        );
      }

      case "register-worker": {
        if (!workerId || !spec || !explicitCwd) {
          throw new Error("register-worker requires workerId, spec, and cwd");
        }

        // A live entry refuses re-registration; surface the canonical refusal
        // before booking anything so a duplicate mutates nothing.
        const live = readWorkers(explicitCwd).workers[workerId];
        if (live && !live.closedAt) {
          const result = registerWorker(
            {
              workerId,
              spec,
              cwd: explicitCwd,
              files,
              branch,
              outputFile,
              pane,
              workerSession,
              requestId,
            },
            explicitCwd,
          );
          // A reuse is reported in the result itself: `reused: true` with the
          // live entry, so a caller parsing the JSON sees that its request was
          // already admitted and no second row was written.
          return textResult(JSON.stringify(result, null, 2));
        }

        // Registering is admission, so the entry is written only once its
        // declared files are actually locked — the same booking spawn-worker
        // performs, at the same project key.
        const conflicts = bookWorkerLocks(workerId, files, branch ?? "", explicitCwd);
        if (conflicts.length > 0) {
          return textResult(
            `CONFLICT: ${conflicts.length} file(s) already locked by other workers:\n${conflictLines(
              conflicts,
            )}\n\nResolve conflicts before registering this worker.`,
          );
        }

        const result = registerWorker(
          {
            workerId,
            spec,
            cwd: explicitCwd,
            files,
            branch,
            outputFile,
            pane,
            workerSession,
            requestId,
          },
          explicitCwd,
        );

        return textResult(JSON.stringify(result, null, 2));
      }

      case "update-worker": {
        if (!workerId) {
          throw new Error("update-worker requires workerId");
        }

        const patch: UpdateWorkerPatch = {};
        if (pane !== undefined) patch.pane = pane;
        if (workspace !== undefined) patch.workspace = workspace;
        if (workerSession !== undefined) patch.workerSession = workerSession;
        if (outputFile !== undefined) patch.outputFile = outputFile;
        if (branch !== undefined) patch.branch = branch;
        if (files !== undefined) patch.files = files;
        if (status !== undefined) patch.status = parseWorkerStatus(status);
        if (phase !== undefined || lastStep !== undefined) {
          if (!phase || !lastStep) {
            throw new Error(
              "update-worker: a checkpoint needs both phase and lastStep (the last completed step within that phase).",
            );
          }
          patch.checkpoint = { phase, step: lastStep };
        }

        const updated = updateWorker(workerId, patch, repoRoot);
        if (!updated) {
          return textResult(`No registry entry for worker ${workerId}.`);
        }

        // Repair/refresh pass: an entry admitted without files has no lock rows,
        // so an update that names files books them here. Rows already held are
        // refreshed with the current branch and never dropped; a closed worker
        // is not re-locked.
        let lockNote = "";
        if (files !== undefined && !updated.closedAt) {
          const conflicts = bookWorkerLocks(workerId, files, updated.branch ?? "", repoRoot);
          if (conflicts.length > 0) {
            lockNote = `\nWARNING: locks not booked for ${conflicts.length} file(s) held by other workers:\n${conflictLines(
              conflicts,
            )}`;
          } else if (files.length > 0) {
            lockNote = `\nLocks booked: ${files.join(", ")}`;
          }
        }

        return textResult(
          `Worker ${workerId} updated.\n${JSON.stringify(updated, null, 2)}${lockNote}`,
          {
            entry: updated,
          },
        );
      }

      case "list-workers": {
        const registry = readWorkers(repoRoot);
        const all = Object.values(registry.workers);
        const shown = includeClosed ? all : all.filter((entry) => !entry.closedAt);
        // Statistics are opt-in: the ordinary listing stays byte-for-byte the
        // same, and a caller that wants fleet numbers asks for them.
        const stats = includeStats ? computeWorkerStats(registry) : null;
        const statsSuffix = stats ? `\n${formatWorkerStats(stats)}` : "";
        const details = stats ? { stats } : {};

        if (shown.length === 0) {
          return textResult(
            (all.length === 0
              ? "No workers registered."
              : `No live workers (${all.length} closed). Pass includeClosed=true to show them.`) +
              statsSuffix,
            details,
          );
        }

        const counts = new Map<string, number>();
        for (const entry of all) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
        const closedCount = all.filter((entry) => entry.closedAt).length;
        const byStatus = WORKER_STATUSES.map((s) => `${s}=${counts.get(s) ?? 0}`).join(" ");

        const lines = shown.map(workerLine).join("\n");
        return textResult(
          `Workers (${repoRoot ?? process.cwd()}):\n${lines}\ncounts: total=${all.length} live=${
            all.length - closedCount
          } closed=${closedCount} | ${byStatus}${statsSuffix}`,
          details,
        );
      }

      case "close-worker": {
        if (!workerId || !outcome) {
          throw new Error("close-worker requires workerId and outcome");
        }

        const closed = closeWorker(workerId, parseWorkerOutcome(outcome), gates, repoRoot);
        if (!closed) {
          return textResult(`No registry entry for worker ${workerId}.`);
        }

        // A terminal completion carries its effect evidence on the close
        // result: a completed close whose row shows none of the three kinds
        // is flagged in the report. The flag is advisory — the close itself
        // stands, and the parent decides what the missing evidence means.
        const effectEvidence =
          closed.closedAt && closed.status === "completed"
            ? workerEffectEvidenceForEntry(closed, { cwd: repoRoot })
            : null;
        const flagNote =
          effectEvidence && effectEvidence.none
            ? `\n${WORKER_EFFECT_EVIDENCE_FLAG}: ${effectEvidenceGaps(effectEvidence)}`
            : "";

        return textResult(
          `Worker ${workerId} closed: ${closed.status}.${flagNote}\n${JSON.stringify(closed, null, 2)}`,
          {
            entry: closed,
            effectEvidence,
          },
        );
      }

      case "check-worker": {
        if (!workerId) {
          throw new Error("check-worker requires workerId");
        }

        // The lock table is the fallback branch source for an entry whose own
        // branch is null; checkWorker reads it at the entry's own project key.
        const verdict = checkWorker(workerId, { liveStatus, cwd: repoRoot });
        if (verdict) {
          return textResult(formatCheckVerdict(verdict), { ...verdict });
        }

        const locks = getAllLocks(repoRoot);
        const workerFiles = Object.entries(locks).filter(
          ([, entry]) => entry.workerId === workerId,
        );

        if (workerFiles.length === 0) {
          return textResult(
            `No registry entry and no locks for worker ${workerId}. Register it with orchestrate action=register-worker.`,
          );
        }

        const wBranch = workerFiles[0][1].branch;
        const currentBranch = getCurrentBranch(repoRoot);

        return textResult(
          `Worker ${workerId} has no registry entry (lock-only).
Branch: ${wBranch}
Current branch: ${currentBranch}
Locked files: ${workerFiles.map(([f]) => f).join(", ")}

Register the worker (orchestrate action=register-worker) for a structured verdict.`,
        );
      }

      case "verify-and-merge": {
        if (!workerId) {
          throw new Error("verify-and-merge requires workerId");
        }

        // Locks are a conflict-prevention device, not the statement of which
        // branch to merge: resolve the branch from the explicit argument, the
        // registry entry, or the worker's lock rows, and block only when none
        // of the three yields one.
        const lockRows = getAllLocks(repoRoot);
        const lockBranch = Object.values(lockRows).find((row) => row.workerId === workerId)?.branch;
        const entryBranch = readWorkers(repoRoot).workers[workerId]?.branch ?? undefined;
        const workerBranch = branch ?? entryBranch ?? lockBranch;

        if (!workerBranch) {
          return textResult(
            `Worker ${workerId} has no branch to verify: no branch argument, no branch on its ` +
              `registry entry, and no lock rows. Nothing to verify.`,
          );
        }

        const outcome = verifyAndMergeBase(workerId, workerBranch, baseBranch ?? "main", repoRoot);
        // The merge sha travels in details as well as in the report, so a
        // parent can verify the claim it was handed without parsing prose; the
        // worktree branch travels with it, because a merge that leaves the
        // caller parked on the worker branch is a fact the caller acts on.
        return textResult(outcome.report, {
          ...(outcome.mergeSha ? { mergeSha: outcome.mergeSha } : {}),
          baseBranch: baseBranch ?? "main",
          worktreeBranch: outcome.worktreeBranch,
        });
      }

      case "release-locks": {
        if (!workerId) {
          throw new Error("release-locks requires workerId");
        }

        releaseLock(workerId, repoRoot);
        return {
          content: [
            {
              type: "text" as const,
              text: `Released all locks for worker ${workerId}.`,
            },
          ],
          details: {},
        };
      }

      case "list-locks": {
        const locks = getAllLocks(repoRoot);
        const entries = Object.entries(locks);

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No locks held.",
              },
            ],
            details: {},
          };
        }

        const detail = entries
          .map(([file, entry]) => `  ${file} → ${entry.workerId} (${entry.branch})`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Current locks:\n${detail}`,
            },
          ],
          details: {},
        };
      }

      case "check-conflicts": {
        if (!files) {
          throw new Error("check-conflicts requires files");
        }

        const conflicts = getConflicts(files, repoRoot);

        if (conflicts.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No conflicts detected. All files are available.",
              },
            ],
            details: {},
          };
        }

        const detail = conflicts
          .map(
            (c: { file: string; lockedBy: string; branch: string }) =>
              `  ${c.file} → ${c.lockedBy} (${c.branch})`,
          )
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Conflicts detected:\n${detail}`,
            },
          ],
          details: {},
        };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
};

// Extension Factory

export default function orchestratorExtension(pi: ExtensionAPI): void {
  pi.registerTool(orchestrateTool);
  log.info("[orchestrator] registered orchestrate tool");
}
