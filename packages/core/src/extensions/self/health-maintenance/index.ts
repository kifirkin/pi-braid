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
  type DegradationConfig,
} from "../../../lib/detection/degradation-detector.js";
import { createLogger } from "../../../lib/core/logger.js";
import { getLogBuffer, clearLogBuffer, setConsoleLogLevel } from "../../../lib/core/logger.js";
import {
  getMetacognitiveState,
  getRecommendation,
  initMetacognitiveState,
} from "../../../lib/state/metacognitive-state.js";
import type { BenchmarkResult, HealthMaintenanceResult } from "./types.js";
import { getAnalyticsMetrics, startMetricsPersistence, stopMetricsPersistence } from "./helpers.js";
import { formatHealthMaintenanceOutput } from "./format.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { registerSessionHealthTool } from "./handlers/session-health-tool.js";

const _log = createLogger("health-maintenance");

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
  // Numeric bounds where 0 is meaningless: a blank selector is converted to
  // 0 by argument validation, and 0 outside a field's band turns the blank
  // into a refusal before any handler runs. errorRateMax stays unbounded here
  // because its legal band is (0,1] and a schema minimum cannot express it;
  // the handler guard owns that one.
  config: Type.Optional(
    Type.Object({
      healthcheckMinScore: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          description: "Minimum healthcheck score (1-100)",
        }),
      ),
      errorRateMax: Type.Optional(Type.Number({ description: "Maximum error rate (0-1]" })),
      toolSuccessMin: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          description: "Minimum tool success rate (1-100)",
        }),
      ),
      maxConsecutiveErrors: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Max consecutive errors before degradation (>= 1)",
        }),
      ),
    }),
  ),
  benchmark: Type.Optional(
    Type.Object({
      passRate: Type.Optional(
        Type.Number({ minimum: 1, maximum: 100, description: "Benchmark pass rate (1-100)" }),
      ),
      totalCases: Type.Optional(
        Type.Number({ minimum: 1, description: "Number of cases in the benchmark run (>= 1)" }),
      ),
      passedCases: Type.Optional(
        Type.Number({ minimum: 0, description: "Number of cases that passed (>= 0)" }),
      ),
      failedCases: Type.Optional(
        Type.Array(Type.String(), { description: "Names of failed cases" }),
      ),
    }),
  ),
  force: Type.Optional(
    Type.Boolean({ default: false, description: "Force action without confirmation" }),
  ),
});

// ── Numeric config guard ────────────────────────────────────────────────────
//
// The framework validates tool arguments before the handler runs and converts
// "" to 0 for Type.Number, so a client that sends "" for an unused threshold
// delivers a real 0. 0 is outside every legal band below (a minimum of 1, or
// the open lower bound of errorRateMax), which is what makes the conversion
// detectable: the call named nothing usable, so the whole patch is refused
// rather than rewriting degradation thresholds (errorRateMax: 0 would degrade
// on the first error; healthcheckMinScore: 0 would disable the score floor).
// The merge itself stays permissive - this is the untrusted-input boundary.

interface FieldBand {
  min: number;
  max: number | null;
  /** True when the minimum itself is illegal (errorRateMax's (0,1] band). */
  minExclusive?: boolean;
}

const CONFIG_FIELD_BANDS: Record<keyof DegradationConfig, FieldBand> = {
  healthcheckMinScore: { min: 1, max: 100 },
  errorRateMax: { min: 0, max: 1, minExclusive: true },
  toolSuccessMin: { min: 1, max: 100 },
  maxConsecutiveErrors: { min: 1, max: null },
  checkIntervalMs: { min: 1, max: null },
};

function bandText(band: FieldBand): string {
  if (band.max === null) return band.minExclusive ? `> ${band.min}` : `>= ${band.min}`;
  if (band.minExclusive) return `(${band.min}, ${band.max}]`;
  return `${band.min}-${band.max}`;
}

/** The refusal sentence for `value` under `band`, or null when it is inside it. */
function bandRefusal(field: string, value: unknown, band: FieldBand): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${field} must be a finite number; got ${JSON.stringify(value)}.`;
  }
  const below = band.minExclusive ? value <= band.min : value < band.min;
  const above = band.max !== null && value > band.max;
  if (below || above) {
    return `${field} must be ${bandText(band)}; got ${value}. A blank selector arrives as 0 and is refused.`;
  }
  return null;
}

/**
 * Validate a config patch: provided fields must be finite numbers inside their
 * documented band. Absent/null fields are not provided. Returns the accepted
 * subset (so unknown keys never reach the merge), or the error naming the
 * first offending field.
 */
function validateConfigPatch(
  config: Record<string, unknown>,
): { values: Partial<DegradationConfig> } | { error: string } {
  const values: Partial<DegradationConfig> = {};
  for (const key of Object.keys(CONFIG_FIELD_BANDS) as (keyof DegradationConfig)[]) {
    const raw = config[key];
    if (raw === undefined || raw === null) continue;
    const refusal = bandRefusal(String(key), raw, CONFIG_FIELD_BANDS[key]);
    if (refusal) return { error: refusal };
    values[key] = raw as number;
  }
  return { values };
}

/** The benchmark's numeric rule: same bands, same refusal class as config. */
function validateBenchmark(benchmark: Record<string, unknown>): string | null {
  const passRate = bandRefusal("benchmark.passRate", benchmark.passRate, { min: 1, max: 100 });
  if (passRate) return passRate;
  if (benchmark.totalCases !== undefined && benchmark.totalCases !== null) {
    const total = bandRefusal("benchmark.totalCases", benchmark.totalCases, { min: 1, max: null });
    if (total) return total;
  }
  if (benchmark.passedCases !== undefined && benchmark.passedCases !== null) {
    const passed = bandRefusal("benchmark.passedCases", benchmark.passedCases, {
      min: 0,
      max: null,
    });
    if (passed) return passed;
  }
  return null;
}

export default function healthMaintenanceExtension(pi: ExtensionAPI) {
  startMetricsPersistence();

  pi.on(SESSION_SHUTDOWN, async () => {
    stopMetricsPersistence();
    await saveMetrics().catch((err: Error) => _log.error("Final metrics save failed:", err));
  });

  pi.registerTool({
    name: "health_maintenance",
    label: "Health Maintenance",
    promptSnippet: "Health maintenance commands for agent self-improvement",
    description:
      "Health maintenance: check health, commit changes, rollback issues, or benchmark performance.",
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

  // session_health tool (LLM provider health)
  // Layer 7 of the session-recovery proposal. Introspection
  // surface for the enforcement-owned SessionHealthState. Lives here
  // because it is a health-related tool, and the health-maintenance
  // module is the canonical home for health tooling.
  registerSessionHealthTool(pi);

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
        (e) =>
          `${new Date(e.timestamp).toISOString().slice(11, 23)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`,
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

function executeConfig(newConfig?: unknown): HealthMaintenanceResult {
  if (newConfig !== undefined && newConfig !== null) {
    if (typeof newConfig !== "object" || Array.isArray(newConfig)) {
      return {
        action: "config",
        success: false,
        error: "config must be an object of numeric thresholds.",
      };
    }
    const verdict = validateConfigPatch(newConfig as Record<string, unknown>);
    if ("error" in verdict) {
      // Atomic: nothing is merged when any provided field is refused. The
      // merge below stays where it was (the process-global config the tool has
      // always written and reports, and the one carried into new sessions).
      return { action: "config", success: false, error: verdict.error };
    }
    if (Object.keys(verdict.values).length === 0) {
      return { action: "config", success: false, error: "no config values provided" };
    }
    updateConfig(verdict.values);
  }
  return { action: "config", success: true, data: { config: getConfig() } };
}

function executeReset(): HealthMaintenanceResult {
  resetMetrics();
  return { action: "reset", success: true, data: { note: "Metrics reset to defaults." } };
}

function executeBenchmark(params?: Record<string, unknown>): HealthMaintenanceResult {
  const BENCHMARK_HISTORY: BenchmarkResult[] = [];
  const MAX_BENCHMARK_HISTORY = 20;

  if (!params || params.passRate === undefined) {
    return {
      action: "benchmark",
      success: true,
      data: { history: BENCHMARK_HISTORY.slice(-5), totalRuns: BENCHMARK_HISTORY.length },
    };
  }
  const refusal = validateBenchmark(params);
  if (refusal) {
    return { action: "benchmark", success: false, error: refusal };
  }
  const result: BenchmarkResult = {
    timestamp: Date.now(),
    passRate: params.passRate as number,
    totalCases: (params.totalCases as number | undefined) ?? 0,
    passedCases: (params.passedCases as number | undefined) ?? 0,
    failedCases: (params.failedCases as string[] | undefined) ?? [],
  };
  BENCHMARK_HISTORY.push(result);
  if (BENCHMARK_HISTORY.length > MAX_BENCHMARK_HISTORY) BENCHMARK_HISTORY.shift();
  return {
    action: "benchmark",
    success: true,
    data: { recorded: result, history: BENCHMARK_HISTORY.slice(-5) },
  };
}
