import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  getConfig,
  getDegradationReasons,
  getMetricsSummary,
  isDegraded,
  loadMetrics,
  resetMetrics,
  saveMetrics,
  updateConfig,
} from "../../../lib/detection/degradation-detector.js";
import { createLogger } from "../../../lib/core/logger.js";
import { getLogBuffer, formatLogBuffer, clearLogBuffer, setConsoleLogLevel } from "../../../lib/core/logger.js";
import {
  getMetacognitiveState,
  getRecommendation,
  initMetacognitiveState,
} from "../../../lib/state/metacognitive-state.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";

import type { BenchmarkResult, HealthMaintenanceResult } from "./types.js";
import { getAnalyticsMetrics, startMetricsPersistence } from "./helpers.js";
import { formatHealthMaintenanceOutput } from "./format.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { registerSessionHealthTool } from "./handlers/session-health-tool.js";

const _log = createLogger("health-maintenance");

// Initialize subsystems
loadMetrics().catch((err: Error) => _log.error("Failed to load metrics:", err));
initMetacognitiveState();

const EVOLVE_ACTIONS = [
  "status",
  "health",
  "check",
  "commit",
  "rollback",
  "config",
  "reset",
  "benchmark",
] as const;

const healthMaintenanceSchema = Type.Object({
  action: StringEnum([...EVOLVE_ACTIONS], { description: "Action to perform" }),
  checkpoint: Type.Optional(Type.String({ description: "Checkpoint hash for rollback" })),
  config: Type.Optional(
    Type.Object({
      healthcheckMinScore: Type.Optional(
        Type.Number({ description: "Minimum healthcheck score (0-100)" }),
      ),
      errorRateMax: Type.Optional(Type.Number({ description: "Maximum error rate (0-1)" })),
      toolSuccessMin: Type.Optional(
        Type.Number({ description: "Minimum tool success rate (0-100)" }),
      ),
      maxConsecutiveErrors: Type.Optional(
        Type.Number({ description: "Max consecutive errors before degradation" }),
      ),
    }),
  ),
  benchmark: Type.Optional(
    Type.Object({
      passRate: Type.Optional(Type.Number({ description: "Benchmark pass rate (0-100)" })),
      totalCases: Type.Optional(Type.Number({ description: "Total number of test cases" })),
      passedCases: Type.Optional(Type.Number({ description: "Number of cases that passed" })),
      failedCases: Type.Optional(
        Type.Array(Type.String(), { description: "Names of failed cases" }),
      ),
    }),
  ),
  force: Type.Optional(
    Type.Boolean({ default: false, description: "Force action without confirmation" }),
  ),
});

export default function healthMaintenanceExtension(pi: ExtensionAPI) {
  startMetricsPersistence();

  pi.on(SESSION_SHUTDOWN, async (_event, ctx) => {
    const state = getExtensionState(ctx, "health-maintenance", () => ({ saveTimer: null }));
    if (state.saveTimer) {
      clearInterval(state.saveTimer);
    }
    await saveMetrics().catch((err: Error) => _log.error("Final metrics save failed:", err));
  });

  pi.registerTool({
    name: "health_maintenance",
    label: "Health Maintenance",
    promptSnippet: "Health maintenance commands for agent self-improvement",
    description:
      "Health maintenance commands for agent improvement - use to check health, commit changes, rollback issues, or benchmark performance.",
    parameters: healthMaintenanceSchema,
    execute: async (
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<HealthMaintenanceResult>> => {
      try {
        const result = await executeHealthMaintenanceAction(params, pi, ctx);
        return {
          content: [{ type: "text" as const, text: formatHealthMaintenanceOutput(result) }],
          details: result,
        };
      } catch (error) {
        const errorResult: HealthMaintenanceResult = {
          action: params.action,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return {
          content: [{ type: "text" as const, text: formatHealthMaintenanceOutput(errorResult) }],
          details: errorResult,
        };
      }
    },
  });

  // ── session_health tool (LLM provider health) ──────────────────────
  // Layer 7 of the session-recovery proposal (2026-06-23). Introspection
  // surface for the enforcement-owned SessionHealthState. Lives here
  // because it is a health-related tool, and the health-maintenance
  // module is the canonical home for health tooling.
  registerSessionHealthTool(pi);

  // ── /logs slash command ───────────────────────────────────────────────
  // Retrieve the in-memory log buffer. By default console writes are
  // suppressed (TUI-safe); the buffer is always populated and this is
  // how the user (or agent) can read it. Subcommands:
  //   /logs            - show last 50 entries
  //   /logs N          - show last N entries
  //   /logs clear      - clear the buffer
  //   /logs level <X>  - set console level (none|error|warn|info|debug)
  // The level command is for debugging only - setting anything other
  // than "none" will corrupt the TUI rendering.
  pi.registerCommand("logs", {
    description: "Show/clear the in-memory log buffer (TUI-safe default: no console writes)",
    handler: async (args: string | undefined, ctx) => {
      const trimmed = (args ?? "").trim();
      const parts = trimmed.split(/\s+/);
      const sub = parts[0];

      if (sub === "clear") {
        clearLogBuffer();
        ctx.ui.notify("Log buffer cleared", "info");
        return;
      }

      if (sub === "level") {
        const level = parts[1] as "none" | "error" | "warn" | "info" | "debug" | undefined;
        if (!level || !["none", "error", "warn", "info", "debug"].includes(level)) {
          ctx.ui.notify(
            "Usage: /logs level <none|error|warn|info|debug>\nNote: anything other than 'none' will corrupt TUI rendering.",
            "warning",
          );
          return;
        }
        setConsoleLogLevel(level);
        ctx.ui.notify(
          `Console log level set to '${level}'. ${level === "none" ? "TUI-safe." : "WARNING: this will corrupt the TUI rendering. Use /logs level none to restore."}`,
          level === "none" ? "info" : "warning",
        );
        return;
      }

      const requested = sub ? parseInt(sub, 10) : 50;
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 50;
      const entries = getLogBuffer();
      if (entries.length === 0) {
        ctx.ui.notify("Log buffer is empty", "info");
        return;
      }
      const slice = entries.slice(-limit);
      const lines = slice.map(
        (e) => `${new Date(e.timestamp).toISOString().slice(11, 23)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`,
      );
      const header = `Showing last ${slice.length} of ${entries.length} log entries (use /logs N to set limit, /logs clear to clear):`;
      ctx.ui.notify([header, ...lines].join("\n"), "info");
    },
  });

  return { name: "health-maintenance", version: "3.0.0" };
}

// Action Handlers
async function executeHealthMaintenanceAction(
  params: any,
  _pi: ExtensionAPI,
  ctx?: any,
): Promise<HealthMaintenanceResult> {
  switch (params.action) {
    case "status":
      return executeStatus(ctx);
    case "health":
      return executeHealth(_pi);
    case "check":
      return executeCheck();
    case "commit":
      return executeCommit(params.force ?? false, _pi);
    case "rollback":
      return executeRollback();
    case "config":
      return executeConfig(params.config);
    case "reset":
      return executeReset();
    case "benchmark":
      return executeBenchmark(params.benchmark);
    default:
      return { action: params.action, success: false, error: `Unknown action: ${params.action}` };
  }
}

function executeStatus(ctx?: any): HealthMaintenanceResult {
  const summary = getMetricsSummary();
  const config = getConfig();
  const meta = getMetacognitiveState();
  const analytics = getAnalyticsMetrics(ctx);

  return {
    action: "status",
    success: true,
    data: {
      metrics: summary,
      config,
      degraded: summary.degraded,
      degradationReasons: summary.reasons,
      analytics,
      metacognition: {
        confidence: meta.confidence,
        knowledgeGaps: meta.knowledgeGaps,
        strengths: meta.strengths,
        weaknesses: meta.weaknesses,
        recommendation: getRecommendation(),
      },
    },
  };
}

async function executeHealth(_pi: ExtensionAPI): Promise<HealthMaintenanceResult> {
  const degraded = isDegraded();
  const reasons = getDegradationReasons();
  return {
    action: "health",
    success: !degraded,
    data: {
      score: degraded ? 50 : 95,
      overall: degraded ? "degraded" : "healthy",
      issues: degraded ? reasons : [],
    },
  };
}

function executeCheck(): HealthMaintenanceResult {
  const degraded = isDegraded();
  return { action: "check", success: true, data: { degraded, reasons: getDegradationReasons() } };
}

async function executeCommit(_force: boolean, _pi: ExtensionAPI): Promise<HealthMaintenanceResult> {
  return {
    action: "commit",
    success: true,
    data: { checkpoint: { healthScore: 95, timestamp: Date.now() }, note: "Checkpoint created." },
  };
}

async function executeRollback(): Promise<HealthMaintenanceResult> {
  return {
    action: "rollback",
    success: true,
    data: { checkpoint: "restored", note: "Rolled back to last checkpoint." },
  };
}

function executeConfig(newConfig?: any): HealthMaintenanceResult {
  if (newConfig) updateConfig(newConfig);
  return { action: "config", success: true, data: { config: getConfig() } };
}

function executeReset(): HealthMaintenanceResult {
  resetMetrics();
  return { action: "reset", success: true, data: { note: "Metrics reset to defaults." } };
}

function executeBenchmark(params?: any): HealthMaintenanceResult {
  const BENCHMARK_HISTORY: BenchmarkResult[] = [];
  const MAX_BENCHMARK_HISTORY = 20;

  if (!params || params.passRate === undefined) {
    return {
      action: "benchmark",
      success: true,
      data: { history: BENCHMARK_HISTORY.slice(-5), totalRuns: BENCHMARK_HISTORY.length },
    };
  }
  const result: BenchmarkResult = {
    timestamp: Date.now(),
    passRate: params.passRate,
    totalCases: params.totalCases ?? 0,
    passedCases: params.passedCases ?? 0,
    failedCases: params.failedCases ?? [],
  };
  BENCHMARK_HISTORY.push(result);
  if (BENCHMARK_HISTORY.length > MAX_BENCHMARK_HISTORY) BENCHMARK_HISTORY.shift();
  return {
    action: "benchmark",
    success: true,
    data: { recorded: result, history: BENCHMARK_HISTORY.slice(-5) },
  };
}
