/**
 * Nudge Trigger Predicates — shared trigger logic for whisper/nudge systems.
 *
 * Both enforcement (turn-end-handler) and nudge (nudge/index.ts) modules
 * evaluate similar conditions (scratchpad needed? think needed? memory needed?).
 * These predicates eliminate duplicated trigger logic so that widening a trigger
 * (e.g., scratchpad now fires on complex turns, not just file changes) happens
 * in ONE place.
 *
 * Each predicate returns a reason string if the nudge should fire, or null if not.
 */

// ── Scratchpad ────────────────────────────────────────────────────────────────

export interface ScratchpadContext {
  /** Tools called this turn */
  toolsThisTurn: string[];
  /** Whether scratchpad was called this turn */
  scratchpadUsed: boolean;
  /** Current turn number */
  currentTurn: number;
  /** Last turn scratchpad nudge was sent */
  lastScratchpadNudgeTurn: number;
  /** Whether errors occurred this turn */
  hadErrors: boolean;
  /** Whether in overflow recovery grace period */
  inOverflowRecovery: boolean;
  /** Minimum cooldown for file-change-based trigger (tighter) */
  fileChangeCooldown?: number;
  /** Minimum cooldown for complexity-based trigger (relaxed) */
  complexityCooldown?: number;
}

export function shouldNudgeScratchpad(s: ScratchpadContext): string | null {
  if (s.hadErrors || s.inOverflowRecovery) return null;
  if (s.scratchpadUsed) return null;

  const madeFileChanges = s.toolsThisTurn.some((t) =>
    ["edit", "write"].includes(t),
  );
  const isComplexTurn = s.toolsThisTurn.length >= 3;

  if (!madeFileChanges && !isComplexTurn) return null;

  const cooldown = madeFileChanges
    ? (s.fileChangeCooldown ?? 8)
    : (s.complexityCooldown ?? 15);

  if (s.currentTurn - s.lastScratchpadNudgeTurn < cooldown) return null;

  return madeFileChanges
    ? "Code changed without updating scratchpad"
    : `Complex turn (${s.toolsThisTurn.length} tools) without scratchpad tracking`;
}

// ── Think ─────────────────────────────────────────────────────────────────────

export interface ThinkContext {
  /** Whether think() was ever called this session */
  noThinkThisSession: boolean;
  /** Current turn number */
  currentTurn: number;
  /** Tools called this turn */
  toolsThisTurn: string[];
  /** Tuns since last think() call */
  turnsSinceThink?: number;
  /** Config: turns threshold for periodic reminder */
  thinkEnforcementTurns?: number;
  /** Whether errors occurred this turn */
  hadErrors: boolean;
  /** Whether in overflow recovery grace period */
  inOverflowRecovery: boolean;
}

export function shouldNudgeThink(s: ThinkContext): string | null {
  if (s.hadErrors || s.inOverflowRecovery) return null;

  const madeHighStakesAction = s.toolsThisTurn.some((t) =>
    ["edit", "write", "finalize"].includes(t),
  );

  // Condition A: no think ever called + high-stakes action at turn 3+
  if (madeHighStakesAction && s.noThinkThisSession && s.currentTurn >= 3) {
    return "High-stakes action without prior think(). Consider think(observation, decision, reason) before the next change.";
  }

  // Condition B: periodic reminder every 5 turns when think never called
  if (s.noThinkThisSession && s.currentTurn >= 5 && s.currentTurn % 5 === 0) {
    return `${s.currentTurn} turns without think() — consider think(observation, decision, reason) to track reasoning`;
  }

  // Condition C: turns since think exceeded config threshold
  if (
    s.thinkEnforcementTurns &&
    s.thinkEnforcementTurns > 0 &&
    s.turnsSinceThink !== undefined &&
    s.turnsSinceThink >= s.thinkEnforcementTurns &&
    !s.noThinkThisSession
  ) {
    return `${s.turnsSinceThink} turn(s) since think() was called. Use think() to track reasoning.`;
  }

  return null;
}

// ── Memory Store ──────────────────────────────────────────────────────────────

export interface MemoryContext {
  /** Whether code changes were made this session */
  hasCodeChanges: boolean;
  /** Turns since last memory store */
  turnsSinceMemory: number;
  /** Whether memory nudge was already sent */
  memoryNudgeSent: boolean;
  /** Minimum turns between memory nudges */
  memoryInterval?: number;
  /** Whether errors occurred this turn */
  hadErrors: boolean;
  /** Whether in overflow recovery grace period */
  inOverflowRecovery: boolean;
}

export function shouldNudgeMemory(s: MemoryContext): string | null {
  if (s.hadErrors || s.inOverflowRecovery) return null;
  if (!s.hasCodeChanges) return null;
  if (s.memoryNudgeSent) return null;

  const interval = s.memoryInterval ?? 20;
  if (s.turnsSinceMemory < interval) return null;

  return (
    "Code changed but nothing stored. Capture the key pattern or fix: " +
    'memory_store(content="...", tags=["pattern", "fix"])'
  );
}

// ── Context Usage ─────────────────────────────────────────────────────────────

export interface ContextUsageContext {
  /** Context usage percentage (0-100) */
  usagePercent: number;
  /** Absolute token count */
  usageTokens: number;
  /** Turns since last context check */
  turnsSinceLastCheck: number;
  /** Whether context nudge was already sent */
  contextNudgeSent: boolean;
  /** Token-check interval (tighter, for early warnings) */
  tokenCheckInterval?: number;
  /** Percentage-check interval (longer, for critical warnings) */
  percentCheckInterval?: number;
}

export interface ContextNudgeResult {
  message: string;
  /** Whether this consumes the nudge-sent flag */
  consume: boolean;
}

export function shouldNudgeContext(s: ContextUsageContext): ContextNudgeResult | null {
  if (s.contextNudgeSent) return null;

  // Token-count check (tighter interval, fires earlier)
  const tokenInterval = s.tokenCheckInterval ?? 8;
  if (s.turnsSinceLastCheck >= tokenInterval && s.usageTokens > 0) {
    if (s.usageTokens >= 75_000) {
      return {
        message:
          `Context at ${Math.round(s.usageTokens / 1000)}K tokens ` +
          `(${Math.round(s.usagePercent)}%). Pipeline: context_tag → ` +
          `context_checkout → context_archive → compact (last resort).`,
        consume: true,
      };
    }
    if (s.usageTokens >= 30_000) {
      return {
        message:
          `Context at ${Math.round(s.usageTokens / 1000)}K tokens. ` +
          `Consider pruning old tool results (context_prune dry-run) or tagging position.`,
        consume: true,
      };
    }
  }

  // Percentage check (original, longer interval)
  const percentInterval = s.percentCheckInterval ?? 21;
  if (s.turnsSinceLastCheck >= percentInterval && s.usagePercent > 0) {
    if (s.usagePercent >= 80) {
      return {
        message:
          `Context at ${Math.round(s.usagePercent)}%. Pipeline: context_tag → ` +
          `context_checkout → context_archive → compact (last resort). Tag your position first.`,
        consume: true,
      };
    }
    if (s.usagePercent >= 75) {
      return {
        message:
          `Context at ${Math.round(s.usagePercent)}%. Tag with context_tag, ` +
          `then context_checkout to branch with a summary.`,
        consume: true,
      };
    }
  }

  return null;
}
