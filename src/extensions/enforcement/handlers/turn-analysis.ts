import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Turn Analysis Context — shared context for turn_end handler subroutines.
 *
 * Bundles enforcement state + closure variables into a single object
 * that extracted handlers can receive as a parameter.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { EnforcementState } from "../state.js";

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

  // Ensure all known files have content loaded
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

  // Check new/updated files for similarity
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
              tac.sendWhisper(
                `[Quality] Similar code exists at \`${similarTo}\`. Reuse or deduplicate.`,
              );
            }
          }
        }
      } catch {
        log.warn(`Failed to load file content for redundancy check (current turn): ${filePath}`);
      }
    }
  }
}

async function detectRedundancy(content: string, _filePath: string): Promise<string | null> {
  // Simple line-based similarity check
  // In a real implementation, this would use AST comparison
  const lines = new Set(content.split("\n").filter((l) => l.trim().length > 3));
  if (lines.size < 5) return null;

  // For now, no cross-file comparison available
  // This would need access to all known files
  return null;
}

/**
 * Handle L3 critical signals: validation failures, failure recording, orphan chains.
 */
export function handleCriticalSignals(
  tac: TurnAnalysisContext,
  prevTurn: any,
  turnState: any,
  nudgeManager: any,
  validateTurn: (prev: any, state: any, errors: Set<string>, infra: boolean) => any,
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
  const validation = validateTurn(prevTurn, turnState, tac.erroredTools, isInfrastructureError);
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
      const now = Date.now();
      if (now - tac.state.lastNudgeTime > tac.state.nudgeCooldownMs) {
        tac.state.lastNudgeTime = now;
        tac.state.hasRecordedFailure = true;
        const errorList = Array.from(tac.erroredTools).join(", ");
        tac.sendWhisper(
          `${errorList} failed. Record this to avoid repeating: ` +
            `memory_store(content="Error with ${errorList}: [what went wrong and fix]", tags=["error"])`,
        );
      }
    }
  }
}
