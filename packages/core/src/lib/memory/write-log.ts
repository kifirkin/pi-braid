/**
 * Memory write-decision log: the append-only measurement hook for the
 * review-before-write gate (lib/memory/write-quality.ts).
 *
 * One JSON line per gated decision, at `~/.pi/agent/braid/memory/write-log.jsonl`.
 * Gate decisions are otherwise visible only in session logs, which cannot be
 * counted across sessions; this file is what makes week-over-week gate metrics
 * (per-site write counts, decision mix, silence detection) computable.
 *
 * Line schema: {ts, site, id?, decision, reason, taskHash, solutionHash, mode}.
 *   - ts: ISO-8601 decision time.
 *   - site: the writer that computed the decision (WRITE_GATE_SITES).
 *   - id: the episode the line refers to. skip-dup lines carry the existing
 *     episode id; accept/repair lines omit it, because addEpisode allocates the
 *     new id after the decision; reject lines have none.
 *   - decision: accept | repair | reject | skip-dup. This is the decision as
 *     computed: a warn-mode accept/repair was logged but not applied.
 *   - reason: the predicate's static reason string. Reasons stay content-free;
 *     nothing derived from task/solution text ever enters this file.
 *   - taskHash / solutionHash: sha256 hex of the exact candidate strings,
 *     truncated to WRITE_LOG_HASH_LENGTH. Hashes, never raw content: the log
 *     must stay safe to read, diff and share.
 *   - mode: the gate mode at decision time ("enforce" | "warn"), so a staged
 *     warn-mode rollout is distinguishable from enforced decisions.
 *
 * Hot-path contract:
 *   - append-only: no read path, no cache, no queue on the write path.
 *   - never throws: a failed append (unwritable path, disk full, permissions)
 *     degrades to a debug log and leaves the memory write untouched.
 *   - only active sites are logged. A gate that is disabled globally or for a
 *     site computes no decision and appends nothing; settings describe that
 *     window, not decision history.
 *
 * Wiring: write sites call applyWriteGateLogged() instead of applyWriteGate(),
 * which keeps write-quality.ts pure and keeps the side effect here. The
 * heartbeat outcome sender keeps its own boolean predicate
 * (shouldWriteOutcomeEpisode) and is deliberately not routed through this log.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../core/logger.js";
import { WRITE_LOG_FILE, writeLogFilePath } from "../config/braid-paths.js";
import {
  applyWriteGate,
  isGateActive,
  type DecideWriteInput,
  type GateOutcome,
  type MemoryWriteGateConfig,
  type MemoryWriteGateMode,
  type WriteDecision,
  type WriteGateSite,
} from "./write-quality.js";

export { WRITE_LOG_FILE };

const log = createLogger("memory:write-log");

/** Hex length of the truncated sha256 task/solution hashes. */
export const WRITE_LOG_HASH_LENGTH = 16;

/** One computed decision, as handed to the log by a write site. */
export interface WriteLogEntry {
  site: WriteGateSite;
  decision: WriteDecision;
  /** Candidate task as submitted to the gate (hashed, never stored). */
  task: string;
  /** Candidate solution as submitted to the gate (hashed, never stored). */
  solution: string;
  /**
   * Episode id when the caller knows one. skip-dup falls back to the
   * duplicated episode's id (decision.existingId) when this is omitted.
   */
  id?: string;
  mode: MemoryWriteGateMode;
}

/** The JSONL line shape; key order matches this declaration. */
export interface WriteLogLine {
  ts: string;
  site: WriteGateSite;
  id?: string;
  decision: WriteDecision["action"];
  reason: string;
  taskHash: string;
  solutionHash: string;
  mode: MemoryWriteGateMode;
}

/** Truncated sha256 hex of one candidate field. */
function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, WRITE_LOG_HASH_LENGTH);
}

/** Static, content-free reason for a decision. */
function decisionReason(decision: WriteDecision): string {
  switch (decision.action) {
    case "accept":
      return "accepted";
    case "repair":
    case "reject":
      return decision.reason;
    case "skip-dup":
      return `duplicate (${decision.match}, similarity ${decision.similarity.toFixed(2)})`;
  }
}

/** Build one log line. Pure; the caller owns the clock. */
export function buildWriteLogLine(entry: WriteLogEntry, now: Date = new Date()): WriteLogLine {
  const id =
    entry.id ?? (entry.decision.action === "skip-dup" ? entry.decision.existingId : undefined);
  return {
    ts: now.toISOString(),
    site: entry.site,
    ...(id !== undefined ? { id } : {}),
    decision: entry.decision.action,
    reason: decisionReason(entry.decision),
    taskHash: hashContent(entry.task),
    solutionHash: hashContent(entry.solution),
    mode: entry.mode,
  };
}

/**
 * Append one decision line. Never throws: a failed append degrades to a log
 * line, so an unwritable log path can never break a memory write. The first
 * failure in a process warns (the sink may be refusing because no absolute
 * braid root resolves); later ones stay at debug.
 */
export function logWriteDecision(entry: WriteLogEntry): void {
  try {
    const file = writeLogFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(buildWriteLogLine(entry))}\n`, "utf8");
  } catch (err) {
    reportLogFailure(err);
  }
}

/** Warned once per process about an unwritable write-decision log. */
let _warnedLogFailure = false;

function reportLogFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (_warnedLogFailure) {
    log.debug(`write-log append failed (${message}); decision unaffected`);
    return;
  }
  _warnedLogFailure = true;
  log.warn(`write-log append failed (${message}); decision unaffected`);
}

/**
 * applyWriteGate + log. The write sites call this so every computed decision
 * lands in write-log.jsonl while the predicate module stays pure. Sites where
 * the gate is inactive log nothing (no decision was computed).
 */
export function applyWriteGateLogged(
  cfg: MemoryWriteGateConfig,
  input: DecideWriteInput,
): GateOutcome {
  const outcome = applyWriteGate(cfg, input);
  if (isGateActive(cfg, input.site)) {
    logWriteDecision({
      site: input.site,
      decision: outcome.decision,
      task: input.task,
      solution: input.solution,
      mode: cfg.mode,
    });
  }
  return outcome;
}
