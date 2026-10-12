/**
 * Context Lifecycle Extension - S-MMU Active Context Management
 *
 * AUTOMATION layer that works WITH context-manager.
 * NO new tools - uses existing context_navigate, context_compress, etc.
 *
 * R-CCAM-inspired loop:
 * - Retrieval: Signal detection from session content
 * - Cognition: Policy evaluation with governance
 * - Control: Action selection with constraint checking
 * - Action: Proposal injection or immediate execution
 * - Memory: CustomEntry persistence with outcome tracking
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { createLogger } from "../../../lib/core/logger.js";
import { applyWhisperEnvelope } from "../../../lib/utils/whisper-format.js";
import { formatTokensK } from "../../../lib/detection/context-usage.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { braidDir, tagsSlugFromCwd } from "../../../lib/config/braid-paths.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
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
import { evaluatePolicies, type EvaluatedAction, generateDensitySignals } from "./policy-engine.js";
import { detectSignals, queueSignal, detectCompletionPattern } from "./signal-detector.js";

// Module State

const log = createLogger("context-lifecycle");

// Re-entrancy guard for before_agent_start. Per-session so a stale
// 'true' from a crashed previous turn can't poison the next session.
// Prevents "Maximum call stack size exceeded" when pi.sendMessage(steer)
// triggers a synchronous before_agent_start that calls sendTrackedMessage again.
interface ReentrancyState {
  inBeforeAgentStart: boolean;
}

// Proposal rate limiting
const MAX_PROPOSALS_PER_TURN = 2;
const MAX_PROPOSALS_SESSION = 10;

// proposal real-need GATE + same-suggestion DEDUPE
// The benchmark measured context-lifecycle:proposal as the #1
// de-bloat target: 2,546 deliveries / 69,558 tokens at 4% acted-on, with
// 33% of deliveries being exact-repeat same-session bodies re-injected turn
// after turn. Two independent levers suppress that class at the single
// proposal-send chokepoint (queueProposal):
//
//   GATE (fire only on real need): proposals triggered by PERSISTENT
//     conditions (usage %, token counts, density) only fire when context
//     state actually warrants them - usage above an actionable floor or a
//     concrete compression signal present, the agent has NOT just acted on
//     context, and the same suggestion class was not just declined.
//   DEDUPE (never re-send a still-actionable suggestion): the same body ->
//     same suggested tool is not re-sent within a session while the previous
//     one is still actionable (pending, or delivered and not yet acted on).
//
// Each knob is a named constant so volume reduction and usefulness are
// independently adjustable, and urgency is preserved: a proposal whose usage
// crosses PROPOSAL_URGENT_USAGE (or is high-priority) bypasses both levers.
const PROPOSAL_ACTIONABLE_USAGE = 55; // [gate] below this %, advisory proposals = no real need (unless a density signal backs them)
// Token arm: the % floor is unreachable at
// a 1M window (20% ≈ 200k tokens) and a measured session fired ZERO
// high-context advisories across 154 turns at 150-238k tokens — persistent
// policies triggered on tokens but this gate suppressed them all. The gate
// now opens on EITHER arm: usage >= PROPOSAL_ACTIONABLE_USAGE OR tokens >=
// PROPOSAL_ACTIONABLE_TOKENS (min(percent, token) semantics).
const PROPOSAL_ACTIONABLE_TOKENS = USAGE_TOKENS_CRITICAL(); // [gate, tokens] either arm opens the gate (act arm, min(0.60W, 130k))
const PROPOSAL_ACTED_SUPPRESS_TURNS = 3; // [gate] quiet window after the agent acts on context (opportunity already taken)
const PROPOSAL_URGENT_USAGE = 75; // [gate] = USAGE_WHISPER_CRITICAL - genuinely urgent nudge bypasses gate + dedupe (keep urgency)
const PROPOSAL_URGENT_TOKENS = HYGIENE_AUTO_COMPACT_HARD_BACKSTOP(); // [gate, tokens] hard-backstop band is urgent at any window
const PROPOSAL_DEDUPE_COOLDOWN_MS = 20 * 60 * 1000; // [dedupe] a delivered suggestion stays "in effect" this long (mirrors reprime)
const PROPOSAL_IGNORED_BACKOFF_TURNS = 8; // [dedupe/compliance, independent] after a same-class proposal was ignored, back off N turns

// Compaction Escalation Thresholds
// When the agent ignores 3+ compaction nudges at >=85% usage, auto-compact with timer.
const COMPACT_ESCALATION_THRESHOLD = 3;
const COMPACT_ESCALATION_USAGE = 85;

// Token constants for the ADVISORY path:
// single owner is lib/detection/context-thresholds.ts — import, never restate.
import {
  USAGE_TOKENS_CRITICAL,
  HYGIENE_AUTO_COMPACT_HARD_BACKSTOP,
  USAGE_TOKENS_ESCALATE,
} from "../../../lib/detection/context-thresholds.js";

// Context management tools that count as "agent acted on compaction nudge"
const CONTEXT_MGMT_TOOLS = new Set([
  "context_compress",
  "context_inspect",
  "context_navigate",
  "context_proposals",
]);

// Policy engine + signal-detector state are per-session fields of
// ContextLifecycleState (see ./state.ts): each session starts with a fresh
// engine + detector. Access via `state(ctx).policyEngine` / `.detector`.

// Outcome tracking (closed-loop feedback) with TTL eviction, session-scoped
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

// Note: turn_end handlers in this module use the session-scoped getState(ctx)
// pattern to read the latest state. Module-level `state()` is the fallback
// when ctx is not available.
import { type ContextLifecycleState, state, resetState } from "./state.js";
// Note: state.ts types and functions are intentionally NOT re-exported.
// All consumers (this file, helpers.ts) access them via the import above.
// External callers should depend on `./state.js` directly if they need
// access to state types or functions. This removes the public-API surface
// area (it has zero external callers, so nothing depends on it).

// Schema

const contextProposalsSchema = Type.Object({
  action: StringEnum(["list", "approve", "reject", "snapshots", "stats"]),
  id: Type.Optional(Type.String({ description: "Proposal ID to approve/reject" })),
});

import {
  getContextUsage,
  getContextTokens,
  getAllEntries,
  getBranchEntries,
  readProposalsFromSession,
  readSnapshotsFromSession,
  formatDuration,
  interpolateMessage,
  proposalKeyFor,
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
  proposalKeyFor,
} from "./helpers.js";

// Action Execution

/**
 * Send a compact nudge to the agent via tracked message. Shared by
 * executeAction and the before_agent_start handler.
 */
function sendCompactNudge(
  pi: ExtensionAPI,
  evaluated: EvaluatedAction,
  usage: number,
  tokens: number,
): void {
  // Tag/branch is preferred over compaction - preserves session history
  // while freeing working context.
  // Advisory ladder (token arms; single owner context-thresholds.ts):
  //   >= USAGE_TOKENS_ESCALATE (0.85W)          escalated wording (archive-or-handoff)
  //   >= HARD_BACKSTOP (0.90W) or usage >= 80   full pipeline message
  //   else                                     light tag/checkout message
  // Percent stays as the secondary trigger (sub-1M windows).
  const tokensK = formatTokensK(tokens);
  const pipelineMsg =
    tokens >= USAGE_TOKENS_ESCALATE()
      ? `Context at ${Math.round(usage)}% (~${tokensK} tokens). Escalated: archive the current phase with context_compress(action="archive"), or hand off to a fresh session (write a handoff note first).`
      : usage >= 80 || tokens >= HYGIENE_AUTO_COMPACT_HARD_BACKSTOP()
        ? `Context at ${Math.round(usage)}% (~${tokensK} tokens). Pipeline: context_navigate(action="tag") -> context_navigate(action="checkout") -> context_compress(action="archive") -> context_compress(action="slide").`
        : `Context at ${Math.round(usage)}% (~${tokensK} tokens). Tag with context_navigate(action="tag"), then context_navigate(action="checkout") to branch with a summary.`;

  sendTrackedMessage(
    pi,
    {
      customType: "context-lifecycle",
      content: [
        {
          type: "text" as const,
          text: `${evaluated.policy.name} - ${pipelineMsg}`,
        },
      ],
      display: true,
      details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "context-lifecycle/compact-suggestion" },
    },
    { delivery: "park", deliverAs: "steer" },
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
      // CRITICAL: scope to current session - see the timer module for why:
      // an unscoped timer map leaks across pi sessions.
      const sessionId =
        (
          ctx as { sessionManager?: { getSessionId?: () => string } }
        )?.sessionManager?.getSessionId?.() ?? "anonymous";
      timerMod.cancelTimersByTag(sessionId, "compaction-resume");
      timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
      // NOTE: no scheduleTimer() here — pi-core's agent loop automatically
      // continues after compaction (_runAutoCompaction() returns `true` →
      // agent.continue()); a fallback resume timer fires as spurious noise
      // the agent ignores.
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
              'Use context_navigate(action="tag") proactively next time to avoid losing the completion summary.',
            ].join("\n"),
          },
        ],
        display: true,
        details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "context-lifecycle/auto-compact" },
      },
      { delivery: "park", deliverAs: "steer" },
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
        // Advisory wording ladder also token-gated (see sendCompactNudge).
        sendCompactNudge(pi, evaluated, usage, getContextTokens(ctx));
      }
      break;

    case "snapshot":
      if (evaluated.canExecute) {
        const snapshot = createSnapshot(action.reason, branchLength, Math.round(usage * 2));
        pi.appendEntry(SNAPSHOT_CUSTOM_TYPE, snapshot);
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
          { delivery: "park", deliverAs: "steer" },
          { type: "context", source: "context-lifecycle/nudge" },
        );
      }
      break;
  }
}

// proposal gate + dedupe helpers

/**
 * True when an evaluated propose-action carries a concrete compression
 * signal (density low / high / duplicates / redundancy). Presence of such a
 * signal means there IS a real need even when usage % looks low.
 */
function hasConcreteCompressionSignal(evaluated: EvaluatedAction): boolean {
  const t = evaluated.signal?.type;
  return (
    t === "context_density_low" ||
    t === "context_density_high" ||
    t === "context_duplicates" ||
    t === "redundancy_detected"
  );
}

/**
 * Proposals triggered by PERSISTENT conditions - usage %, token counts,
 * density - stay true across turns, so the policy re-fires every cooldown
 * with a fresh copy of the SAME advice ("Context at 55%. Consider archive").
 * This is the measured 33% exact-repeat class. Event-triggered proposals
 * (topic_shift, task_boundary, task_complexity, decision_density,
 * task_completion_candidate) fire on discrete moments and are NOT this class
 * - they skip the real-need gate but still pass through the dedupe.
 */
function isPersistentConditionProposal(evaluated: EvaluatedAction): boolean {
  const trigger = evaluated.policy.trigger;
  if (trigger.type === "context_usage" || trigger.type === "context_usage_tokens") return true;
  if (trigger.type === "signal") {
    switch (trigger.signal) {
      case "context_pressure":
      case "context_density_low":
      case "context_density_high":
      case "context_duplicates":
      case "redundancy_detected":
      case "compaction_opportunity":
      case "checkpoint_opportunity":
        return true;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Genuinely urgent nudge - bypasses the gate + dedupe so a critical
 * compact/archive suggestion still lands with its current delivery behavior.
 */
function isUrgentProposal(evaluated: EvaluatedAction, usage: number, tokens: number): boolean {
  if (evaluated.action.type === "propose" && evaluated.action.priority === "high") return true;
  // Urgent on EITHER arm — percent band (sub-1M windows) or the
  // hard-backstop token band (any window).
  if (usage >= PROPOSAL_URGENT_USAGE) return true;
  if (tokens >= PROPOSAL_URGENT_TOKENS) return true;
  const percent = (evaluated.signal?.data?.percent as number) ?? 0;
  return evaluated.signal?.type === "context_pressure" && percent >= PROPOSAL_URGENT_USAGE;
}

/**
 * Seed the per-session dedupe map from persisted proposals so a resumed /
 * compacted session does not re-inject a suggestion that was already delivered
 * (persisted custom_message entries are replayed into context). Runs once per
 * session (lazy) - state is fresh on session_start.
 */
function ensureProposalKeysSeeded(
  ctx: ExtensionContext,
  existingProposals: ContextProposal[],
): void {
  const s = state(ctx);
  if (s.proposalKeysSeeded) return;
  s.proposalKeysSeeded = true;
  for (const p of existingProposals) {
    const key = proposalKeyFor(p.message, p.suggested_action);
    if (!s.proposalKeys.has(key)) {
      s.proposalKeys.set(key, p.created_at);
    }
  }
}

/**
 * Decide whether a candidate propose-action should be suppressed before it
 * reaches the agent. Returns a human-readable reason string, or null to allow
 * delivery. This is the SINGLE decision point for the proposal-noise class -
 * both the real-need gate and the same-suggestion dedupe live here.
 */
function proposeSuppressionCause(
  ctx: ExtensionContext,
  evaluated: EvaluatedAction,
  existingProposals: ContextProposal[],
  usage: number,
  tokens: number,
): string | null {
  if (evaluated.action.type !== "propose") return null;
  const s = state(ctx);
  const now = Date.now();
  const isUrgent = isUrgentProposal(evaluated, usage, tokens);
  const key = proposalKeyFor(
    interpolateMessage(evaluated.action.message, ctx, evaluated.signal?.data),
    evaluated.policy.suggested_action,
  );

  // GATE: persistent-condition proposals need a real need
  if (isPersistentConditionProposal(evaluated) && !isUrgent) {
    // (a) No actionable need: usage below the floor AND no concrete
    // compression signal backs this advisory re-fire.
    // Token arm: either arm satisfies the floor (min(percent, token)).
    if (
      usage < PROPOSAL_ACTIONABLE_USAGE &&
      tokens < PROPOSAL_ACTIONABLE_TOKENS &&
      !hasConcreteCompressionSignal(evaluated)
    ) {
      return "no-actionable-need";
    }
    // (b) Agent just acted on context - the opportunity was taken / is being
    // handled; a fresh advisory would fight the action it just took.
    if (
      s.lastContextActionTurn > 0 &&
      s.turnCount - s.lastContextActionTurn <= PROPOSAL_ACTED_SUPPRESS_TURNS
    ) {
      return "agent-just-acted";
    }
    // (c) Compliance feedback: the agent declined this exact suggestion class
    // via context_proposals reject - back off re-proposing it.
    if (s.declinedKeys.has(key)) {
      return "declined-same-class";
    }
  }

  // DEDUPE: same suggestion must not re-send while still actionable
  if (!isUrgent) {
    // Persisted pending proposal of the same class = already delivered and
    // unresolved (still actionable), and persisted entries are replayed into
    // context on resume - re-sending would double-inject.
    if (
      existingProposals.some(
        (p) => !p.resolution && proposalKeyFor(p.message, p.suggested_action) === key,
      )
    ) {
      return "proposal-pending";
    }
    // Session-hot: we delivered this class and the agent has not acted since
    // (proposalKeys is cleared on action) - keep it suppressed for the window.
    const lastSentAt = s.proposalKeys.get(key);
    if (lastSentAt !== undefined && now - lastSentAt < PROPOSAL_DEDUPE_COOLDOWN_MS) {
      return "repeat-session";
    }
    // Compliance feedback: a same-class suggestion was ignored recently
    // (implicitly approved = agent never acted) - back off for an independent,
    // session-scoped window so usefulness and volume are separately tunable.
    const ignoredTurn = s.proposalIgnoredTurns.get(key);
    if (ignoredTurn !== undefined && s.turnCount - ignoredTurn <= PROPOSAL_IGNORED_BACKOFF_TURNS) {
      return "ignored-backoff";
    }
  }

  return null;
}

async function queueProposal(
  evaluated: EvaluatedAction,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  branchLength: number,
): Promise<void> {
  if (evaluated.action.type !== "propose") return;

  const action = evaluated.action;
  const existingEntries = getAllEntries(ctx);
  const existingProposals = readProposalsFromSession(existingEntries);
  const usage = getContextUsage(ctx);
  const tokens = getContextTokens(ctx);

  // real-need GATE + same-suggestion DEDUPE
  // Seed the per-session dedupe map from persisted proposals (resume /
  // compaction replay must not re-inject), then decide in ONE place whether
  // this candidate may reach the agent. Possible reasons:
  //   no-actionable-need / agent-just-acted / declined-same-class /
  //   proposal-pending / repeat-session / ignored-backoff
  ensureProposalKeysSeeded(ctx, existingProposals);
  const suppressReason = proposeSuppressionCause(ctx, evaluated, existingProposals, usage, tokens);

  if (!suppressReason) {
    // Rate limiting: only delivered proposals consume the caps
    state(ctx).proposalsThisTurn++;
    state(ctx).proposalsTotal++;
    if (state(ctx).proposalsThisTurn > MAX_PROPOSALS_PER_TURN) {
      log.debug(
        `Rate limited: ${state(ctx).proposalsThisTurn} proposals this turn (max ${MAX_PROPOSALS_PER_TURN})`,
      );
    } else if (state(ctx).proposalsTotal > MAX_PROPOSALS_SESSION) {
      log.debug(
        `Session limit reached: ${state(ctx).proposalsTotal} proposals (max ${MAX_PROPOSALS_SESSION})`,
      );
    } else {
      const proposal = createProposal(
        "compact",
        interpolateMessage(action.message, ctx, evaluated.signal?.data),
        evaluated.policy.id,
        branchLength,
        action.priority,
        0.7,
        evaluated.policy.suggested_action,
      );

      const sm = getCachedSessionManager(ctx) as
        | {
            appendCustomMessageEntry?: (
              type: string,
              entry: unknown,
              persistent: boolean,
              meta: unknown,
            ) => void;
          }
        | undefined;
      // Apply the universal whisper envelope + [braid-whisper-end] marker to
      // the proposal content array. appendCustomMessageEntry bypasses the
      // sendTrackedMessage trunk, so the envelope must be applied here -- this
      // is the sole call site for that channel. The end-marker is essential
      // because the proposal is persisted as a custom_message entry and replayed
      // into agent context on session resume/compaction: without it the agent
      // has no unambiguous boundary for the suggestion body.
      const proposalContent: { type: "text"; text: string }[] = [
        { type: "text" as const, text: `Context Suggestion: ${proposal.message}` },
      ];
      // The envelope source was "memory/context-lifecycle",
      // whose first segment maps to `[braid-whisper - memory]` — misattributing
      // these context-lifecycle proposal bodies to the memory family (114
      // measured deliveries). The source must be the TRUE family, so the
      // envelope says context-lifecycle.
      applyWhisperEnvelope(proposalContent, "context-lifecycle/proposal");
      sm?.appendCustomMessageEntry?.(PROPOSAL_CUSTOM_TYPE, proposalContent, true, proposal);
      // Record the suggestion class so a repeat re-fire is suppressed while
      // this one is still actionable (gate + dedupe rely on this map).
      state(ctx).proposalKeys.set(
        proposalKeyFor(proposal.message, proposal.suggested_action),
        Date.now(),
      );
      log.debug(`Created proposal: ${proposal.id}`);
    }
  } else {
    log.info(
      `Proposal suppressed (${suppressReason}) policy=${evaluated.policy.id} "${action.message.slice(0, 48)}"`,
    );
  }

  // Phase boundary enforcement: upgrade topic_shift and task_boundary
  // proposals to enforcement whispers with auto-tagging. This ensures the
  // agent preserves context before switching between investigation,
  // implementation, and verification phases.
  if (evaluated.signal?.type === "topic_shift" || evaluated.signal?.type === "task_boundary") {
    const signalType = evaluated.signal.type;
    const signalData = evaluated.signal.data || {};

    // Auto-tag current position
    let tagName: string;
    if (signalType === "topic_shift") {
      const to = (signalData.to as string) || "next-phase";
      tagName = `before-${to}`;
    } else {
      tagName = `before-task-boundary`;
    }

    try {
      const sessionManager = getSessionManager(ctx);
      const leafId = sessionManager.getLeafId();
      pi.setLabel(leafId, tagName);
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

// Extension Factory

import { clearInjections, sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import { TOOL_CALL } from "../../../lib/core/event-names.js";
import * as timerMod from "../../scheduling/timer/index.js";

export default function contextLifecycleExtension(pi: ExtensionAPI): void {
  // session_start
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: unknown, ctx: ExtensionContext) => {
      resetState(ctx);
      // state(ctx) is fresh per session; the policy
      // engine and signal detector live inside the per-session state, so
      // no manual reset is needed for them. clearInjections() is a
      // process-global tracker (see lib/utils/injection-tracker.ts) and
      // must be cleared explicitly on session boundaries.
      state(ctx).outcomes.length = 0;
      clearInjections();
    },
  );

  // Subscribe to memory_evict events to adjust compact nudge escalation
  eventBus.on("memory_evict", (event) => {
    log.debug(`[context-lifecycle] Memory eviction: ${event.reason} (${event.count} entries)`);
    // Large evictions increase compact urgency for the next proposal check
    if (event.count > 5) {
      const s = state();
      s.ignoredCompactNudges = Math.min(5, s.ignoredCompactNudges + 1);
    }
  });

  // before_agent_start
  // R-CCAM loop: Retrieval -> Cognition -> Control -> Action
  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    // RE-ENTRANCY GUARD
    // If sendTrackedMessage -> pi.sendMessage(steer) fires before_agent_start
    // synchronously, prevent unbounded recursion. Without this guard, a
    // nudge that triggers a steer can create a loop:
    //   before_agent_start -> sendCompactNudge -> sendTrackedMessage ->
    //   pi.sendMessage(steer) -> before_agent_start -> ... (stack overflow)
    const reentrancy = getExtensionState<ReentrancyState>(
      ctx,
      "context-lifecycle/reentrancy",
      () => ({
        inBeforeAgentStart: false,
      }),
    );
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

      // COMPACTION ESCALATION CHECK
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
      // NAVIGATION PROPOSAL ESCALATION
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
          log.info(`Navigation proposal ignored (${state(ctx).ignoredNavigationProposals}/3)`);

          // Escalate: after 3 ignored proposals, auto-tag and send stronger whisper
          if (state(ctx).ignoredNavigationProposals >= 3) {
            state(ctx).ignoredNavigationProposals = 0;
            state(ctx).lastNavigationWhisperTurn = 0;

            // Auto-tag position
            try {
              const sm = getSessionManager(ctx);
              const leafId = sm.getLeafId();
              pi.setLabel(leafId, `auto-tag-${state(ctx).turnCount}`);
              log.info(`Auto-tagged position on escalation (turn ${state(ctx).turnCount})`);
            } catch {
              // Session manager may be detached mid-escalation; the tag is
              // cosmetic — navigation still works untagged.
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

      state(ctx).agentActedOnContext = false;

      // RETRIEVAL: Detect signals from session content
      const s = state(ctx);
      const signals = await detectSignals(s.detector, entries, ctx, usage);

      // DENSITY: Generate context density signals (SimpleMem 2601.02553)
      // These feed into density-aware policies (prune, compress, dedup)
      const densitySignals = generateDensitySignals(ctx);
      if (densitySignals.length > 0) {
        signals.push(...densitySignals);
      }

      // COGNITION: Evaluate policies against signals
      const redundancyCount = signals.filter((s) => s.type === "redundancy_detected").length;

      // TASK COMPLETION DETECTION
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

      // CONTROL: Validate and select actions
      for (const ev of evaluated) {
        if (!ev.validation.valid) {
          log.warn(`Governance blocked: ${ev.validation.messages.join(", ")}`);
        } else if (ev.validation.severity === "warn") {
          log.warn(`Governance warning: ${ev.validation.messages.join(", ")}`);
        }

        // ACTION: Execute or queue
        if (ev.action.type === "propose") {
          await queueProposal(ev, pi, ctx, branch.length);
        } else if (ev.action.type === "compact" && ev.canExecute) {
          // ESCALATION GATE
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
            sendCompactNudge(pi, ev, usage, getContextTokens(ctx));
            state(ctx).compactNudgeActive = true;
            state(ctx).lastCompactNudgeTurn = state(ctx).turnCount;
            state(ctx).lastCompactNudgeUsage = usage;
          }
        } else {
          executeAction(ev, pi, ctx, usage, branch.length);
        }
      }

      // MEMORY: Track implicit approvals
      const proposalEntries = entries.filter(isProposalEntry);
      for (const entry of proposalEntries) {
        const proposal = entry.details as ContextProposal;
        if (proposal?.resolution) continue;

        if (Date.now() - proposal.created_at > 120_000) {
          proposal.resolution = "implicit_approved";
          proposal.resolved_at = Date.now();
          state(ctx).proposalsByEntryId.set(entry.id, proposal);

          // Track outcome for closed-loop feedback
          state(ctx).outcomes.push({
            proposalId: proposal.id,
            resolution: "implicit_approved",
            turnsToResolve: state(ctx).turnCount - proposal.turn,
            timestamp: Date.now(),
          });

          // A same-class suggestion the agent never acted on
          // was implicitly approved = ignored. Record the class so the
          // compliance-feedback backoff suppresses re-proposing it for
          // PROPOSAL_IGNORED_BACKOFF_TURNS.
          state(ctx).proposalIgnoredTurns.set(
            proposalKeyFor(proposal.message, proposal.suggested_action),
            state(ctx).turnCount,
          );
        }
      }
    } finally {
      reentrancy.inBeforeAgentStart = false;
    }
  });

  // tool_call: Capture agent signals + compaction escalation reset
  pi.on(TOOL_CALL, async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const toolName = event.toolName as string;

    // Task boundary signals
    const detectorState = state(ctx).detector;
    if (toolName === "context_navigate") {
      const action = (event as { input?: { action?: string } }).input?.action;
      if (action === "tag") {
        queueSignal(detectorState, "task_boundary", { action: "tag", target: toolName });
      } else if (action === "checkout") {
        queueSignal(detectorState, "task_boundary", { action: "checkout" });
      }
    } else if (toolName === "context_compress") {
      const action = (event as { input?: { action?: string } }).input?.action;
      if (action === "archive" || action === "compact") {
        queueSignal(detectorState, "task_boundary", { action: "compress" });
      }
    }

    // Compaction escalation reset
    // If the agent calls any context management tool, the compaction nudge
    // is considered "acted upon" and we reset the escalation counter.
    if (CONTEXT_MGMT_TOOLS.has(toolName)) {
      state(ctx).agentActedOnContext = true;
      state(ctx).ignoredCompactNudges = 0;
      state(ctx).compactNudgeActive = false;
      state(ctx).ignoredNavigationProposals = 0;
      // The agent acted on a context suggestion — re-arm
      // the proposal dedupe (the actionable suggestions are no longer
      // pending) and remember the turn so recently-acting suppresses fresh
      // advisory proposals instead of fighting the action just taken.
      state(ctx).proposalKeys.clear();
      state(ctx).lastContextActionTurn = state(ctx).turnCount;
      log.debug(
        `Context management tool "${toolName}" called - reset compaction and navigation escalation`,
      );
    }

    // Auto-navigate back to investigation checkpoint
    // When the agent finalizes a task, check if there are tagged checkpoints
    // from the investigation phase and suggest navigating back.
    if (toolName === "finalize") {
      try {
        const sm = getSessionManager(ctx);
        const branch = sm.getBranch();
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

        const cwd = (ctx as { cwd?: string }).cwd ?? "";
        const slug = tagsSlugFromCwd(cwd);
        const tagsFile = path.join(braidDir(), "tags", `${slug}.json`);
        let fileTags: string[] = [];
        try {
          if (existsSync(tagsFile)) {
            const content = readFileSync(tagsFile, "utf-8");
            fileTags = Object.keys(JSON.parse(content)).filter((t) => t.startsWith("before-"));
          }
        } catch {
          // Corrupt/absent tags file — proposal merge proceeds with session
          // tags only; nothing durable is at risk.
        }

        const allTags = [...new Set([...tags, ...fileTags])];
        if (allTags.length > 0) {
          const tagList = allTags
            .slice(0, 3)
            .map((t) => `\`${t}\``)
            .join(", ");
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
            { delivery: "park", deliverAs: "steer" },
            { type: "context", source: "context-lifecycle/navigate-back-suggestion" },
          );
          log.info(`Suggested navigating back to checkpoint: ${allTags[0]}`);
        }
      } catch {
        // Suggestion path is advisory steering; a missing checkpoint target
        // must not fail the escalation flow that produced it.
      }
    }
  });

  // Proposals Tool
  pi.registerTool({
    name: "context_proposals",
    exposure: "deferred",
    label: "Context Proposals",
    promptSnippet: "View and manage auto-generated context proposals",
    description:
      "List, approve, or reject auto-generated context proposals (pending compaction/archive suggestions).",
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
            const icon =
              p.priority === "high" ? "[high]" : p.priority === "medium" ? "[med]" : "[low]";
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
          state(ctx).proposalsByEntryId.set(id, proposal);

          state(ctx).outcomes.push({
            proposalId: id,
            resolution: "approved",
            turnsToResolve: state(ctx).turnCount - proposal.turn,
            timestamp: Date.now(),
          });

          return {
            content: [
              { type: "text" as const, text: `[v] Approved **${id}**: ${proposal.message}` },
            ],
            details: {
              approved: id,
              proposal,
              nextStep: { tool: "context_inspect", detail: "quick" },
            },
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
          state(ctx).proposalsByEntryId.set(id, proposal);

          state(ctx).outcomes.push({
            proposalId: id,
            resolution: "rejected",
            turnsToResolve: state(ctx).turnCount - proposal.turn,
            timestamp: Date.now(),
          });

          // Remember that this suggestion class was declined
          // so the real-need gate backs off re-proposing it (compliance
          // feedback) for the rest of the session.
          state(ctx).declinedKeys.add(proposalKeyFor(proposal.message, proposal.suggested_action));

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
          // Policies, governance, topicHistory come
          // from the per-session state via state(ctx).policyEngine /
          // state(ctx).detector. Each session sees its own engine.
          const ctxState = state(ctx);
          const policies = ctxState.policyEngine.policies;
          const governance = ctxState.policyEngine.governance;

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

  // No context_signal tool (internal API, not agent-facing). queueSignal()
  // remains exported from signal-detector.ts for direct extension use:
  //   import { queueSignal, createDetectorState } from "./signal-detector.js";
  //   queueSignal(detectorState, "task_boundary", { action: "tag" });
}
