/**
 * Turn End Handler - main enforcement loop.
 *
 * Fires on turn_end: error burst detection, context overflow, redundancy,
 * critical signals, orphan chain detection, claim tracking, L2 signal bundling.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { detectMissingVerification, recordCodeChange } from "../detection/verification.js";
import {
  type TurnAnalysisContext,
  detectRedundancySignal,
  handleCriticalSignals,
} from "./turn-analysis.js";
import { detectOrphanChains } from "./orphan-chains.js";
import { getNudgeManager, type NudgeType } from "../nudge-manager.js";
import {
  getState,
  ERROR_BURST_THRESHOLD,
  RECOVERY_GRACE_TURNS,
  shouldNudgeForMemory,
  markMemoryNudgeSent,
} from "../state.js";
import {
  recordNudgeSuppressed,
  getNudgeAnalytics,
} from "../../../lib/reasoning/nudge-analytics.js";
import {
  recordTurnEnd,
  detectToolLoop,
  getToolLoopState,
  markLoopFired,
} from "../../../lib/detection/tool-loop-detector.js";
import { getStopReason, getMessageContent } from "../../../lib/state/extension-state.js";
import { type TurnState } from "../types.js";
import { validateTurn } from "../validation.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { knownFiles, loadFileContent } from "../similarity.js";
import { enforcementSignals, pruneSignals, SIGNAL_KEYS } from "../signals.js";

const log = createLogger("enforcement:turn-end");

// L2 sub-signals with a dedicated NudgeType use the
// type's own cooldown (memory: 45s, scratchpad: 60s, context: 90s).
// Sub-signals without a dedicated type fall through to `sessionSignals`
// with the subKey distinguishing them (think, localization).
const L2_NUDGE_TYPE: Record<string, { type: NudgeType; subKey?: string }> = {
  "memory": { type: "memory" },
  "scratchpad": { type: "scratchpad" },
  "context-tokens": { type: "context", subKey: "tokens" },
  "context-percent": { type: "context", subKey: "percent" },
  "think": { type: "sessionSignals", subKey: "think" },
  "startup": { type: "sessionSignals", subKey: "startup" },
  "finalize": { type: "sessionSignals", subKey: "finalize" },
  "verify": { type: "sessionSignals", subKey: "verify" },
};

function nudgeTypeForKey(key: string): { type: NudgeType; subKey?: string } {
  return L2_NUDGE_TYPE[key] ?? { type: "sessionSignals", subKey: key };
}

export async function dispatchTurnEndLoop(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
): Promise<void> {
  if (!getState(ctx).enforcementActive) return;

  const actualTools: string[] = (event.toolResults || [])
    .map((r: any) => r.toolName)
    .filter((name: string) => name && name.trim().length > 0);
  const erroredTools: Set<string> = new Set(
    (event.toolResults || [])
      .filter((r: any) => r.isError && r.toolName && r.toolName.trim().length > 0)
      .map((r: any) => r.toolName),
  );
  const hadErrors = erroredTools.size > 0;

  // Natural-stop tracking
  // Records whether this turn was a natural agent stop: assistant final
  // response with stopReason "stop" and no tool calls. The session_compact
  // re-orientation whisper reads this to decide whether a post-compaction
  // wake is needed — a natural stop must NOT be woken with triggerTurn:true
  // (that is the forced-turn noise the user flagged); only mid-work turns
  // (tool calls or a non-"stop" stopReason) get the wake. Cleared on
  // turn_start (handler-registry.ts) so a re-prompt after a natural stop
  // does not carry a stale classification into a mid-work compaction.
  getState(ctx).lastTurnWasNaturalStop =
    event.message.role === "assistant" &&
    getStopReason(event.message) === "stop" &&
    actualTools.length === 0;

  // Tool output extraction (for verification judge)
  // Every tool result gets an entry prefixed with [OK] or [FAIL] so the
  // judge can verify exit status without regex-parsing truncated output.
  // - Success with output:  `bash [OK]: 42 passed, 0 failed`
  // - Success with no stdout: `bash [OK]: (no output)`
  // - Failure:              `bash [FAIL]: Error: can't find ...`
  const toolOutputs: string[] = [];
  const MAX_OUTPUT_CHARS = 300;
  for (const r of event.toolResults || []) {
    const status = r.isError ? "FAIL" : "OK";
    const outputText = (r.content || [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (outputText) {
      const truncated =
        outputText.length > MAX_OUTPUT_CHARS
          ? outputText.slice(0, MAX_OUTPUT_CHARS) + "..."
          : outputText;
      toolOutputs.push(`${r.toolName} [${status}]: ${truncated}`);
    } else {
      toolOutputs.push(`${r.toolName} [${status}]: (no output)`);
    }
  }

  // Error burst detection
  if (hadErrors) {
    const state = getState(ctx);
    state.consecutiveErrorTurns++;
    if (state.consecutiveErrorTurns === ERROR_BURST_THRESHOLD) {
      sendEnforcementWhisper(
        pi,
        ctx,
        `Error burst detected: ${state.consecutiveErrorTurns} consecutive errors. Consider stepping back.`,
        true, // critical - needs agent response
      );
    }
  } else {
    getState(ctx).consecutiveErrorTurns = 0;
  }
  const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;

  // Tool loop detection (per-turn tool sets)
  if (!isBurst) {
    const loopState = getToolLoopState(ctx);
    recordTurnEnd(loopState);
    const loopResult = detectToolLoop(loopState);
    if (loopResult.isLoop) {
      markLoopFired(loopState);
      // Tool-loop whispers must NOT force a continuation turn: the whisper is
      // delivered as the park class, which keeps the violation event for
      // MARS/analytics but records the warning for the turn's end instead of
      // steering. Without this, a tool-loop whisper
      // creates turn N+1, which also loops, creating turn N+2 — a cascade
      // that inflates the turn count and floods the session. The agent sees
      // the warning on its next natural turn.
      sendEnforcementWhisper(pi, ctx, loopResult.message, true, { delivery: "park" });
    }
  }

  // Context overflow detection
  const msgContent = getMessageContent(event.message);
  const isOverflowTurn =
    event.message.role === "assistant" &&
    "stopReason" in event.message &&
    getStopReason(event.message) === "error" &&
    msgContent
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text || "")
      .join(" ")
      .toLowerCase()
      .includes("context") &&
    msgContent
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text || "")
      .join(" ")
      .toLowerCase()
      .includes("overflow");

  if (isOverflowTurn) {
    getState(ctx).overflowRecently = getState(ctx).currentTurn;
  }

  // Code change tracking
  if (actualTools.some((t: string) => ["edit", "write"].includes(t))) {
    recordCodeChange(getState(ctx).currentTurn, ctx);
  }

  if (!isBurst) {
    detectMissingVerification(pi, ctx, getState(ctx).currentTurn);
  }

  const scratchpadUpdated = actualTools.includes("scratchpad");
  if (scratchpadUpdated) {
    getState(ctx).lastScratchpadNudgeTurn = -100;
  }

  const memoryUpdated = actualTools.some((t: string) => ["memory_store", "memory"].includes(t));

  // Truth-seeking trigger: verify_claim/conflict_qa usage
  // MI-2: When the agent uses verification tools, briefly surface TRUTH-SEEKING
  // mode explicitly, confirming the correct epistemic stance.
  const truthTools = actualTools.filter((t: string) => ["verify_claim", "conflict_qa"].includes(t));
  if (truthTools.length > 0) {
    enforcementSignals[SIGNAL_KEYS.truth_seeking_trigger] = {
      turn: getState(ctx).currentTurn,
      text: `Truth-seeking triggered by ${truthTools.join(", ")}`,
      acted: true,
    };
  }

  if (memoryUpdated && enforcementSignals[SIGNAL_KEYS.unpersisted_learnings]) {
    delete enforcementSignals[SIGNAL_KEYS.unpersisted_learnings];
  }

  if (!memoryUpdated) {
    if (actualTools.length > 0 && !hadErrors) {
      getState(ctx).turnsSinceMemory++;
    }
  } else {
    getState(ctx).turnsSinceMemory = 0;
  }

  // Turn state recording
  const turnState: TurnState = {
    turnIndex: getState(ctx).currentTurn,
    plannedTools: [],
    actualTools,
    toolOutputs,
    scratchpadUpdated,
    memoryUpdated,
    sequenceRepetitionCount: 0,
    thinkCalledBeforeEdit: getState(ctx).toolChain.lastThinkCall >= getState(ctx).currentTurn - 2,
    planCalledForBugFix: getState(ctx).toolChain.lastPlanCall >= getState(ctx).currentTurn - 3,
  };

  getState(ctx).turnHistory.set(getState(ctx).currentTurn, turnState);
  if (getState(ctx).turnHistory.size > 50) {
    const oldest = Math.min(...getState(ctx).turnHistory.keys());
    getState(ctx).turnHistory.delete(oldest);
  }

  // Redundancy detection
  if (actualTools.some((t: string) => ["edit", "write"].includes(t))) {
    const tac: TurnAnalysisContext = {
      pi,
      ctx,
      state: getState(ctx),
      event: {
        role: event.message.role,
        stopReason: getStopReason(event.message),
      },
      actualTools,
      erroredTools,
      hadErrors,
      knownFiles,
      enforcementSignals,
      sendWhisper: (msg) => sendEnforcementWhisper(pi, ctx, msg),
      loadFileContent,
    };
    if (!isBurst) {
      await detectRedundancySignal(tac);
    }
  }

  // L3: Critical signals
  const prevTurn = getState(ctx).turnHistory.get(getState(ctx).currentTurn - 1);
  const tac: TurnAnalysisContext = {
    pi,
    ctx,
    state: getState(ctx),
    event: {
      role: event.message.role,
      stopReason: getStopReason(event.message),
    },
    actualTools,
    erroredTools,
    hadErrors,
    knownFiles,
    enforcementSignals,
    sendWhisper: (msg) => sendEnforcementWhisper(pi, ctx, msg),
    loadFileContent,
  };
  handleCriticalSignals(tac, prevTurn, turnState, getNudgeManager(ctx), validateTurn);

  // Orphan thought chain detection
  const orphanResult = detectOrphanChains(getState(ctx));
  if (!isBurst && orphanResult) {
    sendEnforcementWhisper(pi, ctx, orphanResult.suggestion);
  }

  // L2: Session Signals bundling

  const abVariant = getNudgeAnalytics(ctx).abVariant;
  const suppressNudges = abVariant === "no_nudges";
  if (suppressNudges) {
    const count = (getState(ctx).nudgeSuppressedCount || 0) + 1;
    getState(ctx).nudgeSuppressedCount = count;
    recordNudgeSuppressed(ctx);
    if (count === 1) {
      log.debug("Nudge suppression active - L2 signals will be collected but not delivered");
    }
    // Surface the count to the TUI every 5 suppressions
    if (count % 5 === 0) {
      try {
        ctx.ui.setStatus("nudge-suppressed", `${count}`);
      } catch {
        /* TUI not available */
      }
    }
  }

  // Each L2 session signal carries its own subKey so per-signal cooldowns
  // and dedup are independent — adding or removing a signal never re-arms
  // the others.
  const sessionSignals: { key: string; content: string }[] = [];

  // Memory signal
  const inOverflowRecovery =
    getState(ctx).currentTurn - getState(ctx).overflowRecently < RECOVERY_GRACE_TURNS;

  // D-57: memory usage is a static instruction — covered by memory_store tool description
  // and MEMORY_AWARENESS system prompt. Keep the state counter for analytics but
  // suppress the repetitive whisper.
  if (
    !hadErrors &&
    !inOverflowRecovery &&
    shouldNudgeForMemory(getState(ctx), getState(ctx).currentTurn, 20)
  ) {
    markMemoryNudgeSent(getState(ctx));
    // whisper suppressed — instruction lives in tool description
  }

  // Scratchpad signal - widened: fires on (a) write/edit without scratchpad,
  // or (b) complex turn (3+ tools) without scratchpad
  const madeFileChanges = actualTools.some((t: string) => ["edit", "write"].includes(t));
  const isComplexTurn = actualTools.length >= 3;
  const needsScratchpad = (madeFileChanges || isComplexTurn) && !scratchpadUpdated;
  // D-57: scratchpad usage is a static instruction — covered by scratchpad tool description.
  // Keep cooldown tracking for potential future use but suppress the repetitive whisper.
  if (!hadErrors && !inOverflowRecovery && needsScratchpad) {
    const cooldown = madeFileChanges ? 8 : 15;
    if (getState(ctx).currentTurn - getState(ctx).lastScratchpadNudgeTurn >= cooldown) {
      getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
      // whisper suppressed — instruction lives in tool description
    }
  }

  // Planning signal: tool calls without scratchpad goal at any turn.
  // Increments toolsSinceLastPlan when the agent makes tool calls without
  // setting a scratchpad goal. Resets when scratchpad is used.
  if (!hadErrors && !inOverflowRecovery && actualTools.length > 0) {
    if (scratchpadUpdated) {
      getState(ctx).toolsSinceLastPlan = 0;
    } else {
      // Only increment if the agent actually did work (not just read/ls)
      const workTools = actualTools.filter(
        (t: string) => !["read", "ls", "grep", "find", "memory"].includes(t),
      );
      if (workTools.length > 0) {
        getState(ctx).toolsSinceLastPlan += 1;
      }
    }
  }

  // Think tool enforcement - session level: fires on (a) no think ever called by turn 5,
  // or (b) high-stakes actions (edit/write/finalize) without prior think this session
  const madeHighStakesAction = actualTools.some((t: string) =>
    ["edit", "write", "finalize"].includes(t),
  );
  const noThinkThisSession = getState(ctx).toolChain.lastThinkCall === 0;
  const thinkNeeded =
    (noThinkThisSession && getState(ctx).currentTurn >= 5 && getState(ctx).currentTurn % 5 === 0) ||
    (madeHighStakesAction && noThinkThisSession && getState(ctx).currentTurn >= 3);
  // D-57: think usage is a static instruction — covered by think tool description
  // ("Required before editing, writing files, or making high-stakes changes").
  // Keep the detection logic for potential analytics but suppress the whisper.
  if (!hadErrors && !inOverflowRecovery && thinkNeeded) {
    // whisper suppressed — instruction lives in tool description
  }

  // Per-turn think-before-edit enforcement
  // Fires when edit/write is used in this turn but think was NOT called in this turn.
  // Uses a 3-turn cooldown (faster than the session-level 5-turn check above).
  if (!hadErrors && !inOverflowRecovery && getState(ctx).currentTurn >= 2) {
    const madeEditThisTurn = actualTools.some((t: string) => ["edit", "write"].includes(t));
    const thinkCalledThisTurn = getState(ctx).toolChain.lastThinkCall === getState(ctx).currentTurn;
    if (madeEditThisTurn && !thinkCalledThisTurn) {
      const perTurnCooldown = 3;
      if (getState(ctx).currentTurn - getState(ctx).lastThinkPerTurnNudge >= perTurnCooldown) {
        getState(ctx).lastThinkPerTurnNudge = getState(ctx).currentTurn;
        // D-57: per-turn think whisper suppressed — instruction lives in tool description
      }
    }
  }

  // Finalize enforcement
  // Fires when a turn has significant work (edit/write, or plans marked done)
  // but finalize was not called. Uses a 5-turn cooldown.
  if (!hadErrors && !inOverflowRecovery && getState(ctx).currentTurn >= 3) {
    const hasCompletionWork = actualTools.some((t: string) =>
      ["edit", "write", "finalize"].includes(t),
    );
    const calledFinalize = actualTools.includes("finalize");
    if (hasCompletionWork && !calledFinalize) {
      const finalizeCooldown = 5;
      if (getState(ctx).currentTurn - getState(ctx).lastFinalizeNudge >= finalizeCooldown) {
        getState(ctx).lastFinalizeNudge = getState(ctx).currentTurn;
        // D-57: finalize whisper suppressed — instruction lives in tool description
      }
    }
  }

  // Fires when code was changed (edit/write) but verify was not called in the same turn.
  // Uses a 5-turn cooldown.
  if (!hadErrors && !inOverflowRecovery) {
    const madeCodeChange = actualTools.some((t: string) => ["edit", "write"].includes(t));
    const calledVerify = actualTools.some((t: string) => ["verify", "verify_claim"].includes(t));
    if (madeCodeChange && !calledVerify) {
      const verifyCooldown = 5;
      if (getState(ctx).currentTurn - getState(ctx).lastVerifyNudge >= verifyCooldown) {
        getState(ctx).lastVerifyNudge = getState(ctx).currentTurn;
        // D-57: verify whisper suppressed — instruction lives in tool description
      }
    }
  }

  // Phase-aware enforcement: detect investigation→implementation transition
  // When the agent has been investigating (read/grep/find/etc.) for 3+ consecutive
  // turns and then switches to implementation (edit/write) without tagging position
  // or finalizing, fire a phase-boundary whisper.
  const INVESTIGATION_TOOLS = new Set([
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "fetch_content",
    "browser_navigate",
    "describe_image",
    "document_parse",
    "document_search",
    "document_screenshot",
    "codebase",
  ]);
  const IMPLEMENTATION_TOOLS = new Set(["edit", "write"]);
  const PHASE_TOOLS = new Set(["context_navigate", "context_compress", "finalize"]);

  const usedInvestigation = actualTools.some((t) => INVESTIGATION_TOOLS.has(t));
  const usedImplementation = actualTools.some((t) => IMPLEMENTATION_TOOLS.has(t));
  const usedPhaseTool = actualTools.some((t) => PHASE_TOOLS.has(t));

  if (usedInvestigation) {
    getState(ctx).lastInvestigationToolTurn = getState(ctx).currentTurn;
    getState(ctx).consecutiveInvestigationTurns++;
  } else {
    getState(ctx).consecutiveInvestigationTurns = 0;
  }

  // Detect transition: was investigating for 3+ turns, now implementing,
  // and hasn't used a phase management tool recently.
  // Skip for simple tasks to avoid noise.
  if (
    !hadErrors &&
    !inOverflowRecovery &&
    usedImplementation &&
    !usedPhaseTool &&
    getState(ctx).consecutiveInvestigationTurns >= 3 &&
    getState(ctx).taskComplexity !== "simple"
  ) {
    const phaseCooldown = 8;
    if (getState(ctx).currentTurn - getState(ctx).lastPhaseNudgeTurn >= phaseCooldown) {
      getState(ctx).lastPhaseNudgeTurn = getState(ctx).currentTurn;
      sendEnforcementWhisper(
        pi,
        ctx,
        `**Phase transition detected:** You were investigating for ${getState(ctx).consecutiveInvestigationTurns} turns and are now implementing.\n\n` +
          `Tag your position first: \`context_navigate(action="tag", name="before-implementation")\`\n` +
          `Then archive the investigation: \`context_compress(action="archive", topic="investigation")\`\n` +
          `This preserves your investigation summary so you can navigate back to it later.`,
        true,
        { deliverAs: "nextTurn" },
      );
    }
  }

  // Context usage signal: the agent called one of the live context
  // management tools (context_inspect / context_compress / context_navigate /
  // context_proposals). Bump the last-check turn and clear the nudge flag so
  // the next threshold crossing can nudge again.
  const contextToolNames = new Set([
    "context_inspect",
    "context_compress",
    "context_navigate",
    "context_proposals",
  ]);
  if (actualTools.some((t) => contextToolNames.has(t))) {
    getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
    getState(ctx).contextNudgeSent = false;
  }

  // BV1: Surface localization risk
  if (getState(ctx).localizationRisk) {
    sessionSignals.push({
      key: "localization",
      content: `[localization] ${getState(ctx).localizationRisk}`,
    });
    getState(ctx).localizationRisk = "";
  }

  // Suppress L2 signals during an error burst — only the L2 `sessionSignals`
  // bundle freezes. L1 `enforcementSignals`, claim-tracker, verification judge,
  // and conflict detection keep firing (the narrower scope is deliberate, so
  // contributors do not assume broader suppression).
  if (isBurst) {
    sessionSignals.length = 0;
  }

  // Clean up stale enforcement signals (kept for cross-turn MARS readback)
  if (sessionSignals.length > 0) {
    pruneSignals(getState(ctx).currentTurn);

    // Only bundle and send if nudges are not suppressed. Per-signal gating:
    // each sub-signal has its own cooldown + dedup history keyed by `sig.key`,
    // and the bundle is built from only the signals that pass the gate —
    // adding a new signal does not re-arm previously-suppressed ones.
    if (!suppressNudges) {
      const nudgeManager = getNudgeManager(ctx);
      const unsent: string[] = [];
      for (const sig of sessionSignals) {
        const { type, subKey } = nudgeTypeForKey(sig.key);
        const { shouldSend } = nudgeManager.shouldSendNudge(type, sig.content, subKey);
        if (shouldSend) {
          unsent.push(sig.content);
        }
      }
      if (unsent.length > 0) {
        const bundled = `[Session Signals]\n${unsent.map((s) => `- ${s}`).join("\n")}`;
        sendEnforcementWhisper(pi, ctx, bundled);
      }
    }
  }
}
