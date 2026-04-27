/**
 * Adaptive Compression Strategy (2604.15877) — Experience Compression Spectrum
 * Different temporal scales require different compression strategies.
 *
 * Levels:
 *   short-term  — pruning: remove noise, collapse repetitions (BCR)
 *   medium-term — reasoning summarization: chains → conclusions
 *   long-term   — episodic: extract patterns to memory
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { evaluateContextDensity } from "./context-density.js";

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
	opts: { turnCount: number; turnsSinceCompression: number; consecutiveFailures: number; reasoningChainDepth: number; messageCount: number } = { turnCount: 0, turnsSinceCompression: Infinity, consecutiveFailures: 0, reasoningChainDepth: 0, messageCount: 0 },
): CompressionDecision {
	const density = evaluateContextDensity(ctx);

	if (opts.consecutiveFailures >= 3) {
		return { level: "short-term", trigger: "bcr", turnsSinceCompression: opts.turnsSinceCompression, reason: `${opts.consecutiveFailures}x consecutive failures — collapse error pattern.`, estimatedSavings: 0.4 };
	}
	if (opts.turnCount >= 30 && opts.turnCount < 80) {
		if (opts.reasoningChainDepth > 3) {
			return { level: "medium-term", trigger: "reasoning", turnsSinceCompression: opts.turnsSinceCompression, reason: `Deep reasoning chain (${opts.reasoningChainDepth} steps) — medium-term compression opportunity.`, estimatedSavings: 0.55 };
		}
		if (opts.turnsSinceCompression > 40) {
			return { level: "medium-term", trigger: "density", turnsSinceCompression: opts.turnsSinceCompression, reason: "40+ turns since compression — prevent bloat.", estimatedSavings: 0.35 };
		}
	}
	if (opts.turnCount >= 80 || density.density >= 0.7) {
		return { level: "long-term", trigger: "episodic", turnsSinceCompression: opts.turnsSinceCompression, reason: opts.turnCount >= 80 ? "Late session (≥80 turns) — extract to episodic memory." : `High density (${Math.round(density.density * 100)}%) — aggressive compression.`, estimatedSavings: 0.65 };
	}
	return { level: "short-term", trigger: "bcr", turnsSinceCompression: opts.turnsSinceCompression, reason: "Session healthy.", estimatedSavings: 0 };
}
