/**
 * Heartbeat Scheduler - proactive cognitive scheduling based on paper 2604.14178.
 *
 * Triggers interventions before problems arise: silence, context overflow, error accumulation.
 * This file is the extension entry point. Logic is decomposed into sub-modules:
 *   - types.ts        Type definitions
 *   - state.ts        State management and configuration
 *   - policies.ts     Default policies (verification, context monitor)
 *   - meta-learning.ts Adaptive tick interval adjustment
 *   - modules/        Individual cognitive modules (recaller, dreamer, etc.)
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
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { processConsolidationTick, executeConsolidation } from "../../../lib/events/consolidation-channel.js";
import { heartbeatCheckpointTick } from "../../../lib/state/state-checkpoint.js";
import { extractSOP } from "../../../lib/utils/sop-extractor.js";
import { injectSopSuggestions, trackSuggestionFeedback } from "../../../lib/utils/sop-suggestion.js";
import type { TrajectoryEntry } from "../../../lib/utils/sop-extractor.js";
import { isDegraded, recordTurnMetrics } from "../../../lib/detection/degradation-detector.js";
import type { Episode } from "../../../lib/types/episode-types.js";
import { retrieveEpisodes, addEpisode } from "../../memory/three-memory-stores/index.js";

import type { CognitiveModule, ModuleContext, PolicyEngine } from "./types.js";
import { DEFAULT_CONFIG, getState, getMemoryState } from "./state.js";
import { updateMetaLearning, getAdaptiveInterval } from "./meta-learning.js";
import { createDefaultPolicies, VERIFICATION_TOOLS, WEB_TOOLS, CODE_TOOLS } from "./policies.js";
import { recallerModule } from "./modules/recaller.js";
import { reflectionConsolidatorModule } from "./modules/reflection-consolidator.js";
import { contextHygieneModule } from "./modules/context-hygiene.js";
import { measurementModule } from "./modules/measurement.js";
import { budgetModule } from "./modules/budget.js";
import { evolverModule } from "./modules/evolver.js";
import { timerReminderModule } from "./modules/timer-reminder.js";
import { behavioralDriftModule } from "./modules/behavioral-drift.js";
import { TURN_END, TOOL_CALL, SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";

export { recallerModule };
export { reflectionConsolidatorModule };
export { reflectionConsolidatorModule as dreamerModule };
export { contextHygieneModule };
export { evolverModule };
export { measurementModule };
export { budgetModule };

const log = createLogger("heartbeat");

// ── Message Interpolation ───────────────────────────────────────────────────

/** Replace {placeholder} in message with values from context dict. */
export function interpolateMessage(message: string, ctx: Record<string, number | string>): string {
  let result = message;
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}(?:%|}|[a-zA-Z])`, "g"), String(value));
  }
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}}`, "g"), String(value));
  }
  return result;
}

// ── SOP Formatting ──────────────────────────────────────────────────────────

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
    parts.push(`**Tools**: ${episode.atomicSOP.join(" → ")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : `SOP for: ${episode.task.slice(0, 100)}`;
}

// ── Whisper Batching ───────────────────────────────────────────────────────
// flushWhisperBuffer lives in ./whisper-batcher.ts. The tick function
// imports it to flush module whispers as aggregated messages.
import { flushWhisperBuffer } from "./whisper-batcher.js";

// ── Tick Engine ─────────────────────────────────────────────────────────────

function tick(
  _pi: ExtensionAPI,
  state: import("./types.js").HeartbeatState,
  config: import("./types.js").HeartbeatConfig,
  ctx: ExtensionContext,
): void {
  state.stats.totalTicks++;

  // Record turn metrics into degradation detector so isDegraded() works
  const activationCount = state.stats.totalActivations;
  recordTurnMetrics(ctx, {
    turnNumber: state.turnCount,
    avgTurnDurationMs: 1000,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: activationCount,
    errors: 0,
    errorRate: 0,
    toolSuccessRate: 100,
    consecutiveErrors: 0,
    tokenUsage: { input: 0, output: 0 },
    memoryUsagePercent: 50,
  });

  // Emit heartbeat_tick event
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

  // Update meta-learning before processing tick
  updateMetaLearning(state);

  // Evaluate policies on each tick
  if (state.policyEngineReady) {
    const sessionId = ctx.cwd ?? String(process.pid);
    const engine = getPolicyEngine(sessionId);
    if (engine) {
      const policyCtx: PolicyContext = {
        sessionId,
        turnNumber: state.policyTurnCount,
        toolStats: new Map(),
        cwd: ctx.cwd ?? ".",
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

  // Build module context from heartbeat state
  const moduleContext: ModuleContext = {
    ctx,
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

  // ── Whisper batching ───────────────────────────────────────────────
  // Buffer module whispers and flush as aggregated messages per priority tier.
  // This prevents N separate injected messages per heartbeat tick.
  const whisperBuffer: Array<{ message: string; priority: string }> = [];
  const originalWhisper = ctx.whisper?.bind(ctx);
  ctx.whisper = (msg: string, opts?: { category?: string; priority?: string }) => {
    whisperBuffer.push({ message: msg, priority: opts?.priority ?? "low" });
  };

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
  const sessionId = ctx.cwd ?? String(process.pid);

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
          message: `[health] Auto-rollback: ${result.message}`,
          priority: "high",
        });
      }
    })
    .catch((err) => {
      log.error("Checkpoint tick error:", err);
    })
    .finally(() => {
      // Restore original whisper and flush buffer
      ctx.whisper = originalWhisper;
      flushWhisperBuffer(
        whisperBuffer,
        originalWhisper as
          | ((msg: string, opts?: { category?: string; priority?: string }) => void)
          | undefined,
      );
    });
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function heartbeatExtension(pi: ExtensionAPI) {
  const config = { ...DEFAULT_CONFIG };

  // Register built-in modules
  const builtInModules: CognitiveModule[] = [
    recallerModule,
    reflectionConsolidatorModule,
    contextHygieneModule,
    measurementModule,
    evolverModule,
    budgetModule,
    timerReminderModule,
    behavioralDriftModule,
  ];

  // ── Event: turn_end ───────────────────────────────────────────────

  pi.on(TURN_END, async (_event: any, ctx: ExtensionContext) => {
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

    tick(pi, state, config, ctx);
  });

  // ── Event: tool_call ──────────────────────────────────────────────

  pi.on(TOOL_CALL, async (event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);

    // Track SOP suggestion feedback
    try {
      const toolName = event?.toolName as string;
      if (toolName) trackSuggestionFeedback(ctx, toolName);
    } catch {
      // Non-fatal
    }

    // Meta-learning signal detection
    if (state.metaLearning.pendingSignals.size > 0) {
      state.metaLearning.postActivationToolCount++;
    }

    // Update persistent tool tracking
    state.metaLearning.toolTracking.totalToolsUsed++;
    state.metaLearning.toolTracking.lastToolCallTurn = state.policyTurnCount;

    const toolName = event?.toolName as string;
    if (!toolName) return;

    if (VERIFICATION_TOOLS.has(toolName)) {
      state.metaLearning.toolTracking.verificationCount++;
      state.metaLearning.toolTracking.lastVerificationTurn = state.policyTurnCount;
    }
    if (WEB_TOOLS.has(toolName)) {
      state.metaLearning.toolTracking.lastWebFetchTurn = state.policyTurnCount;
    }
    if (CODE_TOOLS.has(toolName)) {
      state.metaLearning.toolTracking.lastCodeExecutionTurn = state.policyTurnCount;
    }

    // Update belief store
    const sessionId = ctx.cwd ?? String(process.pid);
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

  // ── Event: tool_result - collect tool success/failure for trajectory enrichment
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

  // ── Event: session_start ──────────────────────────────────────────
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: any, ctx: ExtensionContext) => {
      const state = getState(ctx);

      // Register built-in modules
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

      // Initialize policy engine
      const sessionId = ctx.cwd ?? String(process.pid);
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
        (msg: string) => ctx.whisper?.(msg, { category: "cognitive", priority: "low" }),
        () => ctx.getContextUsage(),
        (msg: string) => {
          sendTrackedMessage(
            pi,
            {
              customType: "heartbeat",
              content: [{ type: "text" as const, text: msg }],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
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
              const sopSummary = formatSOPForWhisper(topEpisode);
              ctx.whisper?.(sopSummary, { category: "cognitive", priority: "low" });
              log.info(`Coach: Whispered SOP from past episode ${topEpisode.id}`);
            }
          }
        }
      } catch (err) {
        log.debug(`SOP retrieval skipped: ${(err as Error).message}`);
      }
    },
  );

  // ── Event: turn_start - inject relevant SOPs from past episodes ─────

  pi.on("turn_start", async (_event: any, ctx: ExtensionContext) => {
    // Inject SOP suggestions based on the current turn's user message
    try {
      const memState = getMemoryState(ctx);
      if (memState && memState.episodes) {
        // Use the user message from the event or the latest message in context
        const userText = _event?.userMessage ?? _event?.text ?? "";
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

  // ── Event: agent_end ──────────────────────────────────────────────

  pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    const outcome = _event?.outcome as string | undefined;
    log.info(
      `Session ended. Ticks: ${state.stats.totalTicks}, ` +
        `Activations: ${state.stats.totalActivations}, ` +
        `Tools: ${state.metaLearning.toolTracking.totalToolsUsed}, ` +
        `Outcome: ${outcome ?? "unknown"}`,
    );
    for (const [name, count] of Object.entries(state.stats.activationsByModule)) {
      log.info(`  ${name}: ${count} activations`);
    }

    try {
      const memState = getMemoryState(ctx);
      if (memState) {
        const taskDesc = _event?.task ?? "session_outcome";
        const success = outcome === "success" || !_event?.error;

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

        addEpisode(
          memState,
          taskDesc,
          sop.strategicSOP,
          success ? "success" : "partial",
          sop.atomicSOP,
          ["session", "outcome", success ? "success" : "partial"],
          undefined, // project
          sop.strategicSOP,
          sop.functionalSOP,
          sop.atomicSOP,
        );
        log.info(
          `[heartbeat] Outcome episode recorded: ${success ? "success" : "partial"} ` +
            `(SOP: ${sop.functionalSOP.length} steps, ${sop.atomicSOP.length} tools)`,
        );

        // Queue for consolidation if successful
        if (success) {
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
    } catch (err) {
      log.warn(`[heartbeat] Could not record outcome episode: ${err}`);
    }
  });

  // ── Event: session_shutdown ───────────────────────────────────────

  pi.on(SESSION_SHUTDOWN, async (_event: any, ctx: ExtensionContext) => {
    cleanupSession(ctx.cwd);
    log.info("Heartbeat scheduler shutting down");
  });

  // ── Policy Engine Activation ──────────────────────────────────────

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
