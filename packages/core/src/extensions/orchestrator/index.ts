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
 *
 * Two lifecycle invariants live beside the tool, because both are about the
 * fleet and both need the registry this module owns:
 *
 *   - A session that settles while a worker it owns is live must leave
 *     something scheduled to wake it. The seat arms that timer itself after a
 *     dispatch, and a turn that ends on the dispatch arms nothing at all, so
 *     the arm is taken here at the turn end, where the failing state is
 *     already visible, instead of being asked of the seat again.
 *   - A worker's terminal transition must not leave its pane standing. The
 *     registry knows the pane and the close; the renderer will not close a
 *     pane when an interactive agent stops, so the close path does it.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";
import { TURN_END } from "../../lib/core/event-names.js";
import { readSettingsFileOutcome } from "../../lib/config/per-tool-settings.js";
import { getExtensionState, getSessionIdSafe } from "../../lib/state/extension-state.js";
import { getTimerExtensionFactoryState } from "../../lib/state/global-state.js";
import {
  paneIsClear,
  reapWorkerPane,
  type PaneReapOutcome,
} from "../../lib/orchestrator/pane-lifecycle.js";
import {
  cancelTimer,
  cancelTimersByTag,
  listTimers,
  scheduleTimer,
} from "../scheduling/timer/index.js";
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
  locateResultSchema,
  readPopulationStamps,
  populationRefusalDetail,
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
  type PopulationRead,
} from "../../lib/orchestrator/index.js";
// The queue-fact readers come from their module directly: the barrel above is
// one way into the library, not the only one, and it does not re-export these.
import {
  normalizeDependsOn,
  orderWorkerRows,
  validateDependencies,
  type WorkerOrderRow,
} from "../../lib/orchestrator/workers.js";

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
 * The commit census: how many entries the tree at `revision` holds. This is
 * the index-independent equivalent of `git ls-files | wc -l` at that revision
 * — it reads the named revision's tree rather than the caller's index, since
 * the caller's worktree is not necessarily checked out where the gate scanned.
 * Null when git cannot resolve the revision.
 */
function censusAt(revision: string, repoRoot: string | undefined): number | null {
  if (!repoRoot) return null;
  const out = git(repoRoot, ["ls-tree", "-r", "--name-only", revision]);
  if (out === undefined) return null;
  return out === "" ? 0 : out.split("\n").length;
}

/**
 * The branches matching `worker/<id>/*` that carry a commit the base does not
 * hold, excluding the branch just verified. Read when that branch's tip is the
 * base itself: that is the shape a split branch makes — the registry row keeps
 * the branch creation made, the work landed on a second one — and the report
 * has to name where the work is, not only where it is not.
 */
function unmergedWorkerBranches(
  workerId: string,
  namedBranch: string,
  base: string,
  repoRoot: string,
): Array<{ name: string; tip: string }> {
  // The id sits inside a ref glob; anything git could read as a pattern would
  // widen the census past this worker's own branches.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerId)) return [];
  const out = git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    `refs/heads/worker/${workerId}/*`,
  ]);
  if (!out) return [];
  const found: Array<{ name: string; tip: string }> = [];
  for (const line of out.split("\n")) {
    const [name, tip] = line.trim().split(/\s+/);
    if (!name || !tip || name === namedBranch) continue;
    if (isAncestor(tip, base, repoRoot)) continue;
    found.push({ name, tip });
  }
  return found;
}

/**
 * The gate rows the merge path reads its population record from. A row that
 * was already closed carries its recorded gates, and those win; the normal
 * flow merges before close-worker, so the fallback is the worker's result
 * block — the result contract's `gate_evidence`, located in the session the
 * row names. No session and no gates is an empty read, not an error: the
 * comparison is a reader, and a missing record prints as one.
 */
function closeGateRows(entry: WorkerEntry | undefined): unknown[] {
  if (entry && Array.isArray(entry.gates) && entry.gates.length > 0) return entry.gates;
  const located = locateResultSchema(entry?.workerSession ?? null);
  const rows = located?.schema.gate_evidence;
  return Array.isArray(rows) ? rows : [];
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
  population: PopulationRead,
): MergeOutcome {
  /** A refusal or no-op: nothing was merged, so nothing may be marked merged. */
  const nothingMerged = (report: string): MergeOutcome => ({
    report,
    mergeSha: null,
    worktreeBranch: getCurrentBranch(repoRoot),
  });

  if (!repoRoot || !gitAvailable(repoRoot)) {
    return nothingMerged(
      `NOT merged: no git repository resolved (pass cwd), so ${workerBranch} cannot be verified. No merge performed.`,
    );
  }
  if (!isSafeRef(base) || !isSafeRef(workerBranch)) {
    return nothingMerged(
      `NOT merged: unsafe ref name (base="${base}", branch="${workerBranch}"); refusing to read it.`,
    );
  }
  if (!branchExists(workerBranch, repoRoot)) {
    return nothingMerged(`NOT merged: branch ${workerBranch} does not exist. No merge performed.`);
  }

  const baseBefore = revParse(base, repoRoot);
  if (!baseBefore) {
    return nothingMerged(`NOT merged: base branch "${base}" not found. No merge performed.`);
  }
  const tip = revParse(workerBranch, repoRoot);
  if (!tip) {
    return nothingMerged(`NOT merged: branch ${workerBranch} has no commit. No merge performed.`);
  }

  const short = (sha: string) => sha.slice(0, 12);
  const diff = getDiff(workerBranch, base, repoRoot);
  const scan = surfaceScanReport(diff);

  // The population read rides directly under the outcome line: it is the
  // reason a refusal happened, and on a merge it is the recorded-versus-git
  // pair the merge claim is certified against.
  const populationNote = population.lines.length > 0 ? `\n${population.lines.join("\n")}` : "";

  const finish = (
    lead: string,
    keptReason: string,
    mergeSha: string | null,
    extraWorktreeNote = "",
    deletedNote = "deleted",
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
      report: `${lead}${audit}${populationNote}\nBranch: ${workerBranch} (${
        deleted ? deletedNote : onWorkerBranch ? "kept: this worktree is on it" : keptReason
      })${worktreeNote}${settleBlock}\nDiff summary:\n${diff.slice(0, 2000)}\n${scan}`,
      mergeSha,
      worktreeBranch: head,
    };
  };

  // The base already holds the worker's work: nothing to merge, and saying
  // "merged" here would be a false success. When the named branch's tip is the
  // base itself the branch carries nothing of its own, so the report also
  // names any other branch for this worker that does hold work the base lacks:
  // a seat that created its own branch leaves exactly that shape behind, and
  // "already contained" alone reads as a completion for work that is not in.
  if (isAncestor(tip, base, repoRoot)) {
    const elsewhere =
      tip === baseBefore ? unmergedWorkerBranches(workerId, workerBranch, base, repoRoot) : [];
    const elsewhereNote =
      elsewhere.length === 0
        ? ""
        : "\n" +
          elsewhere
            .map(
              (b) =>
                `Branch ${b.name} for worker ${workerId} carries work not in ${base}: tip ${short(
                  b.tip,
                )}. Merge it: orchestrate action=verify-and-merge workerId=${workerId} branch=${b.name}`,
            )
            .join("\n");
    const lead =
      tip === baseBefore
        ? `NOTHING merged: worker ${workerId}'s branch ${workerBranch} is already contained in ${base} at ${short(
            baseBefore,
          )} itself; the branch carries no work of its own. No merge was performed.${elsewhereNote}`
        : `NOTHING merged: worker ${workerId}'s branch ${workerBranch} at ${short(
            tip,
          )} is already contained in ${base} (${short(
            baseBefore,
          )}); no work to merge. No merge was performed.${elsewhereNote}`;
    return finish(lead, "kept: still checked out", null, "", "deleted; no merge was performed");
  }

  // A recorded population below the census at its own revision is the claim
  // this read exists to test: the gate certified fewer tracked entries than
  // that revision holds, so the merge waits for a re-run on the staged tree.
  const standingDetail = populationRefusalDetail(population);
  if (standingDetail) {
    return nothingMerged(
      `NOT merged: ${standingDetail}\n` +
        `Base unchanged at ${short(baseBefore)}. Locks and branch kept.\n${population.lines.join(
          "\n",
        )}`,
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
    // Git derives a merge subject from the branch name, so a merge out of a
    // worker branch would publish that branch's namespace in the one part of a
    // commit a reader keeps. The subject states what landed instead. A tip
    // whose subject cannot be read (missing, or empty) refuses the merge: the
    // fallback is precisely the derived subject this avoids, so a silent
    // fallback would put the leak back.
    const landed = git(repoRoot, ["log", "-1", "--format=%s", workerBranch]);
    if (!landed) {
      return nothingMerged(
        `NOT merged: cannot read the subject of ${workerBranch} at ${short(tip)}; refusing to merge without an explicit subject, since git would derive the merge subject from that branch name. Base unchanged at ${short(baseBefore)}. Locks and branch kept.`,
      );
    }
    if (git(repoRoot, ["merge", "--no-edit", "-m", landed, workerBranch]) === undefined) {
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
    `MERGED: worker ${workerId}'s branch ${workerBranch} merged into ${base} at ${short(
      baseAfter,
    )} (was ${short(baseBefore)}).`,
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
  // The closer sits next to the status it explains: a closed row whose
  // closure no seat performed is the reading this line exists to expose.
  const closer = entry.closedBy
    ? `  closer=${entry.closedBy.kind}${entry.closedBy.forced ? "(forced)" : ""}${
        entry.closedBy.session ? ` session=${entry.closedBy.session}` : ""
      }`
    : "";
  // Printed only when the row carries one: an unranked, wait-free row keeps the
  // line it had before the queue facts existed.
  const priority = typeof entry.priority === "number" ? `  priority=${entry.priority}` : "";
  const dependsOn =
    Array.isArray(entry.dependsOn) && entry.dependsOn.length > 0
      ? `  depends-on=${entry.dependsOn.join(", ")}`
      : "";
  return `  ${entry.workerId}  spec=${entry.spec}  status=${entry.status}${closer}  pane=${
    entry.pane ?? "-"
  }  session=${entry.workerSession ?? "-"}  output=${
    entry.outputFile ?? "-"
  }  branch=${entry.branch ?? "-"}${closed}${priority}${dependsOn}`;
}

/**
 * One listing entry: the row line, plus the ids holding it after it, indented
 * under the row so the marker can never be read as a row of its own.
 */
function workerListLine(row: WorkerOrderRow): string {
  const line = workerLine(row.entry);
  if (row.blockedBy.length === 0) return line;
  return `${line}\n    blocked-by: ${row.blockedBy.join(", ")}`;
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
    `storedStatus: ${verdict.storedStatus}`,
    `blockedBy: ${verdict.blockedBy.length > 0 ? verdict.blockedBy.join(", ") : "-"}`,
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
 * End the pane of the worker just closed: the row's own handle, or the caller's
 * argument when the row records none.
 *
 * A row and an argument that name different panes is a contradiction, and the
 * entries are reported rather than resolved by preference: the pane step is
 * destructive, and a wrong close kills a run.
 */
function closeClosedWorkerPane(closed: WorkerEntry, requested: string): PaneReapOutcome {
  const recorded = typeof closed.pane === "string" ? closed.pane.trim() : "";
  if (recorded && requested && recorded !== requested) {
    return {
      result: "refused",
      detail:
        `the row records pane ${recorded} and the argument names ${requested}, so neither was ` +
        `closed; the row is closed, and a re-close with the row's own handle ends its pane`,
    };
  }
  return reapWorkerPane({
    pane: recorded || requested || null,
    workerSession: closed.workerSession,
  });
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

// Settle-time arm
//
// The device that removes a per-turn choice: at the turn end, every live worker
// this session owns and no pending timer names gets one. The facts it needs are
// both public — the registry (this module's own) and the scheduling module's
// timer API — so nothing here reads another module's store, and nothing polls:
// the failing state (a session settling with an unwatched worker) becomes true
// at exactly this event.

/** The knobs, all read at the turn end so a change lands without a rebuild. */
interface SettleArmConfig {
  /** "off" makes the turn end byte-identical to the pre-device one. */
  mode: "on" | "off";
  /** Delay before the first fire: inside the window a seat checks a dispatch anyway. */
  delayMs: number;
  /**
   * The recurrence the arm carried while it delivered a cadence. A single fire
   * has nothing to repeat, so the value is inert; the field stays because
   * `broker.orchestrator` is a shipped settings block, and dropping a knob is a
   * contract change with its own migration.
   */
  intervalMs: number;
}

/**
 * Code-constant defaults, in the watchdog's shape: the settings block overrides
 * them field by field and an invalid field falls back on its own, so one typo
 * cannot disarm the device or set a zero delay. The delay sits inside the
 * measured gap a seat leaves between a dispatch and its next input; every fire
 * re-derives the uncovered set instead of repeating one.
 */
const SETTLE_ARM_DEFAULTS: SettleArmConfig = {
  mode: "on",
  delayMs: 240_000,
  intervalMs: 300_000,
};

/** Positive finite number or undefined. */
function positiveFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Read `broker.orchestrator` from settings.json, fresh on every turn end.
 *
 * The block sits in the `broker` namespace the watchdog already established
 * rather than under `braid.*`: those keys are mirrored into a generated schema
 * and a config reference, and a device knob belongs to the module that owns the
 * invariant. Absent or non-object block means defaults.
 *
 * Example:
 *   "broker": { "orchestrator": { "settleArm": "off", "settleDelayMs": 120000 } }
 */
function loadSettleArmConfig(): SettleArmConfig {
  const config: SettleArmConfig = { ...SETTLE_ARM_DEFAULTS };
  try {
    const broker = readSettingsFileOutcome().settings.broker as
      | { orchestrator?: unknown }
      | undefined;
    const block = broker?.orchestrator;
    if (!block || typeof block !== "object" || Array.isArray(block)) return config;
    const b = block as Record<string, unknown>;
    if (b.settleArm === "on" || b.settleArm === "off") config.mode = b.settleArm;
    const delayMs = positiveFinite(b.settleDelayMs);
    const intervalMs = positiveFinite(b.settleIntervalMs);
    if (delayMs !== undefined) config.delayMs = delayMs;
    if (intervalMs !== undefined) config.intervalMs = intervalMs;
  } catch {
    // An unreadable settings file is not a reason to leave the fleet unwatched:
    // the defaults are the device.
  }
  return config;
}

/**
 * Per-session record of the project keys this session has orchestrated in.
 *
 * The registry is keyed by project, and a seat usually runs in its own
 * directory while the rows it writes live under the repositories it works in,
 * so the session's own cwd is not where its fleet is. `Set` of keys rather than
 * one key, because a seat can drive two repositories in one working set.
 */
interface SettleState {
  projectKeys: Set<string>;
}

/** The session's settle state, or null when there is no session to key it on. */
function settleState(ctx: unknown): SettleState | null {
  if (!ctx) return null;
  try {
    return getExtensionState<SettleState>(ctx as ExtensionContext, "orchestrator.settle", () => ({
      projectKeys: new Set<string>(),
    }));
  } catch {
    return null;
  }
}

/**
 * Note that this session orchestrated in `key`. Called from every tool call that
 * resolved a project, which is the harness's own statement that the session owns
 * that fleet; armed timers are then scoped to those registries instead of to
 * every registry on the box.
 */
function noteProjectKey(ctx: unknown, key: string | undefined): void {
  if (!key) return;
  try {
    settleState(ctx)?.projectKeys.add(key);
  } catch {
    // Recording where the session worked is bookkeeping; it never fails a call.
  }
}

/** The launch-time role marker the orchestrator exports into a worker's pane. */
const ENV_SESSION_ROLE = "BRAID_SESSION_ROLE";

/**
 * What the calling process can say about itself. The session file is the
 * identity a row can be compared against; the role marker is the one
 * launch-time fact a seat does not carry. A context whose session manager
 * exists but cannot name its session is `unattributed`: a close from it would
 * record a terminal outcome no session can be asked about.
 */
function readCallerIdentity(ctx: unknown): {
  session: string | null;
  workerRole: boolean;
  unattributed: boolean;
} {
  // A call that carries no context is a library call: its closer cannot be
  // attributed to a session, so it is recorded unknown even when this process
  // carries the worker marker. The tool always passes a context.
  if (!ctx || typeof ctx !== "object") {
    return { session: null, workerRole: false, unattributed: false };
  }
  const workerRole = process.env[ENV_SESSION_ROLE]?.trim().toLowerCase() === "worker";
  let manager: unknown;
  try {
    manager = (ctx as { sessionManager?: unknown }).sessionManager;
  } catch {
    return { session: null, workerRole, unattributed: false };
  }
  if (!manager || typeof manager !== "object") {
    return { session: null, workerRole, unattributed: false };
  }
  try {
    const sm = manager as { getSessionFile?(): unknown; getSessionId?(): unknown };
    const file = sm.getSessionFile?.() ?? sm.getSessionId?.();
    if (typeof file === "string" && file.length > 0) {
      return { session: file, workerRole, unattributed: false };
    }
    return { session: null, workerRole, unattributed: true };
  } catch {
    // A stale context getter throws; that is a missing identity, not an
    // identity that was refused, so the close is recorded unknown.
    return { session: null, workerRole, unattributed: false };
  }
}

/**
 * The sessions root this session belongs to, or undefined when the context
 * cannot name one. Only a closed row that predates the closer stamp reads it.
 */
function callerSessionsRoot(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  try {
    const dir = (
      ctx as { sessionManager?: { getSessionDir?(): unknown } }
    ).sessionManager?.getSessionDir?.();
    if (typeof dir !== "string" || dir.length === 0) return undefined;
    return /^--.*--$/.test(basename(dir)) ? dirname(dir) : dir;
  } catch {
    return undefined;
  }
}

/** Tag on every timer this device arms, so a cadence that watches nothing can be withdrawn. */
const BABYSIT_TAG = "orchestrator-babysit";

/**
 * Whether a timer reason names one worker id as a token.
 *
 * The id alphabet is the one the orchestrator's own branch lookup accepts
 * (`[A-Za-z0-9._-]`): an id that carries a dot is a legal worker id, so a split
 * on non-alphanumerics would cut it in half and never match it.
 */
function reasonNamesWorker(reason: string, workerId: string): boolean {
  const escaped = workerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._-])${escaped}(?=$|[^A-Za-z0-9._-])`).test(reason);
}

/** The reason a babysit timer carries: every worker it watches is named in it. */
function babysitReason(workerIds: string[]): string {
  return `babysit ${workerIds.join(", ")}: live worker(s) this session owns with no timer naming them`;
}

/**
 * The worker ids a reason of this device's own shape names, or null when the
 * reason is not that shape. The device writes `babysit <id>, <id>: ...`, so the
 * ids are the words between the verb and the colon.
 */
function workersInBabysitReason(reason: string): string[] | null {
  const match = /^babysit\s+([^:]+):/.exec(reason);
  if (!match) return null;
  const ids = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Arm one single-fire babysit timer for the live workers nothing names, after
 * withdrawing the timers whose sentence no longer describes the fleet. Returns a
 * line for the log, or null when the turn end needed no change.
 *
 * The reason is a snapshot of who is uncovered, so it may only be delivered
 * once: a recurrence re-delivers a claim about a fleet that has moved on, and
 * the session accumulates one such sentence per dispatch it ever left uncovered.
 * The next turn end re-derives the set from the registry instead, which is also
 * why a closed worker can never come back in a later fire.
 *
 * Withdrawal is the same decision as the arm: two places deciding which timers
 * should exist would disagree exactly when the fleet changes under them. A
 * timer is residue when none of the workers its reason names is open any more;
 * a reason that still names one open worker is not residue, whatever else it
 * names, and it is the one that blocks a second cadence. One fire wakes the seat
 * and is gone, so at most one cadence stands per session.
 *
 * Guards, each one a state this must not act on: an off switch; a session id the
 * fire could not be attributed to; no project this session orchestrated in.
 */
function armMissingWorkerTimers(ctx: unknown): string | null {
  const config = loadSettleArmConfig();
  if (config.mode === "off") return null;

  // The scheduling module owns the timer store and the poller that fires it.
  // Its factory counter is the one lib-level fact that says it is registered in
  // this process: arming into a store nothing polls would write a timer that
  // never fires, which looks installed and wakes nobody.
  if (getTimerExtensionFactoryState().callCount === 0) return null;

  const sessionId = getSessionIdSafe(ctx as ExtensionContext | undefined);
  if (!sessionId || sessionId === "?") return null;

  const state = settleState(ctx);
  const keys = state ? [...state.projectKeys] : [];
  if (keys.length === 0) return null;

  // A `Set`: the same id can be live in two project registries, and a reason
  // that names it twice reads as two workers.
  const live = new Set<string>();
  for (const key of keys) {
    for (const entry of Object.values(readWorkers(key).workers)) {
      if (!entry.closedAt) live.add(entry.workerId);
    }
  }

  // Residue: a timer this device armed whose reason names no worker the
  // registry still holds open. The tag is the device's own mark and every
  // reason it writes carries the shape, so a tagged reason outside the shape
  // has no open worker it can be shown to watch either.
  let withdrawn = 0;
  for (const timer of listTimers(sessionId)) {
    if (timer.tag !== BABYSIT_TAG) continue;
    const named = workersInBabysitReason(timer.reason);
    if (named && named.some((id) => live.has(id))) continue;
    if (cancelTimer(sessionId, timer.id)) withdrawn++;
  }

  if (live.size === 0) {
    // The fleet is empty: whatever the reasons say, no cadence has anything to
    // watch.
    withdrawn += cancelTimersByTag(sessionId, BABYSIT_TAG);
    return withdrawn > 0 ? `withdrew ${withdrawn} babysit timer(s): no live worker left` : null;
  }

  const standing = listTimers(sessionId);
  const uncovered = [...live].filter(
    (id) => !standing.some((timer) => reasonNamesWorker(timer.reason, id)),
  );
  const residue =
    withdrawn > 0 ? `withdrew ${withdrawn} babysit timer(s) naming no open worker` : "";
  if (uncovered.length === 0) return residue || null;

  const cadences = standing.filter((timer) => timer.tag === BABYSIT_TAG);
  if (cadences.length > 0) {
    // A cadence that survived withdrawal names an open worker. A second one
    // would double the wakes for the same fleet, so the uncovered worker waits
    // for this fire, which re-derives the whole set.
    return residue ? `${residue}; left ${cadences.length} cadence standing, armed nothing` : null;
  }

  const id = scheduleTimer(sessionId, config.delayMs, babysitReason(uncovered), BABYSIT_TAG, true);
  const armed = `armed ${id} for ${uncovered.join(", ")} (one fire in ${Math.round(
    config.delayMs / 1000,
  )}s)`;
  return residue ? `${residue}; ${armed}` : armed;
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
    "Coordinate parallel agent workers to prevent edit conflicts. Auto-detects the repo root (cwd overrides); without git, lock-only. verify-and-merge requires workerId, merges into an explicit base branch (default main), and claims success only when that base ref actually advanced. A close's stamped `files` row is compared against the census of the revision it names, and a number below that census refuses the merge before any ref moves. It never switches a worktree's branch: the caller's tree is left on the branch it was on, named in the report, and a branch is dropped only when it is actually gone. close-worker also ends the pane its row names (or the `pane` it is given for a row that records none), and leaves alone a pane herdr reports as working or blocked, a pane holding a different agent session, and this process's own pane. It records who performed the close (`closedBy`, resolved from the row's session and the caller's role marker) and refuses a caller that resolves as the row's worker, so a self-closed row cannot read as a seat's verified close; a closed row's status and checkpoint are terminal. " +
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
          "Worker pane ID (register-worker/update-worker/close-worker). Recorded as a handle only: check-worker does not read it as liveness. close-worker writes it onto a row that records none and closes that pane once the row is closed.",
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
    priority: Type.Optional(
      // `{ anyOf: [{ type: "number" }, { type: "null" }] }` written as its own
      // keywords: the builder's named constructors have no null literal, and the
      // schema this hand-built object emits is plain JSON Schema.
      Type.Unsafe<number | null>({
        anyOf: [{ type: "number" }, { type: "null" }],
        description:
          "Queue rank: lower runs sooner; null is unranked, which sorts after every ranked row. " +
          "spawn-worker/register-worker record it at admission; update-worker changes or clears it.",
      }),
    ),
    dependsOn: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Worker ids this row waits for (spawn-worker/register-worker only: dependencies are fixed at admission). " +
          "Refused when an id is unknown, is this worker's own id, or would close a loop; a refused admission writes nothing. " +
          "check-worker reports `blocked`, naming these ids, while any of them is not merged or completed.",
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
      Type.Array(
        Type.Object({
          cmd: Type.String(),
          exit: Type.Number(),
          stamp: Type.Optional(
            Type.String({
              description:
                "Population record for a gate whose subject is a file or row population: " +
                '"scanned <n> <unit> at <revision>" (n a non-negative integer, unit one ' +
                "lowercase word, revision a 7-to-40-char hex sha or a ref name). " +
                "verify-and-merge reads a stamped `files` row against that revision's " +
                "tracked-entry census and refuses the merge when the recorded number sits " +
                "below it.",
            }),
          ),
        }),
        {
          description:
            "Gate evidence for close-worker: command plus exit code, recorded with a timestamp. " +
            `A completed close whose entry carries none of a fresh output file, a branch advance or ` +
            `merge, and a passing gate is flagged "${WORKER_EFFECT_EVIDENCE_FLAG}" (advisory, non-blocking). ` +
            "Every row is also read for well-formedness at close time (parses under sh -n, first token " +
            "resolves, no top-level decoration, exit 0 under a completed outcome); the read ships in " +
            "shadow mode, so a failing row is logged and the close proceeds, until " +
            'braid.orchestrator.closeGateWellFormedness is set to "enforce". ' +
            "Rows the seat's production-write class marks as writes are refused unless the close " +
            "records every named preflight piece somewhere in its rows; the class data is the seat's, " +
            "and no class data means no refusal.",
        },
      ),
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
    forcedBySeat: Type.Optional(
      Type.Boolean({
        description:
          "close-worker: close a row whose caller resolves as the row's worker. The row records closedBy kind worker with forced=true; reserved for a stuck row whose only reachable session is the worker's, never an ordinary close.",
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
      priority?: number | null;
      dependsOn?: string[];
      phase?: string;
      lastStep?: string;
      requestId?: string;
      outcome?: string;
      gates?: Array<{ cmd: string; exit: number; stamp?: string }>;
      includeClosed?: boolean;
      includeStats?: boolean;
      liveStatus?: string;
      forcedBySeat?: boolean;
    },
    _signal: AbortSignal,
    _onUpdate: unknown,
    ctx: unknown,
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
      priority,
      dependsOn,
      phase,
      lastStep,
      requestId,
      outcome,
      gates,
      includeClosed,
      includeStats,
      liveStatus,
      forcedBySeat,
    } = params;

    const repoRoot = resolveCwd(explicitCwd, files);

    // Every action says where this session orchestrated, which is what the
    // settle-time arm reads: a seat usually runs in its own directory while the
    // rows it writes live under the repositories it works in, so the session's
    // cwd is not where its fleet is.
    noteProjectKey(ctx, repoRoot ?? process.cwd());

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
        const registryAtSpawn = readWorkers(projectCwd);
        const existing = registryAtSpawn.workers[workerId];
        // Dependencies are part of what the work is, so a retry carries the same
        // set; changing them under the same request id is different work.
        const dependsOnIds = normalizeDependsOn(dependsOn);
        const decision = decideAdmission(existing, effectiveRequestId, {
          spec,
          files,
          dependsOn: dependsOnIds,
        });
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

        // A dependency that cannot be satisfied refuses the spawn before a
        // branch or a lock exists, so a refused spawn leaves nothing to undo.
        const dependencyRefusal = validateDependencies(workerId, dependsOnIds, registryAtSpawn);
        if (dependencyRefusal) {
          throw new Error(`spawn-worker: ${dependencyRefusal.message}.`);
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
              priority,
              dependsOn: dependsOnIds,
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
1. Split a pane for it: herdr_layout action=pane_split cwd=<project-root>
2. Put the role marker in that pane's shell, before the agent starts:
   herdr_pane action=run pane=<pane-id> command="export BRAID_SESSION_ROLE=worker"
3. Start pi in the same pane through the agent channel, so the exported marker is inherited and the
   seat can still drive and read the worker by name:
   herdr_agent action=start pane=<pane-id> kind=pi name=<worker-id>
4. The worker should: git checkout ${branchName}, make changes, commit, then signal completion

A launch driven without the agent CLI (a one-shot json run, a pane nobody babysits) carries the
marker as a command prefix instead: command="BRAID_SESSION_ROLE=worker pi". Same environment,
no agent entry to prompt or read through.

The marker is what makes the worker session a worker to the extensions that read it: a process
started without it registers the seat's own outbound surfaces, including the Telegram channel.

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
              priority,
              dependsOn,
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
            priority,
            dependsOn,
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
        if (dependsOn !== undefined) {
          throw new Error(
            "update-worker: dependencies are fixed at admission — dependsOn is admitted by " +
              "spawn-worker/register-worker only. A worker that gains a dependency after it " +
              "started is a second unit of work wearing the first one's id; close the entry and " +
              "admit it again.",
          );
        }

        const patch: UpdateWorkerPatch = {};
        if (pane !== undefined) patch.pane = pane;
        if (workspace !== undefined) patch.workspace = workspace;
        if (workerSession !== undefined) patch.workerSession = workerSession;
        if (outputFile !== undefined) patch.outputFile = outputFile;
        if (branch !== undefined) patch.branch = branch;
        if (files !== undefined) patch.files = files;
        if (status !== undefined) patch.status = parseWorkerStatus(status);
        if (priority !== undefined) patch.priority = priority;
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

        // Actionable order over the rows being shown, with satisfaction read
        // against every row: a closed dependency still counts as delivered.
        const ordered = orderWorkerRows(shown, registry);
        const lines = [...ordered.ready, ...ordered.blocked].map(workerListLine).join("\n");
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

        // The pane handle is settled on the row the close returned, which is
        // the authoritative one (a row can live under a project other than the
        // caller's). A row that records no pane is a row no later reader can
        // pair, so a handle the caller supplies is written onto it: a seat that
        // closes fourteen workers in one turn otherwise leaves fourteen panes
        // nothing can name. A row that already records one is never overwritten.
        const requestedPane = typeof pane === "string" ? pane.trim() : "";

        const closed = closeWorker(workerId, parseWorkerOutcome(outcome), gates, repoRoot, {
          ...readCallerIdentity(ctx),
          forced: forcedBySeat === true,
        });
        if (!closed) {
          return textResult(`No registry entry for worker ${workerId}.`);
        }
        const entry =
          requestedPane && !closed.pane
            ? (updateWorker(workerId, { pane: requestedPane }, repoRoot) ?? closed)
            : closed;

        // A terminal completion carries its effect evidence on the close
        // result: a completed close whose row shows none of the three kinds
        // is flagged in the report. The flag is advisory — the close itself
        // stands, and the parent decides what the missing evidence means.
        const effectEvidence =
          entry.closedAt && entry.status === "completed"
            ? workerEffectEvidenceForEntry(entry, { cwd: repoRoot })
            : null;
        const flagNote =
          effectEvidence && effectEvidence.none
            ? `\n${WORKER_EFFECT_EVIDENCE_FLAG}: ${effectEvidenceGaps(effectEvidence)}`
            : "";

        // The other half of the terminal transition: the pane the worker ran in
        // does not close itself, and the row that named it has just become
        // terminal. The step runs after the row is closed so a refused close
        // (gate evidence, production preflight) never touches a pane, and it
        // reports its own outcome beside the registry one.
        const paneStep = closeClosedWorkerPane(entry, requestedPane);

        return textResult(
          `Worker ${workerId} closed: ${entry.status}.${flagNote}\nPane: ${paneStep.detail}.\n${JSON.stringify(
            entry,
            null,
            2,
          )}`,
          {
            entry,
            effectEvidence,
            pane: {
              result: paneStep.result,
              detail: paneStep.detail,
              cleared: paneIsClear(paneStep),
            },
          },
        );
      }

      case "check-worker": {
        if (!workerId) {
          throw new Error("check-worker requires workerId");
        }

        // The lock table is the fallback branch source for an entry whose own
        // branch is null; checkWorker reads it at the entry's own project key.
        const verdict = checkWorker(workerId, {
          liveStatus,
          cwd: repoRoot,
          sessionsDir: callerSessionsRoot(ctx),
        });
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
        const entry = readWorkers(repoRoot).workers[workerId];
        const entryBranch = entry?.branch ?? undefined;
        const workerBranch = branch ?? entryBranch ?? lockBranch;

        if (!workerBranch) {
          return textResult(
            `NOTHING merged: worker ${workerId} has no branch to verify: no branch argument, no ` +
              `branch on its registry entry, and no lock rows.`,
          );
        }

        // The close's population record is read before the merge: the stamped
        // rows are the reporter's own numbers, and the census they are compared
        // against comes from git alone.
        const population = readPopulationStamps(closeGateRows(entry), (revision) =>
          censusAt(revision, repoRoot),
        );
        const outcome = verifyAndMergeBase(
          workerId,
          workerBranch,
          baseBranch ?? "main",
          repoRoot,
          population,
        );
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

  // The settle-time arm. It rides the harness event rather than a polling
  // loop: the state it looks for (a session settling with a live worker no
  // timer names) becomes true exactly here, so there is no delay to tune and no
  // second opinion about when the session is idle. A throw from this handler
  // would follow the turn end out, so the body is caught whole: an arm that
  // cannot be taken is a log line, never a broken turn.
  pi.on(TURN_END, (_event: unknown, ctx: unknown) => {
    try {
      const note = armMissingWorkerTimers(ctx);
      if (note) log.info(`[orchestrator] settle: ${note}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[orchestrator] settle-time arm failed (the turn end stands): ${reason}`);
    }
  });
}
