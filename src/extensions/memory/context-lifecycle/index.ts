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
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState, getCachedSessionManager } from "../../../lib/state/extension-state.js";
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
 * Execute auto-compaction with pre-scheduled resume timer.
 * This is the escalation path: when the agent ignores compaction nudges,
 * we auto-trigger the same timer+compact pattern that context_compact tool uses.
 * The timer fires after compaction completes and resumes the agent.
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
      // NOTE: We intentionally do NOT call scheduleTimer() here. The
      // session_compact handler in register-session-compact.ts cancels the
      // resume tag immediately, so any timer created in this scope would be
      // cancelled before it ever fires. Instead, the handler schedules a
      // FRESH resume timer after compaction completes, when the session is
      // in a known state.
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

function queueProposal(evaluated: EvaluatedAction, ctx: ExtensionContext, branchLength: number): void {
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
        queueProposal(ev, ctx, branch.length);
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
      log.debug(`Context management tool "${toolName}" called - reset compaction escalation`);
    }
  });

  // ── Proposals Tool ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "context_proposals",
    label: "Context Proposals",
    promptSnippet: "View and manage S-MMU context proposals",
    description:
      "View and manage auto-generated context proposals for session improvement - use to review or act on pending compaction/archive suggestions. Proposals are auto-generated " +
      "based on session analysis. Use `list` to see pending, `approve`/`reject` to act.",
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
              content: [{ type: "text" as const, text: "✓ No pending proposals." }],
              details: { pending: 0 },
            };
          }

          const lines = pending.map((p) => {
            const age = Date.now() - p.created_at;
            const icon = p.priority === "high" ? "🔴" : p.priority === "medium" ? "🟡" : "🟢";
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
            content: [{ type: "text" as const, text: `✓ Approved **${id}**: ${proposal.message}` }],
            details: { approved: id, proposal },
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
            content: [{ type: "text" as const, text: `✗ Rejected **${id}**.` }],
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
