/**
 * Heartbeat Scheduler - proactive cognitive scheduling based on paper 2604.14178.
 *
 * Triggers interventions before problems arise: silence, context overflow, error accumulation.
 * This file is the extension entry point. Logic is decomposed into sub-modules:
 *   - types.ts Type definitions
 *   - state.ts State management and configuration
 *   - policies.ts Default policies (verification, context monitor)
 *   - meta-learning.ts Adaptive tick interval adjustment
 *   - modules/ Individual cognitive modules (recaller, reflection-consolidator,
 *     context-hygiene, evolver, ...). `dreamerModule` is the test-facing alias
 *     re-exported below, not a module file.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createPolicyEngine,
  getPolicyEngine,
  getBeliefStore,
  cleanupSession,
  type PolicyContext,
} from "../../../lib/store/belief-store.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { fenceMemoryContext } from "../../../lib/utils/memory-fence.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import {
  getRssGrowthWhisperShown,
  markRssGrowthWhisperShown,
  getContextEmergencyOffloadRunner,
} from "../../../lib/state/global-state.js";
import {
  processConsolidationTick,
  executeConsolidation,
} from "../../../lib/events/consolidation-channel.js";
import { heartbeatCheckpointTick } from "../../../lib/state/state-checkpoint.js";
import { getSessionHealth, recordConsolidationSkip } from "../../enforcement/session-health.js";
import { extractSOP } from "../../../lib/utils/sop-extractor.js";
import {
  injectSopSuggestions,
  trackSuggestionFeedback,
} from "../../../lib/utils/sop-suggestion.js";
import type { TrajectoryEntry } from "../../../lib/utils/sop-extractor.js";
import {
  isDegraded,
  recordTurnMetrics,
  captureSystemMetrics,
} from "../../../lib/detection/degradation-detector.js";
import {
  collectAndEmitContextHeartbeat,
  noteAssistantMessageEnd,
} from "../../../lib/telemetry/context-heartbeat.js";
import type { Episode } from "../../../lib/types/episode-types.js";
import { retrieveEpisodes, addEpisode } from "../../memory/three-memory-stores/index.js";
import { getSessionIdSafe } from "../../../lib/state/extension-state.js";
import { deriveProjectIdFromCwd } from "../../../lib/memory/past-insights.js";
import { shouldWriteOutcomeEpisode } from "../../../lib/memory/write-quality.js";
import { getMemoryWriteGateConfig } from "../../../lib/config/braid-settings.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";

/** Derive a short project id from the current working directory. */
function deriveProject(ctx: ExtensionContext): string {
  return typeof ctx.cwd === "string" ? deriveProjectIdFromCwd(ctx.cwd) : "unknown";
}

/** Per-session slot holding the prompt captured before the run's first turn. */
interface TurnStartPromptState {
  prompt: string;
}

function getTurnStartPrompt(ctx: ExtensionContext): TurnStartPromptState {
  return getExtensionState(ctx, "turn-start-prompt", () => ({ prompt: "" }));
}

/**
 * Newest user-role text in the live branch, for runs whose prompt this process
 * never saw: a resumed session's first turn has no before_agent_start capture,
 * and pi appends the user message in its message_end handler, after
 * turn_start(0). Branch entries wrap the message - a user turn is
 * entry.type === "message" with entry.message.role === "user".
 */
function newestUserText(ctx: ExtensionContext): string {
  try {
    const sm = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
    const branch = sm?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (entry?.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => part as { type?: string; text?: string })
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n");
      }
      return "";
    }
  } catch {
    // Best-effort: a stale ctx or an absent tree yields no text.
  }
  return "";
}

import type { CognitiveModule, ModuleContext, PolicyEngine } from "./types.js";
import { DEFAULT_CONFIG, getState, getMemoryState } from "./state.js";
import { updateMetaLearning, getAdaptiveInterval } from "./meta-learning.js";
import {
  createDefaultPolicies,
  isVerificationToolCall,
  WEB_TOOLS,
  CODE_TOOLS,
} from "./policies.js";
import {
  formatPendingCompactionsLine,
  maybeArmAutoCompaction,
} from "../../memory/context-manager/handlers/tools/context-compress.js";
import { pushBounded } from "../../../lib/utils/bounded.js";
import type { TurnBoundary } from "../../../lib/events/turn-boundary.js";
import { RSS_RING_CAP } from "../../../lib/telemetry/rss-telemetry.js";
import { recallerModule } from "./modules/recaller.js";
import { reflectionConsolidatorModule } from "./modules/reflection-consolidator.js";
import { contextHygieneModule } from "./modules/context-hygiene.js";
import { measurementModule } from "./modules/measurement.js";
import { budgetModule } from "./modules/budget.js";
import { evolverModule } from "./modules/evolver.js";
import { behavioralDriftModule } from "./modules/behavioral-drift.js";
import {
  TURN_END,
  TOOL_CALL,
  SESSION_SHUTDOWN,
  MESSAGE_END,
  AGENT_END,
} from "../../../lib/core/event-names.js";

export { reflectionConsolidatorModule as dreamerModule };

const log = createLogger("heartbeat");

// Delayed Whisper Buffer
// Per-session buffer for heartbeat whispers. Instead of delivering whispers
// immediately (which puts them between turns, creating conversational adjacency
// confusion), we buffer them here and flush on the next before_agent_start.
// This way the agent sees whispers as part of the turn context, not as
// standalone messages that could be confused with user input.
//
// Keyed by sessionId (from getSessionIdSafe). Cleaned up on session_shutdown.
interface WhisperBufferEntry {
  message: string;
  priority: string;
  source: string;
}
const _heartbeatWhisperBuffer = new Map<string, WhisperBufferEntry[]>();

// Outcome-episode write gate.
// Review-before-write quality gate on the session_outcome sender. The hasSignal
// tripwire + settings toggle + cooldown live in lib/memory/write-quality.ts;
// lastWriteAt is owned here (module scope, survives across sessions within the
// process) so the cooldown actually throttles back-to-back session ends.
let _lastOutcomeWriteAt = 0;

function bufferHeartbeatWhisper(
  sessionId: string,
  message: string,
  priority: string,
  source: string,
): void {
  let buffer = _heartbeatWhisperBuffer.get(sessionId);
  if (!buffer) {
    buffer = [];
    _heartbeatWhisperBuffer.set(sessionId, buffer);
  }
  // The buffer normally drains on the next before_agent_start, but
  // ticks can pile up while the session is idle (no before_agent_start to
  // flush). Cap at 100 entries per session, drop-oldest — stale heartbeat
  // messages past 100 are noise by definition.
  pushBounded(buffer, { message, priority, source }, 100);
}

function flushDelayedWhispers(sessionId: string, pi: ExtensionAPI, selfState?: string): void {
  const buffer = _heartbeatWhisperBuffer.get(sessionId);
  if (!buffer || buffer.length === 0) return;
  const batch = buffer.splice(0);

  // Deduplicate near-duplicate messages: extract a semantic type key from
  // each message. Messages of the same type (e.g., "Context at 40%..." and
  // "Context at 50%...") collapse to one, so the Heartbeat Summary never
  // lists 9 near-identical context-percentage messages with slightly
  // different token counts.
  function dedupKey(message: string): string {
    // Context percentage messages: "Context at 40%. context_tag..."
    if (/^Context at \d+%/.test(message)) return "context-percentage";
    // Duplicate count messages: "39 near-duplicate messages..."
    if (/^\d+ near-duplicate messages/.test(message)) return "duplicate-count";
    // Context density messages
    if (/^Low context density/.test(message)) return "density-low";
    if (/^High density/.test(message)) return "density-high";
    if (/^Context density still low/.test(message)) return "density-low-persistent";
    // Proactive projection messages
    if (/^\[proactive\]/.test(message)) return "proactive-projection";
    // Degradation messages
    if (/^Degradation detected/.test(message)) return "degradation";
    // Fallback: use first 80 chars
    return message.slice(0, 80);
  }
  interface DedupEntry {
    message: string;
    priority: string;
  }
  const deduped: DedupEntry[] = [];
  const seen = new Set<string>();
  for (const entry of batch) {
    const key = dedupKey(entry.message);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ message: entry.message, priority: entry.priority });
  }

  // Aggregate by priority tier
  const groups = new Map<string, string[]>();
  for (const entry of deduped) {
    const p = entry.priority;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(entry.message);
  }

  for (const [, messages] of groups) {
    // Fresh clock: every Heartbeat Summary carries a `now:` line (date +
    // owner-TZ time via the ONE formatter) so a long session never reasons on
    // a stale clock — the heartbeat is the only mid-session channel guaranteed
    // to re-fire. One context-health line follows the clock (tokens /
    // cache-hit / near-dups / tok-s trend), so every heartbeat delivery is
    // also a self-state checkpoint.
    const nowLine = `now: ${formatLocalTime(new Date(), true)}`;
    const selfStateSuffix = selfState ? `\n${selfState}` : "";
    const text =
      messages.length === 1
        ? `${nowLine}${selfStateSuffix}\n${messages[0]}`
        : `[Heartbeat Summary]\n${nowLine}${selfStateSuffix}\n${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "heartbeat",
          content: [{ type: "text" as const, text }],
          display: true,
          details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "heartbeat/delayed" },
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "heartbeat", source: "heartbeat/delayed" },
      );
    } catch (err) {
      log.warn(`[heartbeat] delayed whisper flush failed: ${err}`);
    }
  }
}

// SOP Formatting

/** Format SOP (3-tier hierarchy) for whispering to agent */
export function formatSOPForWhisper(episode: Episode): string {
  const parts: string[] = [];

  if (episode.strategicSOP) {
    parts.push(`**Strategy**: ${episode.strategicSOP}`);
  }

  if (episode.functionalSOP && episode.functionalSOP.length > 0) {
    const steps = episode.functionalSOP.map((step, i) => `${i + 1}. ${step}`).join("\n");
    parts.push(`**Key Steps**:\n${steps}`);
  }

  if (episode.atomicSOP && episode.atomicSOP.length > 0) {
    parts.push(`**Tools**: ${episode.atomicSOP.join(" -> ")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : `SOP for: ${episode.task.slice(0, 100)}`;
}

/**
 * Deliver the SOP coach whisper through the tracked channel.
 *
 * `ctx.whisper` is a type-only augmentation with no runtime implementation —
 * a whisper sent there silently never fires, and would bypass the per-source
 * flood cap, injection tracking, and the universal
 * `[braid-whisper - heartbeat]` envelope. `sendTrackedMessage` (the trunk)
 * is the delivery path; see `lib/utils/whisper-format.ts`.
 */
export function sendSopCoachWhisper(pi: ExtensionAPI, message: string): void {
  sendTrackedMessage(
    pi,
    {
      customType: "heartbeat",
      content: [{ type: "text" as const, text: message }],
      display: true,
    },
    { delivery: "park", deliverAs: "steer" },
    { type: "context", source: "heartbeat/sop-coach" },
  );
}

// Whisper Batching
// flushWhisperBuffer lives in ./whisper-batcher.ts. The tick function
// imports it to flush module whispers as aggregated messages.
import { flushWhisperBuffer } from "./whisper-batcher.js";
import { buildSelfStateLine } from "./whisper-batcher.js";
import { getSelfStateSample } from "../../../lib/telemetry/context-heartbeat.js";

// Tick Engine

function tick(
  pi: ExtensionAPI,
  state: import("./types.js").HeartbeatState,
  config: import("./types.js").HeartbeatConfig,
  ctx: ExtensionContext,
  turnEvent?: TurnBoundary,
): void {
  state.stats.totalTicks++;

  // Real telemetry: collect live context/RSS/session metrics, append the
  // JSONL heartbeat line, and feed recordTurnMetrics real values (not
  // placeholder constants). Sink failures are non-fatal inside the
  // telemetry module; the degradation feed below tolerates unavailable
  // samples (zeros).
  const telemetry = collectAndEmitContextHeartbeat(ctx, {
    turnNumber: state.turnCount,
    healthMode: getSessionHealth(ctx).mode,
    source: "heartbeat",
  });

  // Tool outcome stats from the capped trajectory (real error accounting).
  const trajectory = state.metaLearning.toolTracking.trajectory ?? [];
  const trajectoryErrors = trajectory.reduce((n, t) => n + (t.success ? 0 : 1), 0);
  let trailingErrors = 0;
  for (let i = trajectory.length - 1; i >= 0; i--) {
    if (trajectory[i].success) break;
    trailingErrors++;
  }

  recordTurnMetrics(ctx, {
    turnNumber: state.turnCount,
    avgTurnDurationMs: telemetry.lastAssistantDurationMs ?? 0,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    toolCalls: state.metaLearning.toolTracking.totalToolsUsed,
    errors: trajectoryErrors,
    errorRate: trajectory.length > 0 ? trajectoryErrors / trajectory.length : 0,
    toolSuccessRate:
      trajectory.length > 0
        ? ((trajectory.length - trajectoryErrors) / trajectory.length) * 100
        : 100,
    consecutiveErrors: trailingErrors,
    tokenUsage: { input: telemetry.inputTokens, output: telemetry.outputTokens },
    memoryUsagePercent: captureSystemMetrics().memoryUsagePercent,
  });

  // sustained RSS growth advisory (ONE per boot, no spam)
  // The ring + baseline + verdict come from the telemetry module above. A
  // FULL 24-sample ring sitting entirely above 2x the boot baseline is the
  // accumulator-growth signature; the latch (process-global, global-state.ts)
  // guarantees at most one advisory per boot. Advisory: buffered heartbeat
  // message, never a wake.
  if (telemetry.rssSustainedGrowth && !getRssGrowthWhisperShown()) {
    markRssGrowthWhisperShown();
    const baseMb = ((telemetry.rssBaselineBytes ?? 0) / 1048576).toFixed(0);
    const curBytes = telemetry.rssRing[telemetry.rssRing.length - 1] ?? 0;
    const curMb = (curBytes / 1048576).toFixed(0);
    const sid0 = getSessionIdSafe(ctx) ?? "anonymous";
    bufferHeartbeatWhisper(
      sid0,
      `[memory] Sustained RSS growth: ${curMb}MB now vs ${baseMb}MB boot baseline ` +
        `(>2x across ${RSS_RING_CAP} heartbeat samples). Unbounded in-memory accumulator ` +
        `likely — investigate (context_inspect, /logs) before the next OOM. ` +
        `This advisory fires once per boot.`,
      "medium",
      "heartbeat/rss-growth",
    );
    log.warn(
      `[heartbeat] RSS sustained-growth advisory fired: ${(curBytes / 1048576).toFixed(0)}MB vs ${baseMb}MB baseline (${RSS_RING_CAP}-sample ring)`,
    );
  }

  // armed-compaction visibility + usage-driven auto-arm
  // A compaction armed by context_compress fires at the next turn boundary
  // (turn_end) or at run settle. While it sits armed, live usage reads
  // pre-compaction state — the pending state must stay visible in every
  // heartbeat summary until it lands (a once-per-tier advisory went quiet
  // exactly while nothing was landing), and usage sustained above the
  // configured threshold must arm relief on its own: same pending queue,
  // same boundary discipline (arming only queues; the compact still fires at
  // a safe boundary, never mid-run). Best-effort: neither surface may break
  // the tick.
  try {
    const pendingLine = formatPendingCompactionsLine(ctx);
    if (pendingLine) {
      bufferHeartbeatWhisper(
        getSessionIdSafe(ctx) ?? "anonymous",
        pendingLine,
        "high",
        "heartbeat/pending-compaction",
      );
    }
  } catch (err) {
    log.warn(`[heartbeat] pending-compaction advisory failed: ${err}`);
  }
  try {
    maybeArmAutoCompaction(pi, ctx, turnEvent);
  } catch (err) {
    log.warn(`[heartbeat] context auto-arm check failed: ${err}`);
  }

  try {
    eventBus.emit({
      type: "heartbeat_tick",
      turn: state.turnCount,
      tickCount: state.stats.totalTicks,
      timestamp: Date.now(),
    });
  } catch (err) {
    log.warn(`[heartbeat] Could not emit tick event: ${err}`);
  }

  state.policyTurnCount++;

  updateMetaLearning(state);

  // Evaluate policies on each tick
  if (state.policyEngineReady) {
    const sessionId = getSessionIdSafe(ctx) ?? ctx.cwd ?? String(process.pid);
    const engine = getPolicyEngine(sessionId);
    if (engine) {
      const policyCtx: PolicyContext = {
        sessionId,
        turnNumber: state.policyTurnCount,
        toolStats: new Map(),
        cwd: ctx.cwd ?? ".",
        getContextUsage: () => ctx.getContextUsage(),
      };
      engine
        .evaluate(policyCtx)
        .then((fired) => {
          if (fired.length > 0) {
            log.info(`Policies fired: ${fired.map((p) => p.id).join(", ")}`);
          }
        })
        .catch((err) => {
          log.error("Policy evaluation error:", err);
        });
    }
  }

  // Build module context from heartbeat state. Modules call context.whisper()
  // (not ctx.whisper?.()) to honor the flood cap: the whisperBuffer collects
  // all module whispers; the tick handler flushes them via sendTrackedMessage.
  const whisperBuffer: Array<{ message: string; priority: string }> = [];

  // Per-tick AbortController for ESC propagation
  // Create a fresh AbortController for this tick; modules receive it
  // as context.abortSignal for cancellation-aware calls. On
  // session_shutdown, the controller is aborted, cancelling any
  // in-flight call instead of letting it run for its full timeout
  // (10m default) after the session ends.
  const tickController = new AbortController();
  const abortState = getExtensionState<{ controller: AbortController | null }>(
    ctx,
    "heartbeat-abort",
    () => ({ controller: null }),
  );
  abortState.controller = tickController;

  const moduleContext: ModuleContext = {
    ctx,
    abortSignal: tickController.signal,
    turnCount: state.turnCount,
    lastActivation: state.lastActivation,
    sessionAge: state.turnCount,
    toolCallsSinceLastTick: [],
    totalToolCalls: state.metaLearning.toolTracking.totalToolsUsed,
    silentTurns:
      state.stats.totalTicks > 0
        ? Math.max(
            0,
            state.stats.totalTicks - (state.metaLearning.toolTracking.lastToolCallTurn || 0),
          )
        : 0,
    metadata: {
      toolFailures:
        state.metaLearning.toolTracking.totalToolsUsed > 10
          ? Math.max(0, Math.floor(state.metaLearning.toolTracking.totalToolsUsed * 0.15))
          : 0,
      decompositionDepth: 0,
    },
    whisper: (msg, opts) => {
      whisperBuffer.push({ message: msg, priority: opts?.priority ?? "low" });
    },
  };

  // Evaluate which modules should activate
  const candidates: Array<{ module: CognitiveModule; priority: number; reg: any }> = [];

  for (const [, reg] of state.modules) {
    if (!reg.enabled) continue;
    try {
      if (reg.module.shouldActivate(moduleContext)) {
        candidates.push({ module: reg.module, priority: reg.module.priority, reg });
      }
    } catch (err) {
      log.error(`Module "${reg.module.name}" shouldActivate error:`, err);
    }
  }

  // Whisper batching: moduleContext.whisper() is the API modules call; it
  // pushes to whisperBuffer (declared above) instead of mutating ctx.
  // Modules that still call ctx.whisper directly bypass the per-source flood
  // cap; future module migrations should adopt context.whisper().

  candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, config.maxActivationsPerTick)
    .forEach(async ({ module, reg }) => {
      try {
        await module.activate(moduleContext);
        reg.activations++;
        reg.lastActivated = state.turnCount;
        state.lastActivation.set(module.name, state.turnCount);
        state.stats.totalActivations++;
        state.stats.activationsByModule[module.name] =
          (state.stats.activationsByModule[module.name] ?? 0) + 1;

        state.activationHistory.push({
          tick: state.stats.totalTicks,
          moduleName: module.name,
          timestamp: Date.now(),
          reason: "heartbeat",
        });

        if (state.activationHistory.length > 100) {
          state.activationHistory.shift();
        }

        state.metaLearning.pendingSignals.set(module.name, state.turnCount);
        state.metaLearning.activationSignalWindow.set(module.name, state.turnCount);

        log.info(`Activated module "${module.name}" (priority ${module.priority.toFixed(1)})`);
      } catch (err) {
        log.error(`Module "${module.name}" activate error:`, err);
      }
    });

  // Auto-checkpoint + auto-rollback
  const sessionId = getSessionIdSafe(ctx) ?? ctx.cwd ?? String(process.pid);

  // Consolidation Channel - fire-and-forget
  processConsolidationTick(ctx).catch((err) => {
    log.error("Consolidation tick error:", err);
  });

  heartbeatCheckpointTick(ctx, state.turnCount, sessionId, isDegraded(ctx))
    .then((result) => {
      if (result.checkpointCreated) {
        log.info(`Auto-checkpoint created at turn ${state.turnCount}`);
      }
      if (result.rollbackPerformed) {
        log.warn(`Auto-rollback performed: ${result.message}`);
        whisperBuffer.push({
          message: `Auto-rollback: ${result.message}`,
          priority: "high",
        });
      }
      if (result.rollbackSuppressed) {
        // Test-debug guard: destructive rollback withheld on a
        // test-runner-dominated error burst. Advice stays, action withheld —
        // the agent hears the degradation signal without a conversation rewind.
        log.warn(`Auto-rollback suppressed (test-debug loop): ${result.message}`);
        whisperBuffer.push({
          message:
            `Degradation detected but the recent error burst is test-runner dominated — ` +
            `auto-rollback withheld (failing tests are expected in TDD/gate triage). ` +
            `If this is NOT an intentional test loop, run health_maintenance(action="check").`,
          priority: "medium",
        });
      }
    })
    .catch((err) => {
      log.error("Checkpoint tick error:", err);
    })
    .finally(() => {
      // Flush via the proper tracked channel: the buffer is collected by
      // moduleContext.whisper(). Modules that still call ctx.whisper directly
      // (not yet migrated) go through the original sendTrackedMessage channel
      // so they still get batched + flood-capped.
      const sendFn = (msg: string, opts?: { category?: string; priority?: string }) => {
        const sid = getSessionIdSafe(ctx) ?? "anonymous";
        bufferHeartbeatWhisper(sid, msg, opts?.priority ?? "low", "heartbeat/whisper-batcher");
      };
      // Self-state (Refine-2): the tick summary carries the self-state
      // line (fresh telemetry was collected at the top of this tick).
      flushWhisperBuffer(whisperBuffer, sendFn, buildSelfStateLine(getSelfStateSample(ctx)));
    });
}

// Extension

export default function heartbeatExtension(pi: ExtensionAPI) {
  const config = { ...DEFAULT_CONFIG };

  // Register built-in modules. Timer reminders are not a module: the timer
  // extension's own wake/reminder delivery (timer/index.ts) is the
  // canonical path — one timer fire, one whisper.
  const builtInModules: CognitiveModule[] = [
    recallerModule,
    reflectionConsolidatorModule,
    contextHygieneModule,
    measurementModule,
    evolverModule,
    budgetModule,
    behavioralDriftModule,
  ];

  // Event: turn_end

  pi.on(TURN_END, async (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    if (!state.enabled || !config.enabled) return;

    state.turnCount++;

    eventBus.emit({
      type: "turn_complete",
      turn: state.turnCount,
      duration: Date.now(),
    });

    const interval = getAdaptiveInterval(state);
    if (state.turnCount % interval !== 0) return;

    // The boundary travels with the tick: the usage-driven auto-arm arms inside
    // this dispatch, and a drain there can only be judged from the event that
    // named the boundary. Dropping this argument is invisible to every other
    // fixture, so one drives the real handler end to end:
    // test/runtime/heartbeat/test-turn-boundary-arm-wiring.mjs.
    tick(pi, state, config, ctx, event);
  });

  // Event: before_agent_start - flush delayed whispers
  // Deliver buffered heartbeat whispers as part of the turn context,
  // not as standalone messages between turns. This prevents the
  // conversational adjacency confusion where the agent treats a
  // between-turn whisper as user input.
  pi.on("before_agent_start", (event: unknown, ctx: ExtensionContext) => {
    const sid = getSessionIdSafe(ctx) ?? "anonymous";
    // turn_start carries no user text (TurnStartEvent = type/turnIndex/timestamp),
    // so capture the run's prompt here - the last point pi exposes it before
    // turn 0. A failed capture leaves the slot untouched: empty on the session's
    // first capture, so the branch fallback takes over; otherwise the previous
    // capture stands.
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      getTurnStartPrompt(ctx).prompt = prompt;
    }
    // Self-state (Refine-2): every heartbeat-family delivery carries the
    // self-state line. Sampling never throws; missing telemetry -> "n/a".
    flushDelayedWhispers(sid, pi, buildSelfStateLine(getSelfStateSample(ctx)));
  });

  // Event: tool_call

  pi.on(TOOL_CALL, async (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);

    try {
      const toolName = event?.toolName as string;
      if (toolName) trackSuggestionFeedback(ctx, toolName);
    } catch {
      // Suggestion telemetry is observational — a malformed event must not
      // break the tool-execution pipeline it observes.
    }

    // Meta-learning signal detection
    if (state.metaLearning.pendingSignals.size > 0) {
      state.metaLearning.postActivationToolCount++;
    }

    state.metaLearning.toolTracking.totalToolsUsed++;
    state.metaLearning.toolTracking.lastToolCallTurn = state.policyTurnCount;

    const toolName = event?.toolName as string;
    if (!toolName) return;

    // Verification activity is a name set plus bash by its command shape:
    // a search or diff run through bash is the same activity the hint is
    // about, and counting every bash call (edits, builds) would silence it.
    if (isVerificationToolCall(toolName, event?.input)) {
      state.metaLearning.toolTracking.verificationCount++;
      state.metaLearning.toolTracking.lastVerificationTurn = state.policyTurnCount;
    }
    if (WEB_TOOLS.has(toolName)) {
      state.metaLearning.toolTracking.lastWebFetchTurn = state.policyTurnCount;
    }
    if (CODE_TOOLS.has(toolName)) {
      state.metaLearning.toolTracking.lastCodeExecutionTurn = state.policyTurnCount;
    }

    const sessionId = getSessionIdSafe(ctx) ?? ctx.cwd ?? String(process.pid);
    const store = getBeliefStore(sessionId);
    if (store) {
      store.add({
        id: `tool-${toolName}-${Date.now()}`,
        content: `Tool ${toolName} executed at turn ${state.policyTurnCount}`,
        source: "observation",
        confidence: 0.9,
        timestamp: Date.now(),
        tags: ["tool", toolName],
      });
    }
  });

  // Event: message_end - assistant tps telemetry feed
  // Duration = now - message.timestamp
  // (stream-start proxy), usage.input/output from the final assistant
  // message. Feeds tokensPerSec + the real token metrics in tick().
  // No LLM calls, no whispering — pure observation.
  pi.on(MESSAGE_END, (event: any, ctx: ExtensionContext) => {
    try {
      noteAssistantMessageEnd(ctx, event?.message);
    } catch {
      // telemetry never fatal
    }
  });

  // Event: tool_result - collect tool success/failure for trajectory enrichment
  pi.on("tool_result", (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    const toolName = event?.toolName as string;
    if (!toolName) return;

    // Track tool outcome for richer SOP extraction
    const success = !event?.isError;
    state.metaLearning.toolTracking.trajectory ??= [];
    state.metaLearning.toolTracking.trajectory.push({
      toolName,
      success,
      turn: state.policyTurnCount,
    });

    // Cap trajectory length
    if (state.metaLearning.toolTracking.trajectory.length > 200) {
      state.metaLearning.toolTracking.trajectory =
        state.metaLearning.toolTracking.trajectory.slice(-100);
    }
  });

  // Event: session_start
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: any, ctx: ExtensionContext) => {
      const state = getState(ctx);

      for (const module of builtInModules) {
        if (!state.modules.has(module.name)) {
          state.modules.set(module.name, {
            module,
            enabled: true,
            activations: 0,
            lastActivated: 0,
            effectiveness: 0.5,
          });
          log.info(`Registered module "${module.name}"`);
        }
      }

      const sessionId = getSessionIdSafe(ctx) ?? ctx.cwd ?? String(process.pid);
      const engine = createPolicyEngine(sessionId);
      state.policyTurnCount = 0;
      state.policyEngineReady = true;

      const onSignal = (type: string, _data: Record<string, unknown>) => {
        state.activationHistory.push({
          tick: state.stats.totalTicks,
          moduleName: type,
          timestamp: Date.now(),
          reason: "policy",
        });
      };

      const defaultPolicies = createDefaultPolicies(
        () => state.metaLearning.toolTracking,
        onSignal,
        // Policy engine whisper uses the proper sendTrackedMessage channel
        // (honors flood cap and injection tracking) instead of ctx.whisper.
        // The per-tick aggregation (whisperBuffer) is for module whispers;
        // policy whispers are signal-triggered and fire independently of the
        // tick.
        //
        // Policy whispers are buffered and delivered on the next
        // before_agent_start instead of immediately, preventing
        // conversational adjacency confusion (the agent treating a
        // between-turn whisper as user input). The auto-finalize callback
        // (below) still delivers immediately because it uses
        // deliverAs:"steer" and is time-critical (at ≥90% context the
        // whisper may never get a next turn — steer it into the current run).
        (msg: string) => {
          const sid = getSessionIdSafe(ctx) ?? "anonymous";
          bufferHeartbeatWhisper(sid, msg, "medium", "heartbeat/policy");
        },
        (msg: string) => {
          sendTrackedMessage(
            pi,
            {
              customType: "heartbeat",
              content: [{ type: "text" as const, text: msg }],
              display: true,
            },
            { delivery: "live", deliverAs: "steer" },
            { type: "heartbeat", source: "heartbeat/auto-finalize" },
          );
        },
      );
      for (const policy of defaultPolicies) {
        engine.register(policy);
      }
      log.info(
        `Policy engine initialized with ${defaultPolicies.length} default policies (tool tracking active)`,
      );

      // Activate policy engine wrapper
      activatePolicyEngine(engine, state, ctx);

      // SOP Retrieval + Coach Decision
      try {
        const memState = getMemoryState(ctx);
        if (memState) {
          const project = ctx.cwd ?? "unknown";
          const episodes = retrieveEpisodes(memState, project, 3, project);
          if (episodes && episodes.length > 0) {
            const topEpisode = episodes[0];
            if (topEpisode.similarity > 0.3) {
              // Recalled episode SOPs are fenced non-user context.
              const sopSummary = fenceMemoryContext(formatSOPForWhisper(topEpisode));
              // Deliver via the tracked channel so the whisper actually
              // fires (ctx.whisper is a type-only augmentation, no runtime
              // implementation) and carries the [braid-whisper - heartbeat]
              // envelope.
              sendSopCoachWhisper(pi, sopSummary);
              log.info(`Coach: Whispered SOP from past episode ${topEpisode.id}`);
            }
          }
        }
      } catch (err) {
        log.debug(`SOP retrieval skipped: ${(err as Error).message}`);
      }
    },
  );

  // Event: turn_start - inject relevant SOPs from past episodes

  pi.on("turn_start", async (_event: any, ctx: ExtensionContext) => {
    try {
      const memState = getMemoryState(ctx);
      if (memState && memState.episodes) {
        // The turn's user text is not on the event; consult the prompt
        // captured at before_agent_start, falling back to the live branch.
        const userText = getTurnStartPrompt(ctx).prompt || newestUserText(ctx);
        if (userText.length > 5) {
          try {
            const sopState = getExtensionState(ctx, "sop-suggestion", () => ({
              suggestedEpisodeIds: new Set<string>(),
            }));
            // Derive project ID from cwd (last 2 path components)
            const cwdParts = (ctx.cwd ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
            const currentProject =
              cwdParts.length >= 2 ? cwdParts.slice(-2).join("/") : (ctx.cwd ?? "unknown");

            injectSopSuggestions(
              pi,
              ctx,
              userText,
              memState.episodes,
              sopState.suggestedEpisodeIds,
              currentProject,
            );
          } catch {
            // Non-fatal: basic suggestion without dedup
            const cwdParts = (ctx.cwd ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
            const currentProject =
              cwdParts.length >= 2 ? cwdParts.slice(-2).join("/") : (ctx.cwd ?? "unknown");
            injectSopSuggestions(pi, ctx, userText, memState.episodes, undefined, currentProject);
          }
        }
      }
    } catch (err) {
      log.debug(`SOP suggestion skipped: ${(err as Error).message}`);
    }
  });

  // Event: agent_end

  pi.on(AGENT_END, async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    // agent_end carries only `messages`; the run outcome is the final
    // assistant message's stopReason, classified the way pi classifies its
    // own activity outcome (agent-session _dispatchTurnEndBoundary).
    const messages = Array.isArray(_event?.messages) ? _event.messages : [];
    const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
    const outcome =
      lastAssistant?.stopReason === "aborted"
        ? "aborted"
        : lastAssistant?.stopReason === "error"
          ? "error"
          : "completed";
    log.info(
      `Session ended. Ticks: ${state.stats.totalTicks}, ` +
        `Activations: ${state.stats.totalActivations}, ` +
        `Tools: ${state.metaLearning.toolTracking.totalToolsUsed}, ` +
        `Outcome: ${outcome}`,
    );
    for (const [name, count] of Object.entries(state.stats.activationsByModule)) {
      log.info(`  ${name}: ${count} activations`);
    }

    try {
      const memState = getMemoryState(ctx);
      if (memState) {
        // agent_end carries no task descriptor; the sentinel is the fallback
        // the write gate and the recall filter already expect.
        const taskDesc = "session_outcome";
        const success = outcome === "completed";

        // Use enriched trajectory from tool_end tracking (has success/failure data)
        // Fall back to activation history if tool_end wasn't available
        const enrichedTrajectory = state.metaLearning.toolTracking.trajectory ?? [];
        const trajectory: TrajectoryEntry[] =
          enrichedTrajectory.length > 0
            ? enrichedTrajectory.map((t: any) => ({
                toolName: t.toolName,
                success: t.success,
              }))
            : state.activationHistory
                .filter((h) => h.moduleName === "tool_call" || h.reason === "tool")
                .map((h) => ({ toolName: h.moduleName, success: true }));

        // Extract SOP from the trajectory (uses LLM pattern detection when ctx available)
        const sop = await extractSOP({
          task: taskDesc,
          trajectory,
          solution: `Ticks:${state.stats.totalTicks} Tools:${state.metaLearning.toolTracking.totalToolsUsed}`,
          outcome: success ? "success" : "partial",
          ctx,
        });

        // Review-before-write quality gate (hasSignal tripwire + settings
        // toggle + cooldown) decides "is this episode worth writing?" before
        // addEpisode on this sender. The shared hasSignal suppressor lives in
        // lib/memory/write-quality.ts; the config is read fresh each event
        // (settings-over-env via braid-settings.ts). Cooldown state is owned
        // at module scope so back-to-back session ends never thrash. With the
        // toggle OFF only the literal "session_outcome" sentinel kill applies.
        const writeGate = getMemoryWriteGateConfig();
        if (shouldWriteOutcomeEpisode(writeGate, taskDesc, sop.strategicSOP, _lastOutcomeWriteAt)) {
          if (writeGate.enabled) _lastOutcomeWriteAt = Date.now(); // gated writes only
          addEpisode(
            memState,
            taskDesc,
            sop.strategicSOP,
            success ? "success" : "partial",
            sop.atomicSOP,
            ["session", "outcome", success ? "success" : "partial"],
            deriveProject(ctx), // project
            sop.strategicSOP,
            sop.functionalSOP,
            sop.atomicSOP,
          );
          log.info(
            `[heartbeat] Outcome episode recorded: ${success ? "success" : "partial"} ` +
              `(SOP: ${sop.functionalSOP.length} steps, ${sop.atomicSOP.length} tools)`,
          );
        } else {
          log.debug(
            `[heartbeat] Outcome episode skipped by write-quality gate ` +
              `(task=${JSON.stringify(taskDesc)})`,
          );
        }

        if (success) {
          // Layer 6: gate consolidation on session health.
          // When the LLM provider is unavailable (balance, auth) or the
          // session is degraded, the consolidation pipeline is a 402
          // waiting to happen. Score the candidate (so it persists) but
          // skip execution; the SessionHealthState tracks this so the
          // next healthy session drains the queue.
          const health = getSessionHealth(ctx);
          if (health.mode === "balance" || health.mode === "auth" || health.mode === "degraded") {
            // Counts consolidation skips per health mode; without it, a
            // latched auth mode runs for minutes with zero visibility.
            recordConsolidationSkip(ctx, health.mode);
            log.warn(
              `[heartbeat] Skipping consolidation: session health is ${health.mode} ` +
                `(consecutive errors: ${health.consecutiveErrors})`,
            );
            // Still record the episode - we want the history even when we can't act on it.
            // The episode will surface in the next healthy session via retrieveEpisodes().
          } else if (health.mode === "context_overflow") {
            // Health-gate exception: a context_window error latches
            // context_overflow and this gate then blocks every shrink that
            // could fix it — the consolidation pipeline (an LLM call)
            // is indeed a 402/413 waiting to happen in this mode, but the
            // emergency offloader is NOT an LLM pipeline: it is a
            // deterministic, lossless size-driven shrink (largest toolResults
            // → disk + stubs). Run it here so the session actually shrinks
            // while the mode is latched; consolidation itself stays skipped.
            const runner = getContextEmergencyOffloadRunner();
            if (runner) {
              try {
                const offload = await runner(ctx, "heartbeat-gate");
                if (offload.offloaded > 0) {
                  log.warn(
                    `[heartbeat] context_overflow: emergency offload freed ` +
                      `${offload.charsSaved} chars (${offload.offloaded} oversized ` +
                      `toolResult(s) stubbed); consolidation stays skipped in this mode`,
                  );
                }
              } catch (err) {
                log.warn(`[heartbeat] context_overflow emergency offload failed: ${err}`);
              }
            }
            recordConsolidationSkip(ctx, "context_overflow");
          } else {
            try {
              const result = await executeConsolidation({
                id: `ep-${Date.now()}`,
                task: taskDesc,
                outcome: "success",
                strategicSOP: sop.strategicSOP,
                functionalSOP: sop.functionalSOP,
                toolSequence: sop.atomicSOP,
              });
              if (result) {
                log.info(
                  `[heartbeat] Consolidation candidate enqueued ` +
                    `(score=${result.consolidationScore.toFixed(2)})`,
                );
              }
            } catch (err) {
              log.warn(`[heartbeat] Could not score consolidation candidate: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      log.warn(`[heartbeat] Could not record outcome episode: ${err}`);
    }
  });

  // Event: session_shutdown

  pi.on(SESSION_SHUTDOWN, async (_event: any, ctx: ExtensionContext) => {
    // CleanupSession must target the SAME key the BeliefStore was
    // created under (getSessionIdSafe at session_start), not just ctx.cwd —
    // passing only ctx.cwd leaked the per-session store in the process-global
    // stores/engines Maps whenever the key was a real session id. Delete
    // both candidate keys defensively.
    const shutdownSid = getSessionIdSafe(ctx);
    if (shutdownSid && shutdownSid !== "?") cleanupSession(shutdownSid);
    cleanupSession(ctx.cwd);
    const sid = getSessionIdSafe(ctx) ?? "anonymous";
    _heartbeatWhisperBuffer.delete(sid);
    // Abort any in-flight heartbeat LLM calls (ESC for background tasks)
    const abortCtl = getExtensionState<{ controller: AbortController | null }>(
      ctx,
      "heartbeat-abort",
      () => ({ controller: null }),
    );
    if (abortCtl.controller) {
      abortCtl.controller.abort();
      abortCtl.controller = null;
    }
    log.info("Heartbeat scheduler shutting down");
  });

  // Policy Engine Activation

  function activatePolicyEngine(
    engine: PolicyEngine,
    state: import("./types.js").HeartbeatState,
    _ctx: ExtensionContext,
  ): void {
    const originalEvaluate = engine.evaluate.bind(engine);
    engine.evaluate = async (context: PolicyContext) => {
      const fired = await originalEvaluate(context);
      if (fired.length > 0) {
        for (const policy of fired) {
          state.policyLastFire.set(policy.id, state.policyTurnCount);
        }
      }
      return fired;
    };
    log.info("[heartbeat] Policy engine activated - cognitive modules will fire on turns");
  }
}
