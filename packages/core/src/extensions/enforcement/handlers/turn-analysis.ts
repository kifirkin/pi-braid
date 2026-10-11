import { createLogger } from "../../../lib/core/logger.js";
import { recordDriftSignal } from "../../../lib/telemetry/drift-signals.js";

const log = createLogger("enforcement");
/**
 * Turn Analysis Context - shared context for turn_end handler subroutines.
 *
 * Bundles enforcement state + closure variables into a single object
 * that extracted handlers can receive as a parameter.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EnforcementState } from "../state.js";
import { detectRedundancy } from "../similarity.js";

export interface TurnAnalysisContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: EnforcementState;
  event: {
    role: string;
    stopReason?: string;
  };
  actualTools: string[];
  erroredTools: Set<string>;
  hadErrors: boolean;
  knownFiles: Map<string, { content: string; turn: number }>;
  enforcementSignals: Record<string, { turn: number; text: string; acted: boolean }>;
  sendWhisper: (message: string) => void;
  loadFileContent: (path: string) => Promise<string | null>;
}

/**
 * Detect code redundancy when edit/write tools are used.
 * Checks new/updated files for >70% similarity to existing files.
 */
export async function detectRedundancySignal(tac: TurnAnalysisContext): Promise<void> {
  if (!tac.actualTools.some((t) => ["edit", "write"].includes(t))) return;

  for (const [filePath, entry] of tac.knownFiles) {
    if (!entry.content) {
      try {
        const loaded = await tac.loadFileContent(filePath);
        if (loaded !== null) {
          entry.content = loaded;
        }
      } catch {
        log.warn(`Failed to load file content for redundancy check: ${filePath}`);
      }
    }
  }

  for (const [filePath, entry] of tac.knownFiles) {
    if (entry.turn === tac.state.currentTurn && entry.content === "") {
      try {
        const loaded = await tac.loadFileContent(filePath);
        if (loaded !== null) {
          entry.content = loaded;
          const similarTo = await detectRedundancy(loaded, filePath);
          if (similarTo) {
            const now = Date.now();
            if (now - tac.state.lastNudgeTime > tac.state.nudgeCooldownMs) {
              tac.state.lastNudgeTime = now;
              tac.sendWhisper(`Similar code exists at \`${similarTo}\`. Reuse or deduplicate.`);
            }
          }
        }
      } catch {
        log.warn(`Failed to load file content for redundancy check (current turn): ${filePath}`);
      }
    }
  }
}

/**
 * Handle L3 critical signals: validation failures, failure recording, orphan chains.
 */
export function handleCriticalSignals(
  tac: TurnAnalysisContext,
  prevTurn: any,
  turnState: any,
  nudgeManager: any,
  validateTurn: (prev: any, state: any, ctx: any, errors: Set<string>, infra: boolean) => any,
): void {
  if (tac.erroredTools.size > 0) {
    tac.state.lastFailedToolTurn = tac.state.currentTurn;
  }

  // Infrastructure error detection
  const isInfrastructureError =
    tac.actualTools.length === 0 &&
    tac.event.role === "assistant" &&
    tac.event.stopReason === "error";

  // Validation failures
  const validation = validateTurn(
    prevTurn,
    turnState,
    tac.ctx,
    tac.erroredTools,
    isInfrastructureError,
  );
  if (!validation.passed && validation.nudge && !tac.hadErrors) {
    const { shouldSend, escalated } = nudgeManager.shouldSendNudge("validation", validation.nudge);
    if (shouldSend) {
      tac.sendWhisper(escalated ? `**Escalated:** ${validation.nudge}` : validation.nudge);
    }
  }

  // Failure recording nudge
  const FAILURE_THRESHOLD = 3;
  if (tac.erroredTools.size > 0 && !tac.state.hasRecordedFailure) {
    const turnsSinceError = tac.state.currentTurn - tac.state.lastFailedToolTurn;
    if (turnsSinceError >= FAILURE_THRESHOLD) {
      // Rate-limit via NudgeManager. The session-level
      // `hasRecordedFailure` flag remains (it ensures we tell the user
      // at most once per session). The NudgeManager cooldown (20s)
      // protects against firing too soon after a related nudge.
      const errorList = Array.from(tac.erroredTools).join(", ");
      const message =
        `${errorList} failed. Record this to avoid repeating: ` +
        `memory_store(content="Error with ${errorList}: [what went wrong and fix]", tags=["error"])`;
      const { shouldSend } = nudgeManager.shouldSendNudge("recordFailure", message);
      if (shouldSend) {
        tac.state.hasRecordedFailure = true;
        tac.sendWhisper(message);
      }
    }
  }

  // Lightweight integer increments into the shared drift accumulator when an
  // L3/validation signal looks like context drift (re-reads, stale/wrong file
  // paths, repeated failure on the same target). Detection uses data ALREADY
  // computed for this turn's validation/error pass - no new per-turn
  // heuristics, integer increments only. Goal-wording shift is recorded at its
  // source (drift-handler.ts) where the topic-drift classifier verdict lives.
  if (
    !validation.passed &&
    validation.issues.some((i: string) => /mostly reading|re-?read/i.test(i))
  ) {
    // Re-reads of previously-read files surfaced by the re-read-waste check.
    recordDriftSignal("rereads", tac.state.currentTurn);
  }
  if (tac.erroredTools.size > 0) {
    const pathTools = new Set(["read", "grep", "find", "ls", "edit", "write"]);
    // Stale/wrong file paths: a path-targeting tool errored this turn.
    if ([...tac.erroredTools].some((t) => pathTools.has(t))) {
      recordDriftSignal("stalePaths", tac.state.currentTurn);
    }
    // Repeated failure on the same target: an errored tool was also used last turn.
    const prevTools = (prevTurn?.actualTools as string[]) ?? [];
    if (prevTools.length > 0 && [...tac.erroredTools].some((t) => prevTools.includes(t))) {
      recordDriftSignal("repeatedFailures", tac.state.currentTurn);
    }
  }
}
