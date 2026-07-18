/**
 * Context Lifecycle Extension - S-MMU Active Context Management
 *
 * AUTOMATION layer that works WITH context-manager.
 * NO new tools - uses existing context_tag, context_archive, etc.
 *
 * R-CCAM-inspired loop:
 * - Retrieval: Signal detection from session content
 * - Cognition: Policy evaluation with governance
 * - Control: Action selection with constraint checking
 * - Action: Proposal injection or immediate execution
 * - Memory: CustomEntry persistence with outcome tracking
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager, AgentToolResult, AgentToolUpdateCallback, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { createLogger } from "../../../lib/core/logger.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState, getCachedSessionManager } from "../../../lib/state/extension-state.js";
import { getSessionManager } from "../../../lib/state/session-manager.js";
import { loadScratchpadFromDisk, projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";
import { handleUpdateSession } from "../../memory/scratchpad/handlers.js";
import type { SessionPhase as ScratchpadPhase } from "../../memory/scratchpad/types.js";
import { eventBus } from "../../../lib/events/event-bus.js";

import {
  createProposal,
  createSnapshot,
  isProposalEntry,
  PROPOSAL_CUSTOM_TYPE,
  SNAPSHOT_CUSTOM_TYPE,
  type ContextProposal,
} from "./types.js";
import {
  evaluatePolicies,
  type EvaluatedAction,
  generateDensitySignals,
} from "./policy-engine.js";
import {
  detectSignals,
  queueSignal,
  detectCompletionPattern,
} from "./signal-detector.js";

// ── Module State ─────────────────────────────────────────────────────────────

const log = createLogger("context-lifecycle");

// Re-entrancy guard for before_agent_start. Per-session so a stale
// 'true' from a crashed previous turn can't poison the next session.
// Prevents "Maximum call stack size exceeded" when pi.sendMessage(steer)
// triggers a synchronous before_agent_start that calls sendTrackedMessage again.
interface ReentrancyState { inBeforeAgentStart: boolean; }

// Proposal rate limiting
const MAX_PROPOSALS_PER_TURN = 2;
const MAX_PROPOSALS_SESSION = 10;

// ── Compaction Escalation Thresholds ────────────────────────────────────────────
// When the agent ignores 3+ compaction nudges at >=85% usage, auto-compact with timer.
const COMPACT_ESCALATION_THRESHOLD = 3;
const COMPACT_ESCALATION_USAGE = 85;

// Context management tools that count as "agent acted on compaction nudge"
const CONTEXT_MGMT_TOOLS = new Set([
  "context_compact",
  "context_prune",
  "context_archive",
  "context_snapshot",
  "context_audit",
  "context_proposals",
  "context_tag",
  "context_checkout",
]);

// Policy engine + signal-detector state are now per-session fields of
// ContextLifecycleState (see ./state.ts). The migration (DR-C-2,
// 2026-06-22) replaced the module-level singletons so each session
// starts with a fresh engine + detector. The fields are accessed via
// `state(ctx).policyEngine` and `state(ctx).detector`.

// Outcome tracking (closed-loop feedback) with TTL eviction - now session-scoped
const MAX_OUTCOMES = 100;
const OUTCOME_TTL_MS = 30 * 60 * 1000;

// Outcome interface now lives in ./state.ts (extracted to break the state<->helpers cycle)

function evictOldOutcomes(s: ContextLifecycleState): void {
  const now = Date.now();
  const before = s.outcomes.length;
  while (s.outcomes.length > 0 && now - s.outcomes[0].timestamp > OUTCOME_TTL_MS) {
    s.outcomes.shift();
  }
  while (s.outcomes.length > MAX_OUTCOMES) {
    s.outcomes.shift();
  }
  if (s.outcomes.length < before) {
    log.info(`Evicted ${before - s.outcomes.length} old outcomes`);
  }
}

// ── Session-scoped state (extracted to ./state.ts) ─────────────────────────
// Note: turn_end handlers in this module use the session-scoped getState(ctx)
// pattern to read the latest state. Module-level `state()` is the fallback
// when ctx is not available.
import {
  type ContextLifecycleState,
  state,
  resetState,
} from "./state.js";
// Note: state.ts types and functions are intentionally NOT re-exported.
// All consumers (this file, helpers.ts) access them via the import above.
// External callers should depend on `./state.js` directly if they need
// access to state types or functions. This removes the public-API surface
// area documented in DR-L-4 as dead code (zero external callers).

// ── Schema ───────────────────────────────────────────────────────────────────

const contextProposalsSchema = Type.Object({
  action: StringEnum(["list", "approve", "reject", "snapshots", "stats"]),
  id: Type.Optional(Type.String({ description: "Proposal ID to approve/reject" })),
});






// ── Helpers (extracted to ./helpers.ts) ───────────────────────────────────
import {
  getContextUsage,
  getContextTokens,
  getAllEntries,
  getBranchEntries,
  readProposalsFromSession,
  readSnapshotsFromSession,
  formatDuration,
  interpolateMessage,
} from "./helpers.js";
// Re-export for backward compat
export {
  getContextUsage,
  getContextTokens,
  getAllEntries,
  getBranchEntries,
  readProposalsFromSession,
  readSnapshotsFromSession,
  formatDuration,
  interpolateMessage,
} from "./helpers.js";

// ── Action Execution ─────────────────────────────────────────────────────────

/**
 * Send a compact nudge to the agent via tracked message.
 * Extracted from executeAction so the before_agent_start handler can also use it.
 */
function sendCompactNudge(pi: ExtensionAPI, evaluated: EvaluatedAction, usage: number): void {
  // Tag/branch is preferred over compaction - preserves session history
  // while freeing working context. Compact is the last resort.
  const pipelineMsg =
    usage >= 80
      ? `Context at ${Math.round(usage)}%. Pipeline: context_tag -> context_checkout -> context_archive -> compact (last resort).`
      : `Context at ${Math.round(usage)}%. Tag with context_tag, then context_checkout to branch with a summary.`;

  sendTrackedMessage(
    pi,
    {
      customType: "context-lifecycle",
      content: [
        {
          type: "text" as const,
          text: `[compact] ${evaluated.policy.name} - ${pipelineMsg}`,
        },
      ],
      display: true,
      details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "context-lifecycle/compact-suggestion" },
    },
    undefined,
    { type: "context" as const, source: "context-lifecycle/compact-suggestion" },
  );
  log.info(
    `Suggested compact: ${evaluated.policy.name} (context ${Math.round(usage)}%, ` +
      `priority ${evaluated.policy.priority})`,
  );
}

/**
 * Execute auto-compaction.
 * This is the escalation path: when the agent ignores compaction nudges,
 * we auto-trigger compaction. The agent loop automatically continues after
 * compaction completes (pi-core's _runAutoCompaction() returns `true` →
 * agent.continue()). No resume timer is needed.
 */
async function executeAutoCompact(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  try {
    // 1. Cancel stale resume timers from previous compaction cycles
    try {
      // Cancel any stale resume timer from a previous compaction cycle
      // (manual or auto). Without this, an old timer can fire later during
      // an unrelated TURN_END and produce a stray [timer] whisper.
      //
      // CRITICAL: scope to current session - see the timer module for why.
      // The old single-map design leaked across pi sessions.
      const sessionId =
        (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.() ??
        "anonymous";
      timerMod.cancelTimersByTag(sessionId, "compaction-resume");
      timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
      // NOTE: We do NOT call scheduleTimer() here. The compaction-resume
      // timer was removed in 2026-07-11 because pi-core's agent loop
      // automatically continues after compaction (_runAutoCompaction()
      // returns `true` → agent.continue()). The 3-minute fallback timer
      // was firing as spurious noise that the agent ignored.
    } catch {
      log.warn("Timer unavailable for auto-compaction - agent must type to resume");
    }

    // 2. Send visible notification
    sendTrackedMessage(
      pi,
      {
        customType: "context-lifecycle",
        content: [
          {
            type: "text" as const,
            text: [
              "## ⚡ Auto-compacting context",
              "Compaction nudges were ignored. Auto-tagging then compacting to prevent overflow.",
              "Use context_tag proactively next time to avoid losing the completion summary.",
            ].join("\n"),
          },
        ],
        display: true,
        details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "context-lifecycle/auto-compact" },
      },
      undefined,
      { type: "context" as const, source: "context-lifecycle/auto-compact" },
    );

    // 3. Trigger compaction (this aborts the agent loop, timer resumes later)
    ctx.compact();
    log.warn("Auto-compaction triggered (escalation path)");
  } catch (err) {
    log.error("Auto-compaction failed:", err);
  }
}

function executeAction(
  evaluated: EvaluatedAction,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  usage: number,
  branchLength: number,
): void {
  const action = evaluated.action;

  switch (action.type) {
    case "compact":
      if (evaluated.canExecute) {
        sendCompactNudge(pi, evaluated, usage);
      }
      break;

    case "snapshot":
      if (evaluated.canExecute) {
        const snapshot = createSnapshot(action.reason, branchLength, Math.round(usage * 2));
        const sm = getCachedSessionManager(ctx) as { appendCustomEntry?: (type: string, entry: unknown) => void } | undefined;
        sm?.appendCustomEntry?.(SNAPSHOT_CUSTOM_TYPE, snapshot);
        log.debug(`Created snapshot: ${snapshot.id}`);
      }
      break;

    case "nudge":
      if (evaluated.canExecute) {
        const msg = interpolateMessage(action.message, ctx, evaluated.signal?.data);
        // Non-critical context awareness - use hint, visible in TUI but no hidden turn
        sendTrackedMessage(
          pi,
          {
            customType: "context-lifecycle",
            content: [{ type: "text" as const, text: msg }],
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
          { type: "context", source: "context-lifecycle/nudge" },
        );
      }
      break;
  }
}

async function queueProposal(
  evaluated: EvaluatedAction,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  branchLength: number,
): Promise<void> {
  if (evaluated.action.type !== "propose") return;

  // ── Rate limiting: prevent proposal spam ────────────────────────────────
  state(ctx).proposalsThisTurn++;
  state(ctx).proposalsTotal++;
  if (state(ctx).proposalsThisTurn > MAX_PROPOSALS_PER_TURN) {
    log.debug(
      `Rate limited: ${state(ctx).proposalsThisTurn} proposals this turn (max ${MAX_PROPOSALS_PER_TURN})`,
    );
    return;
  }
  if (state(ctx).proposalsTotal > MAX_PROPOSALS_SESSION) {
    log.debug(
      `Session limit reached: ${state(ctx).proposalsTotal} proposals (max ${MAX_PROPOSALS_SESSION})`,
    );
    return;
  }

  const action = evaluated.action;
  const existingEntries = getAllEntries(ctx);
  const existingProposals = readProposalsFromSession(existingEntries);

  // Don't duplicate recent similar proposals
  const recentSame = existingProposals.find(
    (p) => p.message.includes(action.message.slice(0, 20)) && Date.now() - p.created_at < 60_000,
  );
  if (recentSame) return;

  const proposal = createProposal(
    "compact",
    interpolateMessage(action.message, ctx, evaluated.signal?.data),
    evaluated.policy.id,
    branchLength,
    action.priority,
    0.7,
  );

  const sm = getCachedSessionManager(ctx) as { appendCustomMessageEntry?: (type: string, entry: unknown, persistent: boolean, meta: unknown) => void } | undefined;
  sm?.appendCustomMessageEntry?.(
    PROPOSAL_CUSTOM_TYPE,
    [
      {
        type: "text" as const,
        text: `Context Suggestion: ${proposal.message}`,
      },
    ],
    true,
    proposal,
  );
  log.debug(`Created proposal: ${proposal.id}`);

  // ── Phase boundary enforcement: upgrade topic_shift and task_boundary
  // proposals to enforcement whispers with auto-tagging. This ensures the
  // agent preserves context before switching between investigation,
  // implementation, and verification phases.
  if (evaluated.signal?.type === "topic_shift" || evaluated.signal?.type === "task_boundary") {
    const signalType = evaluated.signal.type;
    const signalData = evaluated.signal.data || {};

    // Auto-tag current position
    let tagName = "";
    if (signalType === "topic_shift") {
      const to = (signalData.to as string) || "next-phase";
      tagName = `before-${to}`;
    } else {
      tagName = `before-task-boundary`;
    }

    try {
      const sessionManager = getSessionManager(ctx);
      const leafId = sessionManager.getLeafId();
      sessionManager.setLabel(leafId, tagName);
      log.info(`Auto-tagged position as "${tagName}" on ${signalType} signal`);
    } catch (err) {
      log.debug(`Auto-tag failed (non-fatal): ${err}`);
    }

    // Auto-set SessionPhase in scratchpad when topic_shift is detected
    if (signalType === "topic_shift") {
      const to = (signalData.to as string) || "";
      const phaseMap: Record<string, ScratchpadPhase> = {
        exploration: "exploring",
        implementation: "implementing",
        verification: "verifying",
        debugging: "debugging",
        documentation: "documenting",
        planning: "planning",
        testing: "verifying",
        refactoring: "implementing",
      };
      const newPhase = phaseMap[to];
      if (newPhase) {
        try {
          const cwd = (ctx as { cwd?: string }).cwd ?? "";
          const slug = projectSlugFromCwd(cwd);
          const pad = await loadScratchpadFromDisk(slug);
          if (pad) {
            await handleUpdateSession(pad, { phase: newPhase, turn: state(ctx).turnCount });
            log.info(`Auto-set scratchpad phase to "${newPhase}"`);
          }
        } catch (err) {
          log.debug(`Auto-set SessionPhase failed (non-fatal): ${err}`);
        }
      }
    }

    // Send enforcement whisper with triggerTurn to wake the agent
    const msg =
      signalType === "topic_shift"
        ? `**Phase transition detected:** from "${(signalData.from as string) || "previous"}" to "${(signalData.to as string) || "next"}".\n\n` +
          `Auto-tagged position as \`${tagName}\`. Use \`context_navigate(action="checkout", target="${tagName}")\` to return to this point.\n\n` +
          `Update your scratchpad phase: \`scratchpad(action="update_session", phase="${(signalData.to as string) || "implementing"}")\`.\n\n` +
          `Consider archiving the previous phase with \`context_compress(action="archive", topic="${(signalData.from as string) || "previous"}")\` to free context.`
        : `**Task boundary detected** (explore → implement → verify pattern).\n\n` +
          `Auto-tagged position as \`${tagName}\`. Consider archiving the current phase with \`context_compress(action="archive")\` before proceeding.`;

    sendTrackedMessage(
      pi,
      {
        customType: "context-lifecycle",
        content: [{ type: "text" as const, text: msg }],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "context", source: "context-lifecycle/phase-boundary-enforcement" },
    );

    // Track navigation whisper for escalation monitoring
    state(ctx).lastNavigationWhisperTurn = state(ctx).turnCount;
  }
}

// ── Extension Factory ────────────────────────────────────────────────────────

import { clearInjections, sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import { TOOL_CALL } from "../../../lib/core/event-names.js";
import * as timerMod from "../../scheduling/timer/index.js";

export default function contextLifecycleExtension(pi: ExtensionAPI): void {
  // ── session_start ────────────────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event: unknown, ctx: ExtensionContext) => {
    resetState(ctx);
    // ROADMAP DR-C-2: state(ctx) is now fresh per session; the policy
    // engine and signal detector live inside the per-session state, so
    // no manual reset is needed for them. clearInjections() is a
    // process-global tracker (see lib/utils/injection-tracker.ts) and
    // must be cleared explicitly on session boundaries.
    state(ctx).outcomes.length = 0;
    clearInjections(); // Clear injection history on fresh session
  });

  // Subscribe to memory_evict events to adjust compact nudge escalation
  eventBus.on("memory_evict", (event) => {
    log.debug(`[context-lifecycle] Memory eviction: ${event.reason} (${event.count} entries)`);
    // Large evictions increase compact urgency for the next proposal check
    if (event.count > 5) {
      const s = state();
      s.ignoredCompactNudges = Math.min(5, s.ignoredCompactNudges + 1);
    }
  });

  // ── before_agent_start ──────────────────────────────────────────────────
  // R-CCAM loop: Retrieval -> Cognition -> Control -> Action
  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    // ── RE-ENTRANCY GUARD ────────────────────────────────────────────────
    // If sendTrackedMessage -> pi.sendMessage(steer) fires before_agent_start
    // synchronously, prevent unbounded recursion. Without this guard, a
    // nudge that triggers a steer can create a loop:
    //   before_agent_start -> sendCompactNudge -> sendTrackedMessage ->
    //   pi.sendMessage(steer) -> before_agent_start -> ... (stack overflow)
    const reentrancy = getExtensionState<ReentrancyState>(ctx, "context-lifecycle/reentrancy", () => ({
      inBeforeAgentStart: false,
    }));
    if (reentrancy.inBeforeAgentStart) {
      log.warn("Re-entrant before_agent_start detected - skipping to prevent stack overflow");
      return;
    }
    reentrancy.inBeforeAgentStart = true;
    try {
      state(ctx).turnCount++;
      state(ctx).proposalsThisTurn = 0; // Reset per-turn counter

    // Evict old outcomes on each turn (sliding window TTL)
    evictOldOutcomes(state(ctx));

    const usage = getContextUsage(ctx);
    const entries = getAllEntries(ctx) as SessionEntry[];
    const branch = getBranchEntries(ctx) as SessionEntry[];

    // ── COMPACTION ESCALATION CHECK ────────────────────────────────────────
    // If we sent a compact nudge last turn and the agent didn't use any
    // context management tool, increment the ignored counter.
    // If they DID use a tool, reset the counter.
    if (state(ctx).compactNudgeActive) {
      if (state(ctx).agentActedOnContext) {
        state(ctx).ignoredCompactNudges = 0;
        state(ctx).compactNudgeActive = false;
        log.debug("Compact nudge acknowledged - agent used a context management tool");
      } else if (state(ctx).turnCount - state(ctx).lastCompactNudgeTurn > 0) {
        // Agent had a turn to respond but didn't act
        state(ctx).ignoredCompactNudges++;
        log.info(
          `Compact nudge ignored (${state(ctx).ignoredCompactNudges}/${COMPACT_ESCALATION_THRESHOLD}) ` +
            `usage=${usage.toFixed(0)}%`,
        );
      }
    }
    // ── NAVIGATION PROPOSAL ESCALATION ─────────────────────────────────────
    // Mirror the compaction escalation pattern: if the agent ignores
    // navigation enforcement whispers, increment the count and escalate.
    // The enforcement whisper is sent from queueProposal() with triggerTurn.
    // If the agent ignores 3+ whispers, auto-tag and send a stronger message.
    if (state(ctx).lastNavigationWhisperTurn > 0) {
      if (state(ctx).agentActedOnContext) {
        state(ctx).ignoredNavigationProposals = 0;
        log.debug("Navigation proposal acknowledged - agent used a context management tool");
      } else if (state(ctx).turnCount - state(ctx).lastNavigationWhisperTurn > 0) {
        state(ctx).ignoredNavigationProposals++;
        log.info(
          `Navigation proposal ignored (${state(ctx).ignoredNavigationProposals}/3)`,
        );

        // Escalate: after 3 ignored proposals, auto-tag and send stronger whisper
        if (state(ctx).ignoredNavigationProposals >= 3) {
          state(ctx).ignoredNavigationProposals = 0;
          state(ctx).lastNavigationWhisperTurn = 0;

          // Auto-tag position
          try {
            const sm = getSessionManager(ctx);
            const leafId = sm.getLeafId();
            sm.setLabel(leafId, `auto-tag-${state(ctx).turnCount}`);
            log.info(`Auto-tagged position on escalation (turn ${state(ctx).turnCount})`);
          } catch {
            // non-fatal
          }

          sendTrackedMessage(
            pi,
            {
              customType: "context-lifecycle",
              content: [
                {
                  type: "text" as const,
                  text:
                    `## ⚡ Navigation enforcement escalated\n\n` +
                    `Navigation proposals were ignored ${COMPACT_ESCALATION_THRESHOLD} times. ` +
                    `Auto-tagged current position.\n\n` +
                    `Use \`context_compress(action="archive")\` to free context before continuing.\n` +
                    `Use \`context_navigate(action="checkout", target="auto-tag-${state(ctx).turnCount}")\` to return to this point.`,
                },
              ],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
            { type: "context", source: "context-lifecycle/navigation-escalation" },
          );
        }
      }
    }

    // Reset agent action flag for this turn
    state(ctx).agentActedOnContext = false;

    // ── RETRIEVAL: Detect signals from session content ──────────────────
    const s = state(ctx);
    const signals = await detectSignals(s.detector, entries, ctx, usage);

    // ── DENSITY: Generate context density signals (SimpleMem 2601.02553) ─
    // These feed into density-aware policies (prune, compress, dedup)
    const densitySignals = generateDensitySignals(ctx);
    if (densitySignals.length > 0) {
      signals.push(...densitySignals);
    }

    // ── COGNITION: Evaluate policies against signals ───────────────────
    const redundancyCount = signals.filter((s) => s.type === "redundancy_detected").length;

    // ── TASK COMPLETION DETECTION ────────────────────────────────────────
    // Check if session looks like a completed task
    if (detectCompletionPattern(s.detector)) {
      queueSignal(s.detector, "task_completion_candidate", {
        topicHistory: s.detector.topicHistory.slice(-3),
        uniqueTools: new Set(s.detector.toolSequence.slice(-10)).size,
      });
    }
    const completionSignals = [...s.detector.pendingSignals];
    s.detector.pendingSignals = [];
    if (completionSignals.length > 0) {
      signals.push(...completionSignals);
    }

    const evaluated = evaluatePolicies(s.policyEngine, {
      signals,
      contextUsage: usage,
      contextTokens: getContextTokens(ctx),
      turnCount: branch.length,
      redundancyCount,
    });

    // ── CONTROL: Validate and select actions ───────────────────────────
    for (const ev of evaluated) {
      // Log governance warnings
      if (!ev.validation.valid) {
        log.warn(`Governance blocked: ${ev.validation.messages.join(", ")}`);
      } else if (ev.validation.severity === "warn") {
        log.warn(`Governance warning: ${ev.validation.messages.join(", ")}`);
      }

      // ── ACTION: Execute or queue ───────────────────────────────────
      if (ev.action.type === "propose") {
        await queueProposal(ev, pi, ctx, branch.length);
      } else if (ev.action.type === "compact" && ev.canExecute) {
        // ── ESCALATION GATE ──────────────────────────────────────────
        // If the agent has ignored 3+ compaction nudges and context is
        // still above 85%, auto-compact with a pre-scheduled resume timer.
        // This avoids the mid-task overflow death spiral (scenario 2.2).
        if (
          state(ctx).ignoredCompactNudges >= COMPACT_ESCALATION_THRESHOLD &&
          usage >= COMPACT_ESCALATION_USAGE
        ) {
          log.warn(
            `Escalating: auto-compacting (${state(ctx).ignoredCompactNudges} ignored nudges, ` +
              `usage=${usage.toFixed(0)}%)`,
          );
          await executeAutoCompact(pi, ctx);
          state(ctx).ignoredCompactNudges = 0;
          state(ctx).compactNudgeActive = false;
        } else {
          // Normal: send compact nudge
          sendCompactNudge(pi, ev, usage);
          state(ctx).compactNudgeActive = true;
          // ROADMAP P3-17 / DR-L-3: use session-scoped state(ctx) when available.
          state(ctx).lastCompactNudgeTurn = state(ctx).turnCount;
          state(ctx).lastCompactNudgeUsage = usage;
        }
      } else {
        executeAction(ev, pi, ctx, usage, branch.length);
      }
    }

    // ── MEMORY: Track implicit approvals ───────────────────────────────
    const proposalEntries = entries.filter(isProposalEntry);
    for (const entry of proposalEntries) {
      const proposal = entry.details as ContextProposal;
      if (proposal?.resolution) continue;

      // Mark as implicit_approved if created > 2 turns ago
      if (Date.now() - proposal.created_at > 120_000) {
        proposal.resolution = "implicit_approved";
        proposal.resolved_at = Date.now();
        // ROADMAP P3-17 / DR-L-3: use session-scoped state(ctx) when available.
        state(ctx).proposalsByEntryId.set(entry.id, proposal);

        // Track outcome for closed-loop feedback
        state(ctx).outcomes.push({
          proposalId: proposal.id,
          resolution: "implicit_approved",
          turnsToResolve: state(ctx).turnCount - proposal.turn,
          timestamp: Date.now(),
        });
      }
    }
    } finally {
      reentrancy.inBeforeAgentStart = false;
    }
  });

  // ── tool_call: Capture agent signals + compaction escalation reset ────────
  pi.on(TOOL_CALL, async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const toolName = event.toolName as string;

    // ── Task boundary signals ──────────────────────────────────────────
    const detectorState = state(ctx).detector;
    if (toolName === "context_tag") {
      queueSignal(detectorState, "task_boundary", { action: "tag", target: toolName });
    } else if (toolName === "context_archive") {
      queueSignal(detectorState, "task_boundary", { action: "compress" });
    } else if (toolName === "context_checkout") {
      queueSignal(detectorState, "task_boundary", { action: "checkout" });
    }

    // ── Compaction escalation reset ────────────────────────────────────
    // If the agent calls any context management tool, the compaction nudge
    // is considered "acted upon" and we reset the escalation counter.
    if (CONTEXT_MGMT_TOOLS.has(toolName)) {
      // ROADMAP P3-17 / DR-L-3: use session-scoped state(ctx) when available.
      state(ctx).agentActedOnContext = true;
      state(ctx).ignoredCompactNudges = 0;
      state(ctx).compactNudgeActive = false;
      state(ctx).ignoredNavigationProposals = 0;
      log.debug(`Context management tool "${toolName}" called - reset compaction and navigation escalation`);
    }

    // ── Auto-navigate back to investigation checkpoint ─────────────────
    // When the agent finalizes a task, check if there are tagged checkpoints
    // from the investigation phase and suggest navigating back.
    if (toolName === "finalize") {
      try {
        const sm = getSessionManager(ctx);
        const branch = sm.getBranch();
        // Find tags with "before-" prefix in the session
        const tags: string[] = [];
        for (const entry of branch) {
          try {
            const label = sm.getLabel(entry.id);
            if (label && label.startsWith("before-")) {
              tags.push(label);
            }
          } catch {
            // entry may not have a label
          }
        }

        // Also check cross-session tags from persistent file
        const cwd = (ctx as { cwd?: string }).cwd ?? "";
        const slug = cwd.split("/").filter(Boolean).join("-") || "default";
        const tagsFile = path.join(
          os.homedir(), ".pi", "agent", "braid", "tags", `${slug}.json`,
        );
        let fileTags: string[] = [];
        try {
          if (existsSync(tagsFile)) {
            const content = readFileSync(tagsFile, "utf-8");
            fileTags = Object.keys(JSON.parse(content)).filter((t) => t.startsWith("before-"));
          }
        } catch {
          // non-fatal
        }

        const allTags = [...new Set([...tags, ...fileTags])];
        if (allTags.length > 0) {
          const tagList = allTags.slice(0, 3).map((t) => `\`${t}\``).join(", ");
          sendTrackedMessage(
            pi,
            {
              customType: "context-lifecycle",
              content: [
                {
                  type: "text" as const,
                  text:
                    `Task finalized. Previous investigation checkpoints found: ${tagList}.\n\n` +
                    `Navigate back to review: \`context_navigate(action="checkout", target="${allTags[0]}")\`\n` +
                    `Use \`context_compress(action="archive")\` to free context before starting the next phase.`,
                },
              ],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "context", source: "context-lifecycle/navigate-back-suggestion" },
          );
          log.info(`Suggested navigating back to checkpoint: ${allTags[0]}`);
        }
      } catch {
        // non-fatal
      }
    }
  });

  // ── Proposals Tool ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "context_proposals",
    label: "Context Proposals",
    promptSnippet: "View and manage auto-generated context proposals",
    description:
      "View and manage auto-generated context proposals for session improvement - use to review or act on pending compaction/archive suggestions. Proposals are auto-generated " +
      "based on session analysis. Use `list` to see pending, `approve`/`reject` to act. " +
      "When to use: after receiving a context proposal whisper, or when context feels bloated and auto-suggestions might help guide your next step.",
    parameters: contextProposalsSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof contextProposalsSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const entries = getAllEntries(ctx) as SessionEntry[];
      const proposals = readProposalsFromSession(entries);
      const pending = proposals.filter((p) => !p.resolution);
      const snapshots = readSnapshotsFromSession(entries);

      switch (params.action) {
        case "list": {
          if (pending.length === 0) {
            return {
              content: [{ type: "text" as const, text: "[v] No pending proposals." }],
              details: { pending: 0 },
            };
          }

          const lines = pending.map((p) => {
            const age = Date.now() - p.created_at;
            const icon = p.priority === "high" ? "[high]" : p.priority === "medium" ? "[med]" : "[low]";
            return `${icon} **${p.id}** (${p.priority}) ${p.message}\n  └─ ${formatDuration(age)} ago`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `## Pending Proposals (${pending.length})\n\n${lines.join("\n\n")}\n\nUse context_proposals(action="approve", id="<id>") or the suggested tool.`,
              },
            ],
            details: { pending: pending.length, proposals },
          };
        }

        case "approve": {
          const id = params.id;
          if (!id) {
            return {
              content: [{ type: "text" as const, text: "Proposal ID required." }],
              details: { error: "missing_id" },
            };
          }

          const proposal = pending.find((p) => p.id === id);
          if (!proposal) {
            return {
              content: [{ type: "text" as const, text: `Proposal ${id} not found.` }],
              details: { error: "not_found" },
            };
          }

          proposal.resolution = "approved";
          proposal.resolved_at = Date.now();
          // ROADMAP P3-17 / DR-L-3: use session-scoped state(ctx) when available.
          state(ctx).proposalsByEntryId.set(id, proposal);

          state(ctx).outcomes.push({
            proposalId: id,
            resolution: "approved",
            turnsToResolve: state(ctx).turnCount - proposal.turn,
            timestamp: Date.now(),
          });

          return {
            content: [{ type: "text" as const, text: `[v] Approved **${id}**: ${proposal.message}` }],
            details: { approved: id, proposal, nextStep: { tool: "context_inspect", detail: "quick" } },
          };
        }

        case "reject": {
          const id = params.id;
          if (!id) {
            return {
              content: [{ type: "text" as const, text: "Proposal ID required." }],
              details: { error: "missing_id" },
            };
          }

          const proposal = pending.find((p) => p.id === id);
          if (!proposal) {
            return {
              content: [{ type: "text" as const, text: `Proposal ${id} not found.` }],
              details: { error: "not_found" },
            };
          }

          proposal.resolution = "rejected";
          proposal.resolved_at = Date.now();
          // ROADMAP P3-17 / DR-L-3: use session-scoped state(ctx) when available.
          state(ctx).proposalsByEntryId.set(id, proposal);

          state(ctx).outcomes.push({
            proposalId: id,
            resolution: "rejected",
            turnsToResolve: state(ctx).turnCount - proposal.turn,
            timestamp: Date.now(),
          });

          return {
            content: [{ type: "text" as const, text: `[x] Rejected **${id}**.` }],
            details: { rejected: id },
          };
        }

        case "snapshots": {
          if (snapshots.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No snapshots available." }],
              details: { count: 0 },
            };
          }

          const lines = snapshots.slice(0, 10).map((s) => {
            const expiresIn = s.expires_at - Date.now();
            return `- **${s.id}** (turn ${s.turn}) ${s.reason} | expires in ${formatDuration(expiresIn)}`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `## Snapshots (${snapshots.length})\n\n${lines.join("\n\n")}`,
              },
            ],
            details: { count: snapshots.length, snapshots },
          };
        }

        case "stats": {
          // ROADMAP DR-C-2: policies, governance, topicHistory now come
          // from the per-session state via state(ctx).policyEngine /
          // state(ctx).detector. Each session sees its own engine.
          const ctxState = state(ctx);
          const policies = ctxState.policyEngine.policies;
          const governance = ctxState.policyEngine.governance;

          // Calculate outcome stats
          const total = ctxState.outcomes.length;
          const approved = ctxState.outcomes.filter(
            (o) => o.resolution === "approved" || o.resolution === "implicit_approved",
          ).length;
          const avgTurns =
            total > 0 ? ctxState.outcomes.reduce((sum, o) => sum + o.turnsToResolve, 0) / total : 0;

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  "## S-MMU Statistics",
                  `**Session:** ${ctxState.turnCount} turns | ${formatDuration(Date.now() - ctxState.sessionStartMs)}`,
                  `**Proposals:** ${pending.length} pending, ${proposals.filter((p) => p.resolution).length} resolved`,
                  `**Outcomes:** ${approved}/${total} approved (${avgTurns.toFixed(1)} turns avg)`,
                  `**Policies:** ${policies.length} active`,
                  `**Governance:** ${governance.length} constraints`,
                  "",
                  "### Topic History",
                  ...ctxState.detector.topicHistory
                    .slice(-5)
                    .map((h) => `- Turn ${h.turn}: ${h.topic}`),
                ].join("\n"),
              },
            ],
            details: {
              turns: ctxState.turnCount,
              proposals,
              outcomes: ctxState.outcomes,
              policies,
              governance,
              topicHistory: ctxState.detector.topicHistory,
            },
          };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });

  // Note: context_signal tool removed (out of scope - internal API).
  // queueSignal() is still exported from signal-detector.ts and can be
  // called from other extensions directly:
  //   import { queueSignal, createDetectorState } from "./signal-detector.js";
  //   queueSignal(detectorState, "task_boundary", { action: "tag" });
}
