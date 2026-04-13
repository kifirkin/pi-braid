/**
 * Evolve Extension - Self-evolution commands for the agent
 *
 * Provides:
 * - evolve --status: Show current state and metrics
 * - evolve --health: Run healthcheck and validate
 * - evolve --check: Check degradation status
 * - evolve --commit: Create checkpoint with health validation
 * - evolve --rollback: Rollback to last good checkpoint
 * - evolve --config: Adjust degradation thresholds
 * - evolve --reset: Reset metrics and config
 *
 * This extension integrates with:
 * - healthcheck: For validated health scores
 * - metrics: For performance tracking
 * - pijul: For version control and rollback
 */

import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	getConfig,
	getDegradationReasons,
	getMetricsSummary,
	getRecentMetrics,
	isDegraded,
	loadMetrics,
	recordHealthcheckScore,
	resetMetrics,
	saveMetrics,
	updateConfig,
} from "../../lib/degradation-detector.js";
import {
	getLatestCheckpoint,
	getPijulStatus,
	isPijulAvailable,
	recordCheckpoint,
	resetToPatch,
} from "../../lib/pijul-utils.js";

const EVOLVE_ACTIONS = ["status", "health", "check", "commit", "rollback", "config", "reset", "benchmark"] as const;
type EvolveActionType = (typeof EVOLVE_ACTIONS)[number];

const evolveSchema = Type.Object({
	action: Type.Union([...EVOLVE_ACTIONS.map((a) => Type.Literal(a))], {
		description: "Action to perform",
	}),
	checkpoint: Type.Optional(Type.String({ description: "Checkpoint hash for rollback" })),
	config: Type.Optional(
		Type.Object({
			healthcheckMinScore: Type.Optional(Type.Number({ description: "Minimum healthcheck score (0-100)" })),
			errorRateMax: Type.Optional(Type.Number({ description: "Maximum error rate (0-1)" })),
			toolSuccessMin: Type.Optional(Type.Number({ description: "Minimum tool success rate (0-100)" })),
			maxConsecutiveErrors: Type.Optional(Type.Number({ description: "Max consecutive errors before degradation" })),
		}),
	),
	benchmark: Type.Optional(
		Type.Object({
			passRate: Type.Optional(Type.Number({ description: "Benchmark pass rate (0-100)" })),
			totalCases: Type.Optional(Type.Number({ description: "Total number of test cases" })),
			passedCases: Type.Optional(Type.Number({ description: "Number of cases that passed" })),
			failedCases: Type.Optional(Type.Array(Type.String(), { description: "Names of failed cases" })),
		}),
	),
	force: Type.Optional(Type.Boolean({ default: false, description: "Force action without confirmation" })),
});

interface EvolveResult {
	action: EvolveActionType;
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

// Load metrics on startup
loadMetrics().catch(console.error);

// Periodic metrics save
const METRICS_SAVE_INTERVAL = 30000; // 30 seconds
let saveTimer: ReturnType<typeof setInterval> | null = null;

function startMetricsPersistence(): void {
	if (saveTimer) return;
	saveTimer = setInterval(() => {
		saveMetrics().catch(console.error);
	}, METRICS_SAVE_INTERVAL);
}

export default function evolveExtension(pi: ExtensionAPI) {
	// Start metrics persistence
	startMetricsPersistence();

	pi.registerTool({
		name: "evolve",
		label: "Evolve",
		description:
			"Self-evolution commands for the agent. " +
			"Use to check health, create checkpoints, rollback on degradation, " +
			"and monitor performance metrics. " +
			"Actions: status (view state), health (run healthcheck), check (degradation), " +
			"commit (checkpoint), rollback (revert), config (thresholds), reset (clear metrics).",
		parameters: evolveSchema,

		execute: async (_toolCallId, params): Promise<AgentToolResult<EvolveResult>> => {
			try {
				const result = await executeEvolveAction(params, pi);
				return {
					content: [{ type: "text" as const, text: formatEvolveOutput(result) }],
					details: result,
				};
			} catch (error) {
				const errorResult: EvolveResult = {
					action: params.action,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
				return {
					content: [{ type: "text" as const, text: formatEvolveOutput(errorResult) }],
					details: errorResult,
				};
			}
		},
	});

	return {
		name: "evolve",
		version: "1.0.0",
	};
}

async function executeEvolveAction(
	params: {
		action: EvolveActionType;
		checkpoint?: string;
		config?: {
			healthcheckMinScore?: number;
			errorRateMax?: number;
			toolSuccessMin?: number;
			maxConsecutiveErrors?: number;
		};
		benchmark?: {
			passRate?: number;
			totalCases?: number;
			passedCases?: number;
			failedCases?: string[];
		};
		force?: boolean;
	},
	_pi: ExtensionAPI,
): Promise<EvolveResult> {
	switch (params.action) {
		case "status":
			return executeStatus();
		case "health":
			return executeHealth(_pi);
		case "check":
			return executeCheck();
		case "commit":
			return executeCommit(params.force ?? false, _pi);
		case "rollback":
			return executeRollback(params.checkpoint);
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

function executeStatus(): EvolveResult {
	const summary = getMetricsSummary();
	const config = getConfig();
	const pijulStatus = getPijulStatus();

	return {
		action: "status",
		success: true,
		data: {
			metrics: summary,
			config,
			degraded: summary.degraded,
			degradationReasons: summary.reasons,
			pijulStatus,
		},
	};
}

async function executeHealth(_pi: ExtensionAPI): Promise<EvolveResult> {
	// Try to call the healthcheck tool if available
	// Note: We can't directly call another tool, so we run a basic self-check
	const memoryUsage = process.memoryUsage();
	const memUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);
	const memTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);
	const memPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

	// Basic health assessment
	let score = 100;
	const issues: string[] = [];

	if (memPercent > 80) {
		score -= 20;
		issues.push(`High memory usage: ${memPercent.toFixed(1)}%`);
	}

	const degraded = isDegraded();
	if (degraded) {
		const reasons = getDegradationReasons();
		score -= reasons.length * 15;
		issues.push(...reasons);
	}

	// Record the healthcheck score
	recordHealthcheckScore(Math.max(0, score));

	// Save metrics
	await saveMetrics();

	const overall = score >= 80 ? "healthy" : score >= 50 ? "degraded" : "unhealthy";

	return {
		action: "health",
		success: score >= getConfig().healthcheckMinScore,
		data: {
			score: Math.max(0, score),
			overall,
			memory: {
				used: `${memUsed}MB`,
				total: `${memTotal}MB`,
				percent: memPercent.toFixed(1),
			},
			issues,
			config: getConfig(),
		},
	};
}

function executeCheck(): EvolveResult {
	const degraded = isDegraded();
	const reasons = getDegradationReasons();
	const summary = getMetricsSummary();
	const recent = getRecentMetrics(3);

	return {
		action: "check",
		success: !degraded,
		data: {
			degraded,
			reasons,
			metrics: summary,
			recentTurns: recent.length,
			config: getConfig(),
		},
	};
}

async function executeCommit(force: boolean, _pi: ExtensionAPI): Promise<EvolveResult> {
	// First check health
	const healthResult = await executeHealth(_pi);
	const score = typeof healthResult.data?.score === "number" ? healthResult.data.score : 0;

	if (score < getConfig().healthcheckMinScore && !force) {
		return {
			action: "commit",
			success: false,
			error: `Cannot commit - healthcheck score ${score} is below minimum ${getConfig().healthcheckMinScore}. Use --force to override or improve health first.`,
		};
	}

	// Save metrics
	await saveMetrics();

	const checkpointData = {
		timestamp: Date.now(),
		healthScore: score,
		metrics: getMetricsSummary(),
	};

	// Attempt Pijul checkpoint if available
	let pijulHash: string | null = null;
	if (isPijulAvailable()) {
		const message = `evolve:health=${score}`;
		pijulHash = recordCheckpoint(message);
	}

	const checkpointResult: EvolveResult = {
		action: "commit",
		success: true,
		data: {
			checkpoint: checkpointData,
			pijulHash,
			pijulStatus: getPijulStatus(),
			note: pijulHash
				? `Pijul checkpoint created: ${pijulHash}`
				: "Metrics checkpoint created. Pijul not available - install for version control.",
		},
	};

	return checkpointResult;
}

async function executeRollback(checkpointHash?: string): Promise<EvolveResult> {
	// Check if Pijul is available
	if (!isPijulAvailable()) {
		// Fallback: just reset metrics
		resetMetrics();
		return {
			action: "rollback",
			success: false,
			error: "Pijul not available. Metrics reset only. Install Pijul: cargo install pijul",
		};
	}

	// If no specific checkpoint provided, find the latest good one
	if (!checkpointHash) {
		const latest = getLatestCheckpoint();
		if (!latest) {
			return {
				action: "rollback",
				success: false,
				error: "No checkpoints available. Use `evolve --commit` to create checkpoints.",
			};
		}
		checkpointHash = latest.hash;
	}

	// Attempt Pijul rollback
	const success = resetToPatch(checkpointHash);

	if (success) {
		// Reset metrics as well
		resetMetrics();

		return {
			action: "rollback",
			success: true,
			data: {
				checkpoint: checkpointHash,
				pijulStatus: getPijulStatus(),
				note: "Rollback successful. Working directory reverted to checkpoint.",
			},
		};
	}

	return {
		action: "rollback",
		success: false,
		error: `Failed to rollback to checkpoint ${checkpointHash}. Check Pijul is working correctly.`,
	};
}

function executeConfig(
	newConfig?: Partial<{
		healthcheckMinScore: number;
		errorRateMax: number;
		toolSuccessMin: number;
		maxConsecutiveErrors: number;
	}>,
): EvolveResult {
	if (newConfig) {
		updateConfig(newConfig);
	}

	const config = getConfig();

	return {
		action: "config",
		success: true,
		data: {
			config,
			description: {
				healthcheckMinScore: "Minimum healthcheck score (0-100)",
				errorRateMax: "Maximum error rate (0-1)",
				toolSuccessMin: "Minimum tool success rate (0-100)",
				maxConsecutiveErrors: "Max consecutive errors before degradation",
			},
		},
	};
}

function executeReset(): EvolveResult {
	resetMetrics();

	return {
		action: "reset",
		success: true,
		data: {
			note: "Metrics and configuration reset to defaults",
		},
	};
}

/** Benchmark result storage */
interface BenchmarkResult {
	timestamp: number;
	passRate: number;
	totalCases: number;
	passedCases: number;
	failedCases: string[];
}

const BENCHMARK_HISTORY: BenchmarkResult[] = [];
const MAX_BENCHMARK_HISTORY = 20;

function executeBenchmark(params?: {
	passRate?: number;
	totalCases?: number;
	passedCases?: number;
	failedCases?: string[];
}): EvolveResult {
	// If no params, just return current benchmark status
	if (!params || params.passRate === undefined) {
		return {
			action: "benchmark",
			success: true,
			data: {
				history: BENCHMARK_HISTORY.slice(-5),
				bestPassRate: BENCHMARK_HISTORY.length > 0 ? Math.max(...BENCHMARK_HISTORY.map((r) => r.passRate)) : 0,
				avgPassRate:
					BENCHMARK_HISTORY.length > 0
						? BENCHMARK_HISTORY.reduce((a, r) => a + r.passRate, 0) / BENCHMARK_HISTORY.length
						: 0,
				totalRuns: BENCHMARK_HISTORY.length,
			},
		};
	}

	// Record new benchmark result
	const result: BenchmarkResult = {
		timestamp: Date.now(),
		passRate: params.passRate,
		totalCases: params.totalCases ?? 0,
		passedCases: params.passedCases ?? 0,
		failedCases: params.failedCases ?? [],
	};

	BENCHMARK_HISTORY.push(result);
	if (BENCHMARK_HISTORY.length > MAX_BENCHMARK_HISTORY) {
		BENCHMARK_HISTORY.shift();
	}

	// Store failing cases in permanent memory for learning
	if (result.failedCases.length > 0 && params.passRate < 100) {
		// This will be handled by the permanent-memory integration
		// The agent should recall these patterns before similar tasks
	}

	return {
		action: "benchmark",
		success: true,
		data: {
			recorded: result,
			history: BENCHMARK_HISTORY.slice(-5),
			bestPassRate: Math.max(...BENCHMARK_HISTORY.map((r) => r.passRate)),
			avgPassRate: BENCHMARK_HISTORY.reduce((a, r) => a + r.passRate, 0) / BENCHMARK_HISTORY.length,
			totalRuns: BENCHMARK_HISTORY.length,
			improvement:
				BENCHMARK_HISTORY.length > 1
					? result.passRate - BENCHMARK_HISTORY[BENCHMARK_HISTORY.length - 2].passRate
					: 0,
		},
	};
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatEvolveOutput(result: EvolveResult): string {
	const lines: string[] = [];

	switch (result.action) {
		case "status": {
			const data = result.data as
				| {
						metrics: {
							totalTurns: number;
							avgHealthcheck: number;
							avgErrorRate: number;
							avgToolSuccess: number;
							degraded: boolean;
						};
						degraded: boolean;
						degradationReasons: string[];
						pijulStatus?: { available?: boolean; patchCount?: number };
				  }
				| undefined;

			lines.push("# Agent Evolution Status");
			lines.push("");

			// Pijul status
			const ps = data?.pijulStatus;
			if (ps?.available) {
				lines.push("**Version Control:**");
				lines.push(`- Pijul: ✅ Available`);
				lines.push(`- Checkpoints: ${ps.patchCount || 0}`);
			} else {
				lines.push("**Version Control:**");
				lines.push("- Pijul: ❌ Not available");
				lines.push("  Install: `cargo install pijul`");
			}

			lines.push("");

			if (data?.metrics) {
				const m = data.metrics;
				lines.push("**Performance Metrics:**");
				lines.push(`- Total Turns: ${m.totalTurns}`);
				lines.push(`- Avg Healthcheck: ${m.avgHealthcheck.toFixed(1)}%`);
				lines.push(`- Avg Error Rate: ${(m.avgErrorRate * 100).toFixed(1)}%`);
				lines.push(`- Avg Tool Success: ${m.avgToolSuccess.toFixed(1)}%`);
				lines.push("");
				lines.push(`**Status:** ${m.degraded ? "🔴 DEGRADED" : "🟢 HEALTHY"}`);
				if (m.degraded && m.avgHealthcheck < 80) {
					lines.push(`- Healthcheck score below threshold`);
				}
				if (m.degraded && m.avgErrorRate > 0.1) {
					lines.push(`- Error rate above threshold`);
				}
				if (m.degraded && m.avgToolSuccess < 70) {
					lines.push(`- Tool success below threshold`);
				}
			} else {
				lines.push("**Performance Metrics:**");
				lines.push("No metrics recorded yet.");
				lines.push("");
				lines.push("Run `evolve --health` to perform first healthcheck.");
			}
			break;
		}

		case "health": {
			const data = result.data as {
				score?: number;
				overall?: string;
				memory?: { used: string; total: string; percent: string };
				issues?: string[];
			};

			const icon = result.success ? "🟢" : "🔴";
			lines.push("# Healthcheck Result");
			lines.push("");
			lines.push(`${icon} **Status:** ${(data?.overall ?? "unknown").toUpperCase()}`);
			lines.push(`**Score:** ${data?.score ?? 0}/100`);
			if (data?.memory) {
				lines.push(`**Memory:** ${data.memory.used} / ${data.memory.total} (${data.memory.percent}%)`);
			}
			if (data?.issues && data.issues.length > 0) {
				lines.push("");
				lines.push("**Issues:**");
				for (const issue of data.issues) {
					lines.push(`- ${issue}`);
				}
			}
			if (!result.success) {
				lines.push("");
				lines.push("**Recommendation:** Run `evolve --check` for details or `evolve --rollback` to recover.");
			}
			break;
		}

		case "check": {
			const data = result.data as { degraded: boolean; reasons: string[]; recentTurns?: number };

			lines.push("# Degradation Check");
			lines.push("");
			lines.push(`**Degraded:** ${data?.degraded ? "🔴 YES" : "🟢 NO"}`);
			if (data?.recentTurns !== undefined) {
				lines.push(`**Recent Turns:** ${data.recentTurns}`);
			}
			if (data?.reasons && data.reasons.length > 0) {
				lines.push("");
				lines.push("**Reasons:**");
				for (const reason of data.reasons) {
					lines.push(`- ${reason}`);
				}
			}
			break;
		}

		case "commit": {
			const icon = result.success ? "🟢" : "🔴";
			lines.push(`${icon} **Commit ${result.success ? "Succeeded" : "Failed"}**`);
			if (result.success && result.data) {
				const checkpoint = result.data.checkpoint as { healthScore?: number; timestamp?: number };
				if (checkpoint) {
					lines.push(`Health Score: ${checkpoint.healthScore ?? "N/A"}`);
					lines.push(`Timestamp: ${checkpoint.timestamp ? new Date(checkpoint.timestamp).toISOString() : "N/A"}`);
				}
			}
			if (result.data?.note && typeof result.data.note === "string") {
				lines.push(result.data.note);
			}
			if (result.error) {
				lines.push("");
				lines.push(`**Error:** ${result.error}`);
			}
			break;
		}

		case "rollback": {
			const icon = result.success ? "🟢" : "🔴";
			lines.push(`${icon} **Rollback ${result.success ? "Succeeded" : "Failed"}**`);
			if (result.data?.checkpoint) {
				lines.push(`Checkpoint: ${String(result.data.checkpoint)}`);
			}
			if (result.data?.note && typeof result.data.note === "string") {
				lines.push(result.data.note);
			}
			if (result.error) {
				lines.push(`**Error:** ${result.error}`);
			}
			break;
		}

		case "config": {
			const data = result.data as { config?: Record<string, number>; description?: Record<string, string> };

			lines.push("# Degradation Configuration");
			lines.push("");
			if (data?.config) {
				for (const [key, value] of Object.entries(data.config)) {
					const desc = data.description?.[key] ?? "";
					lines.push(`**${key}:** ${value} ${desc ? `(${desc})` : ""}`);
				}
			}
			lines.push("");
			lines.push("**Adjust:** `evolve --config --config.{key} {value}`");
			break;
		}

		case "reset": {
			lines.push("🟢 Metrics and configuration reset to defaults.");
			lines.push("");
			lines.push("Run `evolve --health` to start fresh.");
			break;
		}

		case "benchmark": {
			const benchmarkData = result.data as {
				recorded?: { passRate: number; totalCases: number; passedCases: number; failedCases: string[] };
				history?: Array<{ timestamp: number; passRate: number; failedCases: string[] }>;
				bestPassRate: number;
				avgPassRate: number;
				totalRuns: number;
				improvement?: number;
			};
			const bm = benchmarkData;

			lines.push("# Benchmark Results");
			lines.push("");

			if (bm.recorded) {
				lines.push("**Latest Run:**");
				lines.push(`- Pass Rate: ${bm.recorded.passRate.toFixed(1)}%`);
				lines.push(`- Cases: ${bm.recorded.passedCases}/${bm.recorded.totalCases} passed`);
				if (bm.recorded.failedCases.length > 0) {
					lines.push(`- Failed: ${bm.recorded.failedCases.join(", ")}`);
				}
				lines.push("");
			}

			if (bm.improvement !== undefined && bm.improvement !== 0) {
				const icon = bm.improvement > 0 ? "📈" : "📉";
				lines.push(`${icon} Improvement: ${bm.improvement > 0 ? "+" : ""}${bm.improvement.toFixed(1)}%`);
				lines.push("");
			}

			lines.push("**Statistics:**");
			lines.push(`- Best Pass Rate: ${bm.bestPassRate.toFixed(1)}%`);
			lines.push(`- Average Pass Rate: ${bm.avgPassRate.toFixed(1)}%`);
			lines.push(`- Total Runs: ${bm.totalRuns}`);
			lines.push("");

			if (bm.history && bm.history.length > 1) {
				lines.push("**Recent History:**");
				for (const h of bm.history.slice(-5)) {
					const date = new Date(h.timestamp).toLocaleDateString();
					const icon = h.passRate >= 90 ? "🟢" : h.passRate >= 70 ? "🟡" : "🔴";
					lines.push(
						`${icon} ${date}: ${h.passRate.toFixed(1)}%${h.failedCases.length > 0 ? ` (failed: ${h.failedCases.join(", ")})` : ""}`,
					);
				}
			}

			lines.push("");
			lines.push("Use `evolve --benchmark` to record results.");
			lines.push("Use `memory_recall` to recall patterns from past failures.");
			break;
		}
	}

	return lines.join("\n");
}
