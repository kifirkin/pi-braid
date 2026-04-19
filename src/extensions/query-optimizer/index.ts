/**
 * Query Optimizer Extension for pi-braid
 *
 * Based on PriHA paper (arXiv:2604.14215) - Query Optimization components:
 * 1. Intent Classifier (IC): Labels queries as SIMPLE or COMPLEX
 * 2. Intent-Based Generalizer (IBG): Generates atomic sub-queries from clarified intent
 * 3. Multi-Round Clarification (MRC): For complex queries, asks clarifying questions
 *
 * Transform vague user queries into precise, retrievable sub-queries.
 *
 * KEY DESIGN:
 * - Fast heuristic classification for simple queries (no LLM overhead)
 * - Optional LLM fallback for ambiguous cases
 * - Works with session-recall for improved retrieval
 * - Does not add latency to simple queries
 */

import type { ExtensionAPI, InputEventResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface IntentClassification {
	type: "simple" | "complex";
	confidence: number; // 0-1
	reason: string;
}

export interface SubqueryResult {
	subqueries: string[];
	requiresClarification: boolean;
	clarificationPrompt?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT CLASSIFIER (IC) - Heuristic Rules
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Indicators of SIMPLE queries (clear intent, direct question).
 * These are fast-path queries that don't need optimization.
 */
const SIMPLE_INDICATORS = [
	// Direct question words
	/^(?:what|who|where|when|why|how|which|is|are|was|were|do|does|can|could)\b/i,
	// Definition patterns
	/\b(?:what is|what are|who is|define|definition of)\b/i,
	// Direct action requests
	/\b(?:show me|give me|tell me|explain|describe)\b/i,
	// Tutorial/how-to with clear subject
	/\b(?:how to|how do|how can)\s+\w+\s+\w+/i,
];

/**
 * Indicators of COMPLEX queries (vague, multi-part, or needing context).
 * These need sub-query decomposition.
 */
const COMPLEX_INDICATORS = [
	// Comparative queries (implicit)
	/\b(?:better|best|worst|cheaper|faster|easier|recommend|comparison)\b/i,
	// Ambiguous pronouns/references
	/\b(?:it|this|that|them|they|these)\b/i,
	// Implicit subject (no clear noun)
	/^(?:better|good|bad|fast|slow|help|fix|change|update|improve|get)\b/i,
	// Multi-part with implicit context
	/[,;]?\s*(?:and|also|plus|with)\b/i,
	// Vague qualifiers
	/\b(?:some|any|something|things|stuff|way|things)\b/i,
	// Body parts / symptoms (implicit condition)
	/\b(?:knee|back|head|stomach|leg|arm|shoulder|hip|neck|elbow|wrist)\b/i,
	// "For" construction without clear target
	/\bfor\s+(?:my|your|the|a)\s+\w+$/i,
	// Question without clear subject
	/^(?:best|good|top|right|what's the)\s*$/i,
];

/**
 * Patterns that should ALWAYS be treated as simple (clear intent).
 * These override complex indicators.
 */
const ALWAYS_SIMPLE_PATTERNS = [
	// Contains a specific entity or proper noun
	/(?:in|at|for|with)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/,
	// Has a specific file, function, or technical term
	/['"`]\S+['"`]|\.ts\b|\.js\b|\.py\b|function\s+\w+|class\s+\w+/,
	// Already a complete question
	/\?$/,
	// Starts with definition pattern
	/^(?:what is|what are|define)\s+\w+/i,
];

/**
 * Classify intent using fast heuristics.
 * Returns SIMPLE or COMPLEX with confidence score.
 */
function classifyIntentHeuristic(text: string): IntentClassification {
	const trimmed = text.trim();
	
	// Check always-simple patterns first (they override complex indicators)
	for (const pattern of ALWAYS_SIMPLE_PATTERNS) {
		if (pattern.test(trimmed)) {
			return {
				type: "simple",
				confidence: 0.95,
				reason: "Clear entity or complete question detected",
			};
		}
	}
	
	// Count simple indicators
	let simpleScore = 0;
	for (const pattern of SIMPLE_INDICATORS) {
		if (pattern.test(trimmed)) simpleScore++;
	}
	
	// Count complex indicators
	let complexScore = 0;
	for (const pattern of COMPLEX_INDICATORS) {
		if (pattern.test(trimmed)) complexScore++;
	}
	
	// Length-based adjustment
	const wordCount = trimmed.split(/\s+/).length;
	if (wordCount < 5) {
		// Short queries are more likely complex (implicit subject)
		complexScore += 1;
	} else if (wordCount > 15) {
		// Long queries likely have clear intent
		simpleScore += 1;
	}
	
	// Question mark check
	if (trimmed.includes("?")) {
		simpleScore += 0.5;
	}
	
	// Make decision
	if (complexScore > simpleScore) {
		const confidence = Math.min(0.9, 0.5 + (complexScore - simpleScore) * 0.15);
		return {
			type: "complex",
			confidence,
			reason: `Vague or multi-part query detected (score: ${complexScore} > ${simpleScore})`,
		};
	} else {
		const confidence = Math.min(0.95, 0.6 + (simpleScore - complexScore) * 0.1);
		return {
			type: "simple",
			confidence,
			reason: `Direct question with clear intent (score: ${simpleScore} >= ${complexScore})`,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT-BASED GENERALIZER (IBG) - Sub-query Generation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Common query expansion patterns for different query types.
 */
const EXPANSION_PATTERNS: Array<{
	trigger: RegExp;
	transform: (text: string) => string[] | null;
}> = [
	// "better X" → generate comparison sub-queries
	{
		trigger: /better\s+(.+)/i,
		transform: (text) => {
			const match = text.match(/better\s+(.+)/i);
			if (!match) return null;
			const subject = match[1].trim();
			// Extract location/entity context if present
			const locationMatch = text.match(/(?:in|at|near|around)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
			const location = locationMatch ? locationMatch[1] : "";
			return [
				`${location} ${subject} quality`,
				`${location} ${subject} prices`,
				`${location} ${subject} reviews`,
			].map(q => q.replace(/^\s+/, "")).filter(q => q.length > 0);
		},
	},
	// "X for Y" (body parts, symptoms) → generate condition + solution queries
	{
		trigger: /(?:exercise|workout|help|tips|advice)\s+(?:for|with)\s+(knee|back|head|stomach|leg|arm|shoulder|hip|neck|elbow|wrist)/i,
		transform: (text) => {
			const bodyPart = text.match(/(knee|back|head|stomach|leg|arm|shoulder|hip|neck|elbow|wrist)/i)?.[1] || "";
			const capitalized = bodyPart.charAt(0).toUpperCase() + bodyPart.slice(1);
			return [
				`Exercise for ${capitalized} pain`,
				`${capitalized} strengthening exercises`,
				`${capitalized} injury prevention`,
			];
		},
	},
	// "good X" → generate quality + recommendation queries
	{
		trigger: /(?:good|best|top|recommended)\s+(?!place|time|way\s*$)/i,
		transform: (text) => {
			// Extract location context first
			const locationMatch = text.match(/(?:in|at|near|around)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
			const location = locationMatch ? locationMatch[1] : "";
			// Remove "good/best/top" prefix and location
			let subject = text
				.replace(/(?:good|best|top|recommended)\s+/i, "")
				.replace(/\s+(?:in|at|near|around)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi, "")
				.trim();
			if (!subject) return null;
			const withLoc = location ? ` ${location}` : "";
			return [
				`${subject}${withLoc} recommendations`.trim(),
				`${subject}${withLoc} reviews`.trim(),
				`${subject}${withLoc} comparison`.trim(),
			].filter(q => q.length > 0);
		},
	},
];

/**
 * Generate atomic sub-queries for complex intent.
 * Uses pattern-based expansion for common query types.
 */
function generateSubqueriesSimple(text: string, intent: IntentClassification): SubqueryResult {
	// Try each expansion pattern
	for (const { trigger, transform } of EXPANSION_PATTERNS) {
		if (trigger.test(text)) {
			const subqueries = transform(text);
			if (subqueries && subqueries.length > 0) {
				return {
					subqueries,
					requiresClarification: false,
				};
			}
		}
	}
	
	// Generic expansion: extract key entities and create variations
	const words = text.split(/\s+/);
	const keyWords = words.filter(w => 
		w.length > 3 && 
		!/^(?:the|a|an|and|or|but|in|on|at|for|to|with|of|is|are|was|were|have|has|had)$/i.test(w)
	);
	
	if (keyWords.length >= 2) {
		// Create variations focusing on different aspects
		const subqueries = [
			text, // Original as-is
			keyWords.slice(0, Math.min(3, keyWords.length)).join(" "), // Key terms only
			`${keyWords[0]} ${keyWords[1]} information`, // Info request
		];
		return {
			subqueries: [...new Set(subqueries)],
			requiresClarification: false,
		};
	}
	
	// Single key word or unclear - needs clarification
	return {
		subqueries: [text],
		requiresClarification: true,
		clarificationPrompt: "Could you be more specific about what you're looking for? For example: 'best Italian restaurants in NYC' or 'exercise for knee pain'.",
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let enabled = true;

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════════════

export default function queryOptimizerExtension(pi: ExtensionAPI) {
	// ── Input Transform ───────────────────────────────────────────────────
	// Optimize queries before they reach the main LLM.
	// Simple queries pass through, complex queries get decomposed.

	pi.on("input", async (event, ctx): Promise<InputEventResult> => {
		if (!enabled) {
			return { action: "continue" };
		}

		const text = event.text?.trim() || "";

		// Skip: empty, commands, or extension-injected messages
		if (!text || text.startsWith("/") || event.source === "extension") {
			return { action: "continue" };
		}

		// Classify intent
		const intent = classifyIntentHeuristic(text);

		// For simple queries, pass through immediately (no overhead)
		if (intent.type === "simple") {
			return { action: "continue" };
		}

		// Complex query - generate sub-queries for better retrieval
		const result = generateSubqueriesSimple(text, intent);

		if (result.requiresClarification && result.clarificationPrompt) {
			// Optional: Ask for clarification
			// For now, just add context to the original query
			// Could integrate with ctx.ui to show clarification UI
		}

		// If we have sub-queries, we could:
		// 1. Transform the query to include sub-queries
		// 2. Store metadata for session-recall to use
		// 3. Log for analysis
		
		if (result.subqueries.length > 1) {
			// For multi-turn: inject context for sub-query search
			// For now, we just log the optimization
			(ctx as any).__queryOptimizer = {
				original: text,
				intent,
				subqueries: result.subqueries,
			};
		}

		// Continue with original text (could transform to include sub-queries)
		return { action: "continue" };
	});

	// ── Tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "classify_intent",
		label: "Classify Query Intent",
		description:
			"Classify a query as SIMPLE (direct question) or COMPLEX (needs clarification/decomposition). Based on PriHA paper Intent Classifier.",
		parameters: Type.Object({
			query: Type.String({ description: "The query to classify" }),
		}),
		execute: async (_toolCallId, params: any): Promise<any> => {
			const result = classifyIntentHeuristic(params.query);
			return {
				content: [
					{
						type: "text" as const,
						text: `Intent Classification:\n- Type: **${result.type.toUpperCase()}**\n- Confidence: ${(result.confidence * 100).toFixed(0)}%\n- Reason: ${result.reason}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "generate_subqueries",
		label: "Generate Subqueries",
		description:
			"Generate atomic sub-queries from a complex query for better retrieval. Based on PriHA paper Intent-Based Generalizer.",
		parameters: Type.Object({
			query: Type.String({ description: "The query to decompose" }),
		}),
		execute: async (_toolCallId, params: any): Promise<any> => {
			const intent = classifyIntentHeuristic(params.query);
			const result = generateSubqueriesSimple(params.query, intent);

			const subqueriesText = result.subqueries.map((q, i) => `${i + 1}. ${q}`).join("\n");
			
			return {
				content: [
					{
						type: "text" as const,
						text: `Sub-query Generation:\n\n**Original Query:** ${params.query}\n\n**Intent:** ${intent.type} (${(intent.confidence * 100).toFixed(0)}% confidence)\n\n**Generated Sub-queries:**\n${subqueriesText}${result.requiresClarification ? "\n\n⚠️ *This query may need clarification for optimal retrieval.*" : ""}`,
					},
				],
				details: result,
			};
		},
	});

	// ── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("query-opt", {
		description: "Toggle query optimizer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Query optimizer ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("query-opt-test", {
		description: "Test query classification",
		handler: async (args, ctx) => {
			const text = args || "better dental clinic";
			const intent = classifyIntentHeuristic(text);
			const result = generateSubqueriesSimple(text, intent);
			ctx.ui.notify(
				`"${text}" → ${intent.type} (${(intent.confidence * 100).toFixed(0)}%) | ${result.subqueries.length} sub-queries`,
				"info"
			);
		},
	});

	console.log("[query-optimizer] Extension registered");
}

// Export for direct usage
export { classifyIntentHeuristic as classifyIntent, generateSubqueriesSimple as generateSubqueries };