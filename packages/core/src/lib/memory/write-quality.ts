/**
 * Memory write-quality gate (review-before-write).
 *
 * A heuristic filter that decides "is this episode worth writing?" BEFORE
 * `addEpisode` on braid's durable episode write paths. The original pilot
 * covered the heartbeat scheduler's session_outcome sender — the documented
 * 89%-junk store — and this module now carries the per-site policies for
 * every episode writer:
 *
 *   - L0: reject tasks with no signal (sentinel/placeholder/too short).
 *   - L1: handle a dead solution field — never store the dead template: at
 *     heartbeat the both-fields rule rejects; everywhere else the solution is
 *     repaired from the tool sequence (what was actually done) when at least
 *     three tools ran, and rejected when there is no evidence to populate it
 *     with.
 *   - L2: skip exact or near-duplicate (task, solution) repeats against the
 *     last 20 same-project episodes.
 *
 * Guardrails:
 *   - Heuristic only: no LLM calls in the write path, one 20-entry scan max.
 *   - Pure predicates and helpers; clock/state ownership stays with the
 *     caller (heartbeat keeps its module-level lastWriteAt, same pattern as
 *     context-manager/compaction.ts).
 *   - Toggleable via settings.json (`braid.memory.writeGate`), settings-over-env
 *     (reader lives in lib/config/braid-settings.ts). `enabled: false`
 *     restores pre-gate behavior exactly; `sites.<site>: false` restores
 *     pre-gate behavior for one writer (incident rollback).
 *   - Decisions are recorded by the write sites through lib/memory/write-log.ts
 *     (applyWriteGateLogged); this module stays pure.
 */

/** Defaults for the braid.memory.writeGate settings block. */
export const MEMORY_WRITE_GATE_DEFAULTS = {
  /** Gate ON by default: junk is not written unless explicitly disabled. */
  enabled: true,
  /**
   * Minimum interval between gated heartbeat writes (anti-thrash).
   * Prime Agent's `autoRefine.cooldownMs` precedent: 20 minutes.
   */
  cooldownMs: 20 * 60 * 1000,
  /** "enforce" applies decisions; "warn" logs them and writes anyway. */
  mode: "enforce",
} as const;

export type MemoryWriteGateMode = "enforce" | "warn";

/** Every episode-write site the gate knows about. */
export const WRITE_GATE_SITES = [
  "heartbeat",
  "finalize",
  "memoryStoreTwin",
  "episodesAdd",
  "reasoningChains",
  "mars",
] as const;

/**
 * Build the replacement solution for a dead solution field from the tool
 * sequence: the tools that actually ran, deduped on consecutive repeats and
 * capped. Returns null when the sequence is too short to be evidence
 * (fewer than 3 tools), in which case the caller rejects the candidate.
 *
 * Called for every site except heartbeat: heartbeat keeps its both-fields
 * rule and rejects before this runs.
 */
export function repairFromToolSequence(toolSequence: readonly string[]): string | null {
  if (toolSequence.length < 3) return null;
  const steps: string[] = [];
  for (const tool of toolSequence) {
    if (steps[steps.length - 1] !== tool) steps.push(tool);
  }
  const shown = steps.slice(0, 8);
  const more = steps.length - shown.length;
  return `Ran: ${shown.join(" -> ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

export type WriteGateSite = (typeof WRITE_GATE_SITES)[number];

export type MemoryWriteGateConfig = {
  enabled: boolean;
  cooldownMs: number;
  mode: MemoryWriteGateMode;
  /** Per-writer opt-out; an absent key means the site is gated. */
  sites: Partial<Record<WriteGateSite, boolean>>;
};

/**
 * Shared signal suppressor — "is there actionable signal, or is this just
 * metrics/outcome boilerplate?".
 *
 * Matches the placeholder in both the colon form
 * ("session_outcome: ...") and the bracketed-tag form
 * ("[ok] session_outcome" + "Solution: ..." line) that whisperRecall
 * emits — the colon was previously required, so the bracketed form leaked.
 */
export function hasSignal(content: string): boolean {
  const metricsOnly = /^(\[\w+\]\s*)?(session_outcome|outcome)(:\s*\w+)?\b/i;
  if (metricsOnly.test(content.trim())) return false;
  if (content.trim().length < 15) return false;
  return true;
}

/**
 * Pure quality check for an outcome-episode candidate.
 *
 * Rejects when either the task or the solution is metrics-only or too short to
 * carry replayable signal. This is a strict superset of the previous
 * hard-coded `task !== "session_outcome"` sentinel kill: it also drops
 * "outcome:"-prefixed and short generic tasks.
 */
export function isWriteWorthy(task: string, solution: string): boolean {
  if (!hasSignal(task.trim())) return false;
  if (!hasSignal(solution.trim())) return false;
  return true;
}

// ── L2 dedupe ────────────────────────────────────────────────────────────────

/** Size of the dedupe window: the last N same-project episodes. */
export const DEDUPE_WINDOW = 20;

/** Task-token Jaccard at or above which two tasks count as the same work. */
export const NEAR_DUPLICATE_JACCARD = 0.85;

/** Minimum length of a reasoning-chain summary worth storing. */
export const REASONING_SUMMARY_MIN_CHARS = 40;

/** The fields the dedupe scan needs; a structural subset of the stored Episode. */
export interface EpisodeLike {
  id: string;
  task: string;
  solution: string;
  project?: string;
}

/** Unicode-aware task tokenization: lowercase letter/digit runs of 3+ chars. */
function taskTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Dedupe choke point: is this (task, solution) pair already in the window?
 *
 * Pure scan over the caller-provided window (the last 20 same-project
 * episodes; build it with selectRecentEpisodes). An exact pair match wins
 * over near matches; near matches compare task tokens at
 * NEAR_DUPLICATE_JACCARD. Returns null when nothing matches.
 */
export function findDuplicateEpisode(
  recent: readonly EpisodeLike[],
  task: string,
  solution: string,
): { id: string; match: "exact" | "near"; similarity: number } | null {
  const taskTrim = task.trim();
  const solutionTrim = solution.trim();
  for (const ep of recent) {
    if (ep.task.trim() === taskTrim && ep.solution.trim() === solutionTrim) {
      return { id: ep.id, match: "exact", similarity: 1 };
    }
  }
  const tokens = taskTokens(taskTrim);
  if (tokens.size === 0) return null;
  let best: { id: string; similarity: number } | null = null;
  for (const ep of recent) {
    const similarity = jaccard(tokens, taskTokens(ep.task));
    if (similarity >= NEAR_DUPLICATE_JACCARD && (!best || similarity > best.similarity)) {
      best = { id: ep.id, similarity };
    }
  }
  return best ? { id: best.id, match: "near", similarity: best.similarity } : null;
}

/**
 * Build the dedupe window: the most recent `limit` episodes of one project.
 * Episodes without a project count as "unknown" (the value addEpisode stores
 * when no project is supplied), so callers can pass the raw project they
 * derived once and get a consistent comparison.
 */
export function selectRecentEpisodes<T extends { project?: string }>(
  episodes: readonly T[],
  project: string | undefined,
  limit: number = DEDUPE_WINDOW,
): T[] {
  const wanted = project && project.trim().length > 0 ? project : "unknown";
  const sameProject = episodes.filter((ep) => (ep.project ?? "unknown") === wanted);
  return sameProject.slice(-limit);
}

// ── The decision predicate ───────────────────────────────────────────────────

export type WriteDecision =
  | { action: "accept" }
  | { action: "repair"; solution: string; reason: string }
  | { action: "skip-dup"; existingId: string; match: "exact" | "near"; similarity: number }
  | { action: "reject"; reason: string };

export interface DecideWriteInput {
  site: WriteGateSite;
  task: string;
  solution: string;
  /** Tool names already executed (evidence that a task-only record carries signal). */
  toolSequence?: readonly string[];
  /** Dedupe window — pass selectRecentEpisodes(state.episodes, project). */
  recent?: readonly EpisodeLike[];
}

/**
 * Review-before-write decision for one episode candidate.
 *
 * Per-site policy:
 *   - all sites: reject a placeholder/short task (L0), skip duplicates (L2).
 *   - heartbeat: both-fields rule — a dead solution rejects (mirrored here;
 *     the call site keeps its cooldown-carrying shouldWriteOutcomeEpisode).
 *   - every other site: a dead solution is repaired from the tool sequence
 *     (what actually ran) when at least three tools ran, otherwise rejected.
 *   - reasoningChains: summary must reach REASONING_SUMMARY_MIN_CHARS.
 *
 * Pure: no clock, no store access, no logging. The caller owns state and
 * decides how to surface skip-duplicate/reject decisions.
 */
export function decideWrite(input: DecideWriteInput): WriteDecision {
  const { site, task, solution } = input;
  const toolSequence = input.toolSequence ?? [];
  const recent = input.recent ?? [];

  // L0 — placeholder/short tasks never enter the store.
  if (!hasSignal(task)) {
    return {
      action: "reject",
      reason: "task carries no signal (placeholder or shorter than 15 chars)",
    };
  }

  // Site floor: fragments below this length are not storable reasoning.
  if (site === "reasoningChains" && solution.trim().length < REASONING_SUMMARY_MIN_CHARS) {
    return {
      action: "reject",
      reason: `reasoning summary shorter than ${REASONING_SUMMARY_MIN_CHARS} chars`,
    };
  }

  // L1 — dead solution field: never store the dead template. The repaired
  // field carries what actually ran (the tool sequence); without tool
  // evidence there is nothing honest to populate it with, so the candidate
  // is rejected instead of storing a task-echo (a task-equal solution fed
  // duplicate groups and made the same two episodes win every recall).
  let effectiveSolution = solution;
  let repaired = false;
  if (!hasSignal(solution)) {
    if (site === "heartbeat") {
      return {
        action: "reject",
        reason: "solution carries no signal (heartbeat keeps the both-fields rule)",
      };
    }
    const fromTools = repairFromToolSequence(toolSequence);
    if (fromTools) {
      effectiveSolution = fromTools;
      repaired = true;
    } else {
      return {
        action: "reject",
        reason: "solution carries no signal and no evidence (needs >= 3 tools)",
      };
    }
  }

  // L2 — duplicates (exact pair or same task, 20-entry window).
  const dup = findDuplicateEpisode(recent, task, effectiveSolution);
  if (dup) {
    return { action: "skip-dup", existingId: dup.id, match: dup.match, similarity: dup.similarity };
  }

  return repaired
    ? {
        action: "repair",
        solution: effectiveSolution,
        reason: "dead solution field repaired from tool sequence",
      }
    : { action: "accept" };
}

// ── Applying the gate at a write site ────────────────────────────────────────

/**
 * Whether the gate is active for a site: globally enabled and not opted out.
 * `sites.<site> === false` restores pre-gate behavior for that writer.
 */
export function isGateActive(cfg: MemoryWriteGateConfig, site: WriteGateSite): boolean {
  if (!cfg.enabled) return false;
  return cfg.sites?.[site] !== false;
}

export type GateOutcome =
  | { write: true; solution: string; decision: WriteDecision }
  | { write: false; decision: WriteDecision };

/** One-line description of a decision, for the caller's logs. */
export function describeWriteDecision(decision: WriteDecision): string {
  switch (decision.action) {
    case "accept":
      return "accepted";
    case "repair":
      return `repaired (${decision.reason})`;
    case "skip-dup":
      return `skipped duplicate of ${decision.existingId} (${decision.match}, similarity ${decision.similarity.toFixed(2)})`;
    case "reject":
      return `rejected (${decision.reason})`;
  }
}

/**
 * Apply the gate config to one write candidate. Pure; the caller logs the
 * decision and acts on the outcome.
 *
 *   - gate off (enabled=false or this site opted out) → write the original
 *     field values; prior behavior.
 *   - mode "warn" → observation mode: the decision is returned for logging,
 *     but the write proceeds unchanged, so a rollout can be measured before
 *     it is enforced.
 *   - mode "enforce" → repair rewrites the solution field; reject/skip-dup
 *     suppress the write.
 */
export function applyWriteGate(cfg: MemoryWriteGateConfig, input: DecideWriteInput): GateOutcome {
  if (!isGateActive(cfg, input.site)) {
    return { write: true, solution: input.solution, decision: { action: "accept" } };
  }
  const decision = decideWrite(input);
  if (cfg.mode === "warn") {
    return { write: true, solution: input.solution, decision };
  }
  switch (decision.action) {
    case "accept":
      return { write: true, solution: input.solution, decision };
    case "repair":
      return { write: true, solution: decision.solution, decision };
    case "skip-dup":
    case "reject":
      return { write: false, decision };
  }
}

// ── Heartbeat outcome sender (existing gate) ─────────────────────────────────

/**
 * The review-before-write decision for the heartbeat session_outcome sender.
 *
 * Pure (no hidden state): `lastWriteAt` is owned by the caller, which stamps
 * it on a successful write — same pattern as context-manager/compaction.ts.
 *
 *   - enabled=false (or the heartbeat site opted out) → PRIOR behavior
 *     unchanged: only the literal `session_outcome` sentinel kill, no cooldown.
 *   - enabled=true → hasSignal tripwire (isWriteWorthy) AND cooldown
 *     (at most one gated write per cooldownMs).
 */
export function shouldWriteOutcomeEpisode(
  cfg: MemoryWriteGateConfig,
  task: string,
  solution: string,
  lastWriteAt: number,
  now: number = Date.now(),
): boolean {
  // Gate OFF / site opt-out: reproduce the pre-gate behavior (literal sentinel kill).
  if (!isGateActive(cfg, "heartbeat")) return task !== "session_outcome";
  // Cooldown: never write faster than one episode per cooldownMs.
  if (now - lastWriteAt < cfg.cooldownMs) return false;
  return isWriteWorthy(task, solution);
}
