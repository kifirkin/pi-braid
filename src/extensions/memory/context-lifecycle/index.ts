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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import { getExtensionState } from "../../../lib/extension-state.js";

import {
  createProposal,
  createSnapshot,
  isProposalEntry,
  isSnapshotEntry,
  PROPOSAL_CUSTOM_TYPE,
  SNAPSHOT_CUSTOM_TYPE,
  type ContextProposal,
  type ContextSnapshot,
} from "./types.js";
import { PolicyEngine, type EvaluatedAction, generateDensitySignals } from "./policy-engine.js";
import { SignalDetector } from "./signal-detector.js";

// ── Module State ─────────────────────────────────────────────────────────────

const log = createLogger("context-lifecycle");

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

const _policyEngine = new PolicyEngine();
const _signalDetector = new SignalDetector();

// Outcome tracking (closed-loop feedback) with TTL eviction — now session-scoped
const MAX_OUTCOMES = 100;
const OUTCOME_TTL_MS = 30 * 60 * 1000;

interface Outcome {
  proposalId: string;
  resolution: string;
  turnsToResolve: number;
  timestamp: number;
}

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

// ── Session-scoped state ─────────────────────────────────────────────────────

interface ContextLifecycleState {
  proposalsThisTurn: number;
  proposalsTotal: number;
  initialized: boolean;
  sessionStartMs: number;
  turnCount: number;
  proposalsByEntryId: Map<string, any>;
  outcomes: Outcome[];
  // ── Compaction escalation tracking ──────────────────────────────────────
  /** How many compact nudges the agent has ignored consecutively */
  ignoredCompactNudges: number;
  /** Turn number when we last sent a compact nudge */
  lastCompactNudgeTurn: number;
  /** Context usage % at the time of last compact nudge */
  lastCompactNudgeUsage: number;
  /** Whether a compact nudge is currently waiting for agent action */
  compactNudgeActive: boolean;
  /** Whether the agent called a context management tool since the last nudge check */
  agentActedOnContext: boolean;
}

function createState(): ContextLifecycleState {
  return {
    proposalsThisTurn: 0,
    proposalsTotal: 0,
    initialized: false,
    sessionStartMs: Date.now(),
    turnCount: 0,
    proposalsByEntryId: new Map(),
    outcomes: [],
    ignoredCompactNudges: 0,
    lastCompactNudgeTurn: 0,
    lastCompactNudgeUsage: 0,
    compactNudgeActive: false,
    agentActedOnContext: false,
  };
}

function _getState(ctx: ExtensionContext): ContextLifecycleState {
  return getExtensionState(ctx, "context-lifecycle", createState);
}

// Module-level fallback state — used when `ctx` is not available.
// Preferred pattern: use getState(ctx) wherever ctx is accessible.
// Reset on session_start; turn_end uses the session-scoped getState(ctx).
// FULL FIX: Thread ctx through all callers and remove this fallback.
let _currentSessionState: ContextLifecycleState | null = null;
let _currentSessionId: string | null = null;

function ensureFreshState(sessionId?: string): void {
  const sid = sessionId ?? _currentSessionId;
  if (sid && sid !== _currentSessionId) {
    _currentSessionState = createState();
    _currentSessionId = sid;
  }
}

function state(): ContextLifecycleState {
  ensureFreshState();
  if (!_currentSessionState) {
    _currentSessionState = createState();
  }
  return _currentSessionState;
}

function resetState(ctx: ExtensionContext): ContextLifecycleState {
  _currentSessionState = createState();
  _currentSessionId = (ctx as any)?.cwd ?? null;
  return _currentSessionState;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const contextProposalsSchema = Type.Object({
  action: StringEnum(["list", "approve", "reject", "snapshots", "stats"]),
  id: Type.Optional(Type.String({ description: "Proposal ID to approve/reject" })),
});

const contextSignalSchema = Type.Object({
  type: StringEnum(["task_boundary", "topic_shift"], { description: "Signal type" }),
  note: Type.Optional(Type.String({ description: "Optional note about the signal" })),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getContextUsage(ctx: any): number {
  try {
    const usage = ctx.getContextUsage?.();
    return usage?.percent ?? 0;
  } catch {
    return 0;
  }
}

function getContextTokens(ctx: any): number {
  try {
    const usage = ctx.getContextUsage?.();
    return usage?.tokens ?? 0;
  } catch {
    return 0;
  }
}

function getAllEntries(ctx: any) {
  try {
    const sm = ctx.sessionManager;
    return sm.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function getBranchEntries(ctx: any) {
  try {
    const sm = ctx.sessionManager;
    return sm.getBranch?.() ?? [];
  } catch {
    return [];
  }
}

function readProposalsFromSession(entries: any[]): ContextProposal[] {
  const proposals: ContextProposal[] = [];
  for (const entry of entries) {
    if (isProposalEntry(entry)) {
      // Use details (set via appendCustomMessageEntry's 4th param)
      const data = entry.details as ContextProposal;
      if (data && data.id && data.created_at !== undefined) {
        proposals.push(data);
        state().proposalsByEntryId.set(entry.id, data);
      }
    }
  }
  return proposals;
}

function readSnapshotsFromSession(entries: any[]): ContextSnapshot[] {
  const now = Date.now();
  const snapshots: ContextSnapshot[] = [];
  for (const entry of entries) {
    if (isSnapshotEntry(entry)) {
      // appendCustomEntry uses .data field
      const data = (entry as unknown as { data?: ContextSnapshot }).data;
      if (data && data.id && data.expires_at > now) {
        snapshots.push(data);
      }
    }
  }
  return snapshots;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(0)}m`;
}

function interpolateMessage(
  message: string,
  ctx: any,
  signalData?: Record<string, unknown>,
): string {
  const usage = getContextUsage(ctx);
  const tokens = getContextTokens(ctx);
  let result = message.replace("{percent}", `${usage.toFixed(0)}%`);
  result = result.replace("{tokens}", `${Math.round(tokens / 1000)}K`);

  // Interpolate signal data fields (e.g., {noise}, {signal}, {count}, {density}, {token_ratio})
  if (signalData) {
    for (const [key, value] of Object.entries(signalData)) {
      result = result.replaceAll(`{${key}}`, String(value ?? ""));
    }
  }

  return result;
}

// ── Action Execution ─────────────────────────────────────────────────────────

/**
 * Send a compact nudge to the agent via tracked message.
 * Extracted from executeAction so the before_agent_start handler can also use it.
 */
function sendCompactNudge(pi: ExtensionAPI, evaluated: EvaluatedAction, usage: number): void {
  // Tag/branch is preferred over compaction — preserves session history
  // while freeing working context. Compact is the last resort.
  const pipelineMsg =
    usage >= 80
      ? `Context at ${Math.round(usage)}%. Pipeline: context_tag → context_checkout → context_archive → compact (last resort).`
      : `Context at ${Math.round(usage)}%. Tag with context_tag, then context_checkout to branch with a summary.`;

  sendTrackedMessage(
    pi,
    {
      customType: "context-lifecycle",
      content: [
        {
          type: "text" as const,
          text: `[compact] ${evaluated.policy.name} — ${pipelineMsg}`,
        },
      ],
      display: true,
      details: { _braidInjected: true, _braidSource: "context-lifecycle/compact-suggestion" },
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
async function executeAutoCompact(pi: ExtensionAPI, ctx: any): Promise<void> {
  try {
    // 1. Schedule resume timer BEFORE compacting
    try {
      const { scheduleTimer } = await import("../../tools/timer/index.js");
      scheduleTimer(1500, "Auto-compaction done — continue your task", "auto-compaction-resume");
      log.info("Scheduled resume timer before auto-compaction");
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
        details: { _braidInjected: true, _braidSource: "context-lifecycle/auto-compact" },
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
  ctx: any,
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
        const sm = ctx.sessionManager;
        sm.appendCustomEntry(SNAPSHOT_CUSTOM_TYPE, snapshot);
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

function queueProposal(evaluated: EvaluatedAction, ctx: any, branchLength: number): void {
  if (evaluated.action.type !== "propose") return;

  // ── Rate limiting: prevent proposal spam ────────────────────────────────
  state().proposalsThisTurn++;
  state().proposalsTotal++;
  if (state().proposalsThisTurn > MAX_PROPOSALS_PER_TURN) {
    log.debug(
      `Rate limited: ${state().proposalsThisTurn} proposals this turn (max ${MAX_PROPOSALS_PER_TURN})`,
    );
    return;
  }
  if (state().proposalsTotal > MAX_PROPOSALS_SESSION) {
    log.debug(
      `Session limit reached: ${state().proposalsTotal} proposals (max ${MAX_PROPOSALS_SESSION})`,
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

  const sm = ctx.sessionManager;
  sm.appendCustomMessageEntry(
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

import { clearInjections, sendTrackedMessage } from "../../../lib/injection-tracker.js";

export default function contextLifecycleExtension(pi: ExtensionAPI): void {
  // ── session_start ────────────────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event: any, ctx: any) => {
    resetState(ctx);
    state().outcomes.length = 0;
    _policyEngine.resetCooldowns();
    _signalDetector.reset();
    clearInjections(); // Clear injection history on fresh session
  });

  // ── before_agent_start ──────────────────────────────────────────────────
  // R-CCAM loop: Retrieval → Cognition → Control → Action
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    state().turnCount++;
    state().proposalsThisTurn = 0; // Reset per-turn counter

    // Evict old outcomes on each turn (sliding window TTL)
    evictOldOutcomes(state());

    const usage = getContextUsage(ctx);
    const entries = getAllEntries(ctx);
    const branch = getBranchEntries(ctx);

    // ── COMPACTION ESCALATION CHECK ────────────────────────────────────────
    // If we sent a compact nudge last turn and the agent didn't use any
    // context management tool, increment the ignored counter.
    // If they DID use a tool, reset the counter.
    if (state().compactNudgeActive) {
      if (state().agentActedOnContext) {
        state().ignoredCompactNudges = 0;
        state().compactNudgeActive = false;
        log.debug("Compact nudge acknowledged — agent used a context management tool");
      } else if (state().turnCount - state().lastCompactNudgeTurn > 0) {
        // Agent had a turn to respond but didn't act
        state().ignoredCompactNudges++;
        log.info(
          `Compact nudge ignored (${state().ignoredCompactNudges}/${COMPACT_ESCALATION_THRESHOLD}) ` +
            `usage=${usage.toFixed(0)}%`,
        );
      }
    }
    // Reset agent action flag for this turn
    state().agentActedOnContext = false;

    // ── RETRIEVAL: Detect signals from session content ──────────────────
    const signals = _signalDetector.update(entries, usage);

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
    _signalDetector.checkAndEmitCompletionSignal();
    const completionSignals = _signalDetector.getPending();
    if (completionSignals.length > 0) {
      signals.push(...completionSignals);
    }

    const evaluated = _policyEngine.evaluate({
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
          state().ignoredCompactNudges >= COMPACT_ESCALATION_THRESHOLD &&
          usage >= COMPACT_ESCALATION_USAGE
        ) {
          log.warn(
            `Escalating: auto-compacting (${state().ignoredCompactNudges} ignored nudges, ` +
              `usage=${usage.toFixed(0)}%)`,
          );
          await executeAutoCompact(pi, ctx);
          state().ignoredCompactNudges = 0;
          state().compactNudgeActive = false;
        } else {
          // Normal: send compact nudge
          sendCompactNudge(pi, ev, usage);
          state().compactNudgeActive = true;
          state().lastCompactNudgeTurn = state().turnCount;
          state().lastCompactNudgeUsage = usage;
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
        state().proposalsByEntryId.set(entry.id, proposal);

        // Track outcome for closed-loop feedback
        state().outcomes.push({
          proposalId: proposal.id,
          resolution: "implicit_approved",
          turnsToResolve: state().turnCount - proposal.turn,
          timestamp: Date.now(),
        });
      }
    }
  });

  // ── tool_call: Capture agent signals + compaction escalation reset ────────
  pi.on("tool_call", async (event: any) => {
    const toolName = event.toolName as string;
    const input = event?.input as Record<string, unknown> | undefined;

    // ── Task boundary signals ──────────────────────────────────────────
    if (toolName === "context_tag") {
      _signalDetector.queueSignal("task_boundary", { action: "tag", target: input?.name });
    } else if (toolName === "context_archive") {
      _signalDetector.queueSignal("task_boundary", { action: "compress" });
    } else if (toolName === "context_checkout") {
      _signalDetector.queueSignal("task_boundary", { action: "checkout" });
    }

    // ── Compaction escalation reset ────────────────────────────────────
    // If the agent calls any context management tool, the compaction nudge
    // is considered "acted upon" and we reset the escalation counter.
    if (CONTEXT_MGMT_TOOLS.has(toolName)) {
      state().agentActedOnContext = true;
      state().ignoredCompactNudges = 0;
      state().compactNudgeActive = false;
      log.debug(`Context management tool "${toolName}" called - reset compaction escalation`);
    }
  });

  // ── Proposals Tool ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "context_proposals",
    label: "Context Proposals",
    promptSnippet: "View and manage S-MMU context proposals",
    description:
      "View and manage auto-generated context proposals for session improvement — use to review or act on pending compaction/archive suggestions. Proposals are auto-generated " +
      "based on session analysis. Use `list` to see pending, `approve`/`reject` to act.",
    parameters: contextProposalsSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const entries = getAllEntries(ctx);
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
          state().proposalsByEntryId.set(id, proposal);

          state().outcomes.push({
            proposalId: id,
            resolution: "approved",
            turnsToResolve: state().turnCount - proposal.turn,
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
          state().proposalsByEntryId.set(id, proposal);

          state().outcomes.push({
            proposalId: id,
            resolution: "rejected",
            turnsToResolve: state().turnCount - proposal.turn,
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
          const policies = _policyEngine.getPolicies();
          const governance = _policyEngine.getGovernance();

          // Calculate outcome stats
          const total = state().outcomes.length;
          const approved = state().outcomes.filter(
            (o) => o.resolution === "approved" || o.resolution === "implicit_approved",
          ).length;
          const avgTurns =
            total > 0 ? state().outcomes.reduce((sum, o) => sum + o.turnsToResolve, 0) / total : 0;

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  "## S-MMU Statistics",
                  `**Session:** ${state().turnCount} turns | ${formatDuration(Date.now() - state().sessionStartMs)}`,
                  `**Proposals:** ${pending.length} pending, ${proposals.filter((p) => p.resolution).length} resolved`,
                  `**Outcomes:** ${approved}/${total} approved (${avgTurns.toFixed(1)} turns avg)`,
                  `**Policies:** ${policies.length} active`,
                  `**Governance:** ${governance.length} constraints`,
                  "",
                  "### Topic History",
                  ..._signalDetector
                    .getTopicHistory()
                    .slice(-5)
                    .map((h) => `- Turn ${h.turn}: ${h.topic}`),
                ].join("\n"),
              },
            ],
            details: {
              turns: state().turnCount,
              proposals,
              outcomes: state().outcomes,
              policies,
              governance,
              topicHistory: _signalDetector.getTopicHistory(),
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

  // ── context_signal: Manual semantic signals ────────────────────────────────
  pi.registerTool({
    name: "context_signal",
    label: "Context Signal",
    promptSnippet: "Emit a semantic signal to the S-MMU policy engine",
    description:
      "Emit a semantic signal to the policy engine — use when the conversation topic shifts or a task boundary is reached to help context management.",
    parameters: contextSignalSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ): Promise<any> => {
      const type = params.type;
      const note = params.note ?? "";

      _signalDetector.queueSignal(type, { note, turn: state().turnCount });

      return {
        content: [
          { type: "text" as const, text: `✓ Signal emitted: ${type}${note ? ` - ${note}` : ""}` },
        ],
        details: { signal: type, note },
      };
    },
  });
}
