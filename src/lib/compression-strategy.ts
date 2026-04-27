/**
 * Adaptive Compression Integration
 *
 * Experience Compression Spectrum (2604.15877): Different temporal scales
 * require different compression strategies.
 *
 * Levels:
 *   short-term  — pruning: remove noise, collapse repetitions (BCR)
 *   medium-term — reasoning summarization: chains → conclusions
 *   long-term    — episodic: extract patterns to memory
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { evaluateContextDensity, recommendCompressionStrategy } from "./context-density.js";

export type CompressionLevel = "short-term" | "medium-term" | "long-term";
export type CompressionTrigger = "bcr" | "reasoning" | "episodic" | "density";

export interface CompressionDecision {
	level: CompressionLevel;
	trigger: CompressionTrigger;
	turnsSinceCompression: number;
	reason: string;
	estimatedSavings: number;
}

export function determineCompressionLevel(
	ctx: ExtensionContext,
	opts: {
		turnCount: number;
		turnsSinceCompression: number;
		consecutiveFailures: number;
		reasoningChainDepth: number;
		messageCount: number;
	} = { turnCount: 0, turnsSinceCompression: Infinity, consecutiveFailures: 0, reasoningChainDepth: 0, messageCount: 0 },
): CompressionDecision {
	const density = evaluateContextDensity(ctx);
	const strategy = recommendCompressionStrategy(density);

	// Short-term: early session or failure spirals
	if (opts.turnCount < 30) {
		return { level: "short-term", trigger: "bcr", turnsSinceCompression: opts.turnsSinceCompression, reason: "Early session (<30 turns) — prune noise, collapse repetitions.", estimatedSavings: opts.consecutiveFailures >= 3 ? 0.5 : 0.15 };
	}
	if (opts.consecutiveFailures >= 3) {
		return { level: "short-term", trigger: "bcr", turnsSinceCompression: opts.turnsSinceCompression, reason: `${opts.consecutiveFailures}x consecutive failures — collapse + summarize error pattern.`, estimatedSavings: 0.4 };
	}

	// Medium-term: reasoning chains or medium density
	if (opts.turnCount >= 30 && opts.turnCount < 80) {
		if (opts.reasoningChainDepth > 5) {
			return { level: "medium-term", trigger: "reasoning", turnsSinceCompression: opts.turnsSinceCompression, reason: `Deep reasoning chain (${opts.reasoningChainDepth} turns) — convert to conclusion, preserve key decisions.`, estimatedSavings: 0.55 };
		}
		if (density.density >= 0.4 && density.density < 0.7) {
			return { level: "medium-term", trigger: "density", turnsSinceCompression: opts.turnsSinceCompression, reason: `Medium density (${Math.round(density.density * 100)}%) — semantic summarization.`, estimatedSavings: 0.45 };
		}
		if (opts.turnsSinceCompression > 40) {
			return { level: "medium-term", trigger: "density", turnsSinceCompression: opts.turnsSinceCompression, reason: "40+ turns since compression — prevent bloat.", estimatedSavings: 0.35 };
		}
	}

	// Long-term: late session or aggressive density
	if (opts.turnCount >= 80 || strategy === "aggressive") {
		return { level: "long-term", trigger: "episodic", turnsSinceCompression: opts.turnsSinceCompression, reason: opts.turnCount >= 80 ? "Late session (≥80 turns) — extract to episodic memory." : `Aggressive compression: ${Math.round(density.density * 100)}% density, ${Math.round(density.tokenRatio * 100)}% of limit.`, estimatedSavings: 0.65 };
	}

	// High density + large context = semantic compression opportunity
	if (density.density >= 0.7 && density.tokenRatio > 0.6) {
		return { level: "medium-term", trigger: "density", turnsSinceCompression: opts.turnsSinceCompression, reason: `High density (${Math.round(density.density * 100)}%) + large context (${Math.round(density.tokenRatio * 100)}%) — SimpleMem: 30x reduction.`, estimatedSavings: 0.30 };
	}

	return { level: "short-term", trigger: "bcr", turnsSinceCompression: opts.turnsSinceCompression, reason: "Session healthy.", estimatedSavings: 0 };
}