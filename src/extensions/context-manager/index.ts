/**
 * Context Manager Extension
 *
 * Git-like context management for sessions:
 * - context_tag: Create named save points (milestones)
 * - context_log: View history with token usage
 * - context_checkout: Navigate to previous state
 *
 * Key: pi in factory is ExtensionAPI (registration only).
 * Session manager methods accessed via ctx in tool execute and event handlers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Schemas
// ============================================================================

const contextTagSchema = Type.Object({
	name: Type.String({ description: "The tag/milestone name" }),
	target: Type.Optional(Type.String({ description: "Entry ID (defaults to HEAD)" })),
});

const contextLogSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max entries (default: 50)" })),
	verbose: Type.Optional(Type.Boolean({ description: "Show all messages" })),
});

const contextCheckoutSchema = Type.Object({
	target: Type.String({ description: "Tag name or entry ID" }),
	message: Type.String({ description: "Summary of progress to carry forward" }),
	backupTag: Type.Optional(Type.String({ description: "Tag current state before checkout" })),
});

const contextPruneSchema = Type.Object({
	dryRun: Type.Optional(Type.Boolean({ description: "Analyze without making changes (default: true)" })),
	minAge: Type.Optional(Type.Number({ description: "Min turns since entry to consider (default: 5)" })),
	summarize: Type.Optional(Type.Boolean({ description: "Suggest creating summary before pruning (default: true)" })),
	toolFilter: Type.Optional(Type.Array(Type.String(), { description: "Focus on specific tool types (e.g. ['bash', 'read'])" })),
});

const contextAuditSchema = Type.Object({
	includeRecommendations: Type.Optional(Type.Boolean({ description: "Include action recommendations (default: true)" })),
	detailLevel: Type.Optional(Type.Union([
		Type.Literal("summary"),
		Type.Literal("detailed"),
		Type.Literal("full"),
	], { description: "How much detail (default: detailed)" })),
});

// ============================================================================
// Helpers
// ============================================================================

const INTERNAL_TOOLS = ["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"];

function isInternal(name: string): boolean {
	return INTERNAL_TOOLS.includes(name);
}

function resolveTarget(ctx: any, target: string): string | null {
	if (!target) return null;
	if (target.toLowerCase() === "root") {
		const tree = ctx.sessionManager.getTree();
		return tree.length > 0 ? tree[0].entry.id : target;
	}
	if (/^[0-9a-f]{8,}$/i.test(target)) return target;
	const tree = ctx.sessionManager.getTree();
	for (const node of tree) {
		if (ctx.sessionManager.getLabel(node.entry.id) === target) {
			return node.entry.id;
		}
	}
	return target;
}

function findByLabel(ctx: any, label: string): string | null {
	const tree = ctx.sessionManager.getTree();
	for (const node of tree) {
		if (ctx.sessionManager.getLabel(node.entry.id) === label) {
			return node.entry.id;
		}
	}
	return null;
}

function resolveDefaultTarget(ctx: any): string | null {
	const branch = ctx.sessionManager.getBranch();
	let targetId: string | null = null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult") {
				if (!isInternal(msg.toolName)) { targetId = entry.id; break; }
			} else if (msg.role === "assistant") {
				const hasInternal = (msg.content as any[]).some(
					(c: any) => c.type === "toolCall" && isInternal(c.name),
				);
				if (!hasInternal) { targetId = entry.id; break; }
			}
		}
		if (!targetId) targetId = entry.id;
		break;
	}
	if (!targetId && branch.length > 0) {
		targetId = ctx.sessionManager.getLeafId();
	}
	return targetId;
}

// ============================================================================
// Analysis Helpers
// ============================================================================

interface PruneCandidate {
	id: string;
	type: string;
	age: number;
	reason: string;
	score: number; // Higher = more candidates for pruning
	toolName?: string;
	content?: string;
}

interface AuditResult {
	usage: { percent: number; tokens: number; contextWindow: number };
	branchLength: number;
	treeDepth: number;
	oldestEntry: { id: string; age: number } | null;
	tagCount: number;
	summaryCount: number;
	branchCount: number;
	candidates: PruneCandidate[];
	recommendations: Array<{ priority: "high" | "medium" | "low"; action: string; reason: string }>;
	branchingTriggers: Array<{ reason: string; threshold: string; current: string }>;
}

function analyzeSession(ctx: any): AuditResult {
	const sm = ctx.sessionManager;
	const branch = sm.getBranch();
	const tree = sm.getTree();
	const currentLeafId = sm.getLeafId();
	
	let usage = { percent: 0, tokens: 0, contextWindow: 0 };
	try {
		const ctxUsage = ctx.getContextUsage?.();
		if (ctxUsage) {
			usage = {
				percent: ctxUsage.percent ?? 0,
				tokens: ctxUsage.tokens ?? 0,
				contextWindow: ctxUsage.contextWindow ?? 200000,
			};
		}
	} catch {}

	// Count tags, summaries, branches
	let tagCount = 0;
	let summaryCount = 0;
	const branchIds = new Set<string>();
	
	for (const node of tree) {
		const label = sm.getLabel(node.entry.id);
		if (label) tagCount++;
		if (node.entry.type === "branch_summary" || node.entry.type === "compaction") {
			summaryCount++;
		}
		branchIds.add(node.entry.id);
	}

	// Build branch index
	const entryIndex = new Map<string, number>();
	branch.forEach((e: any, i: number) => entryIndex.set(e.id, i));
	
	// Find candidates for pruning
	const candidates: PruneCandidate[] = [];
	let oldestEntry: { id: string; age: number } | null = null;
	
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		const age = branch.length - 1 - i; // Distance from leaf
		
		if (i === 0) {
			oldestEntry = { id: entry.id, age };
		}
		
		if (age < 3) continue; // Skip recent entries
		
		let score = 0;
		let reason = "";
		
		if (entry.type === "message") {
			const msg = entry.message as any;
			
			if (msg.role === "toolResult") {
				// Check for obsolete tool calls
				const toolName = msg.toolName;
				
				// Internal tools are low value
				if (isInternal(toolName)) {
					score += 0.3;
					reason = "Internal tool result (low semantic value)";
				}
				
				// bash/read without file changes in result are often obsolete
				if (["bash", "read", "grep"].includes(toolName)) {
					const details = msg.details as Record<string, any>;
					const hasOutput = details?.stdout || details?.content;
					if (!hasOutput || (typeof details === "object" && Object.keys(details).length === 0)) {
						score += 0.4;
						reason = reason || "Tool call with minimal output";
					}
				}
				
				// Think/hypothesize tools with no decisions
				if (toolName === "think" || toolName === "hypothesize") {
					score += 0.2;
					reason = reason || "Reasoning tool (consider summarizing)";
				}
				
				// Tool calls far from any tag
				const nearestTag = findNearestTag(ctx, entry.id);
				if (nearestTag.distance > 10) {
					score += 0.3;
					reason = reason || `Far from tag '${nearestTag.label}'`;
				}
				
				candidates.push({
					id: entry.id,
					type: "toolResult",
					age,
					reason: reason || "Old tool call",
					score: Math.min(1, score),
					toolName,
					content: (msg.content?.[0]?.text ?? "").toString().slice(0, 100),
				});
			} else if (msg.role === "assistant") {
				// Assistant messages with only tool calls (no text)
				const hasText = (msg.content as any[])?.some((c: any) => c.type === "text" && c.text?.length > 50);
				if (!hasText) {
					score = 0.4;
					reason = "Assistant message with no substantive text";
					candidates.push({
						id: entry.id,
						type: "assistant",
						age,
						reason,
						score,
						content: "(tool calls only)",
					});
				}
			}
		}
	}
	
	// Sort by score descending
	candidates.sort((a, b) => b.score - a.score);
	
	// Generate recommendations
	const recommendations: AuditResult["recommendations"] = [];
	
	// High usage warning
	if (usage.percent > 80) {
		recommendations.push({
			priority: "high",
			action: "Prune or summarize before continuing",
			reason: `Context at ${usage.percent.toFixed(1)}% — approaching limit`,
		});
	} else if (usage.percent > 60) {
		recommendations.push({
			priority: "medium",
			action: "Consider creating a checkpoint",
			reason: `Context at ${usage.percent.toFixed(1)}% — moderate usage`,
		});
	}
	
	// Many candidates
	if (candidates.length > 10) {
		recommendations.push({
			priority: "medium",
			action: `Review ${Math.min(5, candidates.length)} prune candidates`,
			reason: `${candidates.length} entries are candidates for pruning/summarization`,
		});
	}
	
	// No tags
	if (tagCount === 0 && branch.length > 10) {
		recommendations.push({
			priority: "medium",
			action: "Create a checkpoint",
			reason: "No tags in session — consider creating milestones for navigation",
		});
	}
	
	// Branching triggers
	const branchingTriggers: AuditResult["branchingTriggers"] = [];
	
	// High context with multiple directions
	if (usage.percent > 70) {
		branchingTriggers.push({
			reason: "High context usage",
			threshold: "> 70%",
			current: `${usage.percent.toFixed(1)}%`,
		});
	}
	
	// Multiple off-branch children
	const offBranchChildren = tree.filter((n: any) => {
		const inBranch = entryIndex.has(n.entry.id);
		return !inBranch && n.entry.type !== "branch_summary";
	});
	if (offBranchChildren.length > 2) {
		branchingTriggers.push({
			reason: "Multiple exploration paths",
			threshold: "> 2 off-branch paths",
			current: `${offBranchChildren.length} paths`,
		});
	}
	
	return {
		usage,
		branchLength: branch.length,
		treeDepth: tree.length,
		oldestEntry,
		tagCount,
		summaryCount,
		branchCount: tree.filter((n: any) => sm.getChildren(n.entry.id).length > 1).length,
		candidates: candidates.slice(0, 20), // Cap at 20
		recommendations,
		branchingTriggers,
	};
}

function findNearestTag(ctx: any, entryId: string): { label: string; distance: number } {
	const sm = ctx.sessionManager;
	const tree = sm.getTree();
	const branch = sm.getBranch();
	const entryIndex = new Map<string, number>();
	branch.forEach((e: any, i: number) => entryIndex.set(e.id, i));
	
	const targetIndex = entryIndex.get(entryId) ?? -1;
	if (targetIndex === -1) return { label: "none", distance: 999 };
	
	let nearestLabel = "none";
	let nearestDistance = 999;
	
	for (const node of tree) {
		const label = sm.getLabel(node.entry.id);
		if (label) {
			const idx = entryIndex.get(node.entry.id);
			if (idx !== undefined) {
				const dist = Math.abs(idx - targetIndex);
				if (dist < nearestDistance) {
					nearestDistance = dist;
					nearestLabel = label;
				}
			}
		}
	}
	
	return { label: nearestLabel, distance: nearestDistance };
}

function formatPruneCandidates(candidates: PruneCandidate[], limit = 10): string {
	const lines: string[] = [];
	const shown = candidates.slice(0, limit);
	
	for (const c of shown) {
		const scoreBar = "█".repeat(Math.round(c.score * 10)) + "░".repeat(10 - Math.round(c.score * 10));
		const age = c.age > 0 ? `${c.age} turns ago` : "current";
		const tool = c.toolName ? `(${c.toolName})` : "";
		const content = c.content ? ` ${c.content.slice(0, 40)}` : "";
		lines.push(`[${scoreBar}] ${c.id.slice(0, 8)} ${age} ${tool}${content}`);
		lines.push(`           └─ ${c.reason}`);
	}
	
	if (candidates.length > limit) {
		lines.push(`... and ${candidates.length - limit} more`);
	}
	
	return lines.join("\n");
}

// ============================================================================
// Extension
// ============================================================================

let _checkoutParams: any = null;

/** Module state for cross-event tracking */
const state = {
	compactionHappened: false,
};

// ============================================================================
// Compaction Auto-Retry Configuration
// ============================================================================

const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
const COMPACTION_RETRY_BASE_DELAY_MS = 2000;
const COMPACTION_RETRY_CUSTOM_TYPE = "__compact_retry_trigger";

/** Retryable error patterns for compaction failures */
const COMPACTION_RETRYABLE_PATTERNS = [
	/529/i,                    // Cerebras overloaded
	/overloaded/i,             // Generic overloaded
	/too many requests/i,      // Rate limit
	/429/i,                    // HTTP 429
	/500/i,                    // Internal server error
	/502/i,                    // Bad gateway
	/503/i,                    // Service unavailable
	/504/i,                    // Gateway timeout
	/server error/i,           // Generic server error
	/service unavailable/i,    // Generic unavailable
	/connection.?error/i,      // Network errors
	/connection.?refused/i,    // Network errors
	/fetch failed/i,           // Fetch errors
	/upstream.?connect/i,      // Proxy errors
	/reset before headers/i,   // Connection reset
	/timeout/i,                // Timeout errors
];

/** Errors that should NOT be retried (likely permanent issues) */
const COMPACTION_NON_RETRYABLE_PATTERNS = [
	/invalid.*api.?key/i,
	/authentication.*failed/i,
	/unauthorized/i,
	/forbidden/i,
	/context.?window.*exceeded/i,
	/token.*limit.*exceeded/i,
	/maximum.*context/i,
	/model.*not.*found/i,
	/model.*does.*not.*exist/i,
];

/** Track compaction retry state */
interface CompactionRetryState {
	attempt: number;
	lastError: string;
	lastReason: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
}

const compactionRetryState: CompactionRetryState = {
	attempt: 0,
	lastError: "",
	lastReason: "",
	retryTimeout: null,
};

/** Check if an error message matches retryable patterns */
function isCompactionRetryable(errorMessage: string): boolean {
	// Check if it's explicitly non-retryable first
	for (const pattern of COMPACTION_NON_RETRYABLE_PATTERNS) {
		if (pattern.test(errorMessage)) {
			return false;
		}
	}
	// Check if it's retryable
	for (const pattern of COMPACTION_RETRYABLE_PATTERNS) {
		if (pattern.test(errorMessage)) {
			return true;
		}
	}
	return false;
}

/** Get delay for current retry attempt with exponential backoff */
function getCompactionRetryDelay(attempt: number): number {
	return COMPACTION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/** Clear any pending retry timeout */
function clearCompactionRetry(): void {
	if (compactionRetryState.retryTimeout) {
		clearTimeout(compactionRetryState.retryTimeout);
		compactionRetryState.retryTimeout = null;
	}
}

/** Reset compaction retry state */
function resetCompactionRetry(): void {
	clearCompactionRetry();
	compactionRetryState.attempt = 0;
	compactionRetryState.lastError = "";
	compactionRetryState.lastReason = "";
}

/**
 * Deduplication set for compaction events.
 * session_compact and compaction_end can both fire for the same compaction.
 * We track entry IDs to avoid sending duplicate nudges.
 */
const _compactedEntries = new Set<string>();

export default function contextManagerExtension(pi: ExtensionAPI) {
	// ── context_tag ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "context_tag",
		label: "Context Tag",
		description:
			"Create a named save point (milestone) in conversation history. Use before risky changes or when stable.",
		parameters: contextTagSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const sm = ctx.sessionManager;

			let targetId = params.target ? resolveTarget(ctx, params.target) : null;
			if (!targetId) {
				targetId = resolveDefaultTarget(ctx);
			}

			if (!targetId) {
				return {
					content: [{ type: "text" as const, text: "No entry to tag. Conversation may be empty." }],
					details: {},
				};
			}

			const existing = findByLabel(ctx, params.name);
			if (existing) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Tag '${params.name}' already exists at ${existing}. Use a different name.`,
						},
					],
					details: { error: true, existingId: existing },
				};
			}

			sm.appendLabelChange(targetId, params.name);
			return {
				content: [{ type: "text" as const, text: `Created tag '${params.name}' at ${targetId}` }],
				details: { tag: params.name, targetId },
			};
		},
	});

	// ── context_log ────────────────────────────────────────────────────────
	pi.registerTool({
		name: "context_log",
		label: "Context Log",
		description: "View conversation history. Like git log. Shows context usage and milestones.",
		parameters: contextLogSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const sm = ctx.sessionManager;
			const branch = sm.getBranch();
			const currentLeafId = sm.getLeafId();
			const verbose = params.verbose ?? false;
			const limit = params.limit ?? 50;

			const backboneIds = new Set(branch.map((e: any) => e.id));
			const sequence: any[] = [];

			branch.forEach((entry: any) => {
				sequence.push(entry);
				sm.getChildren(entry.id).forEach((child: any) => {
					if (
						(child.type === "branch_summary" || child.type === "compaction") &&
						!backboneIds.has(child.id)
					) {
						sequence.push(child);
					}
				});
			});

			const isInteresting = (entry: any): boolean => {
				if (entry.id === currentLeafId) return true;
				if (branch.length > 0 && entry.id === branch[0].id) return true;
				if (sm.getLabel(entry.id)) return true;
				if (entry.type === "branch_summary" || entry.type === "compaction") return true;
				if (sm.getChildren(entry.id).length > 1) return true;
				if (entry.type === "message" && entry.message.role === "user") return true;
				return false;
			};

			const visibleIds = new Set<string>();
			sequence.forEach((e: any) => {
				if (verbose || isInteresting(e)) visibleIds.add(e.id);
			});

			const visibleArr = sequence.filter((e: any) => visibleIds.has(e.id));
			const trimmed = visibleArr.slice(-limit);
			const trimmedIds = new Set(trimmed.map((e: any) => e.id));

			const lines: string[] = [];
			let hiddenCount = 0;

			sequence.forEach((entry: any) => {
				if (!trimmedIds.has(entry.id)) {
					hiddenCount++;
					return;
				}
				if (hiddenCount > 0) {
					lines.push(`  :  ... (${hiddenCount} hidden) ...`);
					hiddenCount = 0;
				}

				const isHead = entry.id === currentLeafId;
				const label = sm.getLabel(entry.id);
				let role = entry.type.toUpperCase();
				let body = "";

				if (entry.type === "message") {
					const msg = entry.message;
					if (msg.role === "toolResult") {
						if (verbose || !isInternal(msg.toolName)) {
							const details = msg.details as Record<string, any>;
							const path = details?.path ? details.path.split("/").pop() + ": " : "";
							const text = (msg.content?.[0]?.text ?? "").toString();
							body = `(${msg.toolName}) ${path}${text.slice(0, 80)}`;
						}
					} else if (msg.role === "user") {
						const text = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? "");
						body = text.slice(0, 80);
					}
				} else if (entry.type === "branch_summary" || entry.type === "compaction") {
					body = (entry.summary || "").slice(0, 80);
					role = "SUMMARY";
				}

				const meta = [isHead ? "HEAD" : null, label ? `tag: ${label}` : null]
					.filter(Boolean)
					.join(", ");
				const marker = isHead ? "*" : role === "USER" ? "•" : "|";
				lines.push(`${marker} ${entry.id}${meta ? ` (${meta})` : ""} [${role}] ${body}`);
			});

			if (hiddenCount > 0) lines.push(`  :  ... (${hiddenCount} hidden) ...`);

			let usageStr = "unknown";
			try {
				const usage = ctx.getContextUsage?.();
				if (usage) {
					const pct = usage.percent?.toFixed(1) || "?";
					usageStr = `${pct}% (${Math.round(usage.tokens / 1024)}K/${Math.round(usage.contextWindow / 1024)}K)`;
				}
			} catch {}

			let steps = 0;
			let nearestTag = "none";
			for (let i = branch.length - 1; i >= 0; i--) {
				const lbl = sm.getLabel(branch[i].id);
				if (lbl) { nearestTag = lbl; break; }
				steps++;
			}

			const hud = `[Context] Usage: ${usageStr} · Segment: ${steps} steps since '${nearestTag}'`;

			return {
				content: [{ type: "text" as const, text: hud + "\n" + (lines.join("\n") || "(empty)") }],
				details: { usage: usageStr, stepsSinceTag: steps, nearestTag },
			};
		},
	});

	// ── context_checkout ────────────────────────────────────────────────
	pi.registerTool({
		name: "context_checkout",
		label: "Context Checkout",
		description: "Navigate to any point in conversation history. Like git checkout.",
		parameters: contextCheckoutSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const sm = ctx.sessionManager;
			const targetId = resolveTarget(ctx, params.target);
			const currentLeaf = sm.getLeafId();

			if (!targetId) {
				return {
					content: [{ type: "text" as const, text: `Could not resolve target '${params.target}'` }],
					details: { error: true },
				};
			}

			if (currentLeaf === targetId) {
				return {
					content: [{ type: "text" as const, text: `Already at ${targetId}` }],
					details: { noop: true },
				};
			}

			if (params.backupTag && currentLeaf) {
				sm.appendLabelChange(currentLeaf, params.backupTag);
			}

			const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
			const origin = currentLabel ? `tag: ${currentLabel}` : currentLeaf || "unknown";
			const enriched = `(summary from ${origin})\n${params.message}`;

			const newId = sm.branchWithSummary(targetId, enriched);
			_checkoutParams = { target: params.target, newId, targetId, backupTag: params.backupTag };
			ctx.abort();

			return {
				content: [{ type: "text" as const, text: `Checking out ${params.target}...` }],
				details: { checkout: true, newId },
			};
		},
	});

	// ── context_prune ─────────────────────────────────────────────────
	pi.registerTool({
		name: "context_prune",
		label: "Context Prune",
		description:
			"Analyze session and identify obsolete entries for pruning/summarization. Shows prune candidates ranked by score, with recommendations for context hygiene before compaction.",
		parameters: contextPruneSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const dryRun = params.dryRun ?? true;
			const minAge = params.minAge ?? 5;
			const summarize = params.summarize ?? true;
			
			const audit = analyzeSession(ctx);
			
			// Filter candidates by minAge and optional tool filter
			let candidates = audit.candidates.filter((c) => c.age >= minAge);
			
			if (params.toolFilter?.length) {
				candidates = candidates.filter((c) => 
					c.toolName && params.toolFilter.includes(c.toolName)
				);
			}
			
			// Take top candidates
			const topCandidates = candidates.slice(0, 15);
			
			const lines: string[] = [];
			
			if (dryRun) {
				lines.push(`## Context Prune Analysis (DRY RUN)`);
				lines.push("\nNo changes made. Set `dryRun: false` to proceed.");
			} else {
				lines.push(`## Context Prune Results`);
			}
			
			lines.push(`\n**Context Usage:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K tokens)`);
			lines.push(`**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`);
			
			if (topCandidates.length === 0) {
				lines.push("\n✓ No prune candidates found (session is clean)");
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { dryRun, candidatesFound: 0, audit },
				};
			}
			
			lines.push(`\n## Prune Candidates (${topCandidates.length} of ${candidates.length} shown)`);
			lines.push("\n" + formatPruneCandidates(topCandidates));
			
			// Summary recommendations
			if (summarize && topCandidates.length > 0) {
				const highScore = topCandidates.filter((c) => c.score >= 0.6);
				if (highScore.length > 0) {
					lines.push("\n## Recommendations");
					lines.push("\n**Before pruning, consider:");
					lines.push("1. `context_tag` to create a checkpoint");
					lines.push("2. Store key learnings in memory");
					lines.push("3. Update scratchpad with decisions");
					
					if (audit.usage.percent > 60) {
						lines.push("\n**⚠ High context usage!** Run `/compact` or use `context_checkout` to branch.");
					}
				}
			}
			
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { dryRun, candidatesFound: candidates.length, topCandidates: topCandidates.map((c) => ({ id: c.id, score: c.score, reason: c.reason })), audit },
			};
		},
	});

	// ── context_audit ──────────────────────────────────────────────────
	pi.registerTool({
		name: "context_audit",
		label: "Context Audit",
		description:
			"Comprehensive analysis of session context: usage stats, hygiene score, prune candidates, branching triggers, and actionable recommendations.",
		parameters: contextAuditSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const includeRecs = params.includeRecommendations ?? true;
			const detail = params.detailLevel ?? "detailed";
			
			const audit = analyzeSession(ctx);
			
			const lines: string[] = [];
			lines.push("## Context Audit Report");
			lines.push("\n### Usage Statistics");
			lines.push(`- **Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K tokens)`);
			lines.push(`- **Branch length:** ${audit.branchLength} entries`);
			lines.push(`- **Tree depth:** ${audit.treeDepth} total nodes`);
			lines.push(`- **Tags:** ${audit.tagCount}`);
			lines.push(`- **Summaries:** ${audit.summaryCount}`);
			lines.push(`- **Branches:** ${audit.branchCount}`);
			
			if (audit.oldestEntry) {
				lines.push(`- **Oldest entry:** ${audit.oldestEntry.id.slice(0, 8)} (${audit.oldestEntry.age} turns ago)`);
			}
			
			// Hygiene score (derived)
			let hygieneScore = 1.0;
			if (audit.usage.percent > 80) hygieneScore -= 0.3;
			else if (audit.usage.percent > 60) hygieneScore -= 0.15;
			if (audit.tagCount === 0 && audit.branchLength > 10) hygieneScore -= 0.2;
			if (audit.candidates.length > 10) hygieneScore -= 0.15;
			if (audit.summaryCount === 0 && audit.branchLength > 20) hygieneScore -= 0.2;
			hygieneScore = Math.max(0, Math.min(1, hygieneScore));
			
			const scoreEmoji = hygieneScore >= 0.8 ? "✓" : hygieneScore >= 0.5 ? "⚠" : "✗";
			lines.push(`\n### Hygiene Score: ${scoreEmoji} ${(hygieneScore * 100).toFixed(0)}%`);
			
			// Recommendations
			if (includeRecs && audit.recommendations.length > 0) {
				lines.push("\n### Recommendations");
				for (const rec of audit.recommendations) {
					const icon = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";
					lines.push(`${icon} **[${rec.priority.toUpperCase()}]** ${rec.action}`);
					lines.push(`   └─ ${rec.reason}`);
				}
			}
			
			// Branching triggers
			if (audit.branchingTriggers.length > 0) {
				lines.push("\n### Branching Triggers");
				lines.push("Consider `context_checkout` with `backupTag` to branch if:");
				for (const trigger of audit.branchingTriggers) {
					lines.push(`- ${trigger.reason}: ${trigger.current} (threshold: ${trigger.threshold})`);
				}
			}
			
			// Prune candidates (if detailed)
			if (detail === "full" || detail === "detailed") {
				const topPrune = audit.candidates.slice(0, detail === "full" ? 20 : 5);
				if (topPrune.length > 0) {
					lines.push(`\n### Top Prune Candidates (${topPrune.length})`);
					lines.push(formatPruneCandidates(topPrune, topPrune.length));
				}
			}
			
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { hygieneScore, audit },
			};
		},
	});

	// ── Navigate on turn_end (after branchWithSummary updates leaf) ───
	pi.on("turn_end", async (_event: any, ctx: any) => {
		if (!_checkoutParams) return;
		try {
			const msg = `Checked out ${_checkoutParams.target}. Use context_log to see updated position.`;
			console.log(`[context-manager] ${msg}`);
		} catch (err) {
			console.error("[context-manager] turn_end error:", err);
		}
		_checkoutParams = null;
	});

	// ── Compaction Integration ─────────────────────────────────────────
	// Reset retry state on successful turns (user got a valid response)
	pi.on("turn_end", async (_event: any, _ctx: any) => {
		// Only reset if compaction wasn't happening
		if (compactionRetryState.attempt > 0 && !compactionRetryState.retryTimeout) {
			resetCompactionRetry();
		}
	});

	// Provide custom instructions before compaction for smarter summarization
	pi.on("session_before_compact" as any, async (event: any, ctx: any) => {
		try {
			const audit = analyzeSession(ctx);
			
			// Build custom instructions that include hygiene insights
			const instructions: string[] = [];
			
			// Tag summary
			if (audit.tagCount > 0) {
				instructions.push(`Session has ${audit.tagCount} checkpoint(s): preserve tag labels for navigation.`);
			}
			
			// Prune candidates warning
			const highPriorityPrune = audit.candidates.filter((c) => c.score >= 0.6);
			if (highPriorityPrune.length > 3) {
				instructions.push(`${highPriorityPrune.length} entries are prune candidates with low semantic value — summarize briefly.`);
			}
			
			// Context usage context
			if (audit.usage.percent > 70) {
				instructions.push(`Context at ${audit.usage.percent.toFixed(0)}% — prioritize summarization of tool-heavy sections.`);
			}
			
			// Memory hint
			instructions.push("After compaction: consider storing key learnings in memory for cross-session continuity.");
			
			if (instructions.length > 0) {
				// Return custom instructions to enhance default summarization
				return {
					customInstructions: instructions.join(" "),
				};
			}
		} catch (err) {
			console.error("[context-manager] session_before_compact error:", err);
		}
	});

	// ── Tree Navigation Integration ──────────────────────────────────────
	// Provide intelligent defaults before tree navigation
	pi.on("session_before_tree" as any, async (event: any, ctx: any) => {
		try {
			const audit = analyzeSession(ctx);
			const preparation = event.preparation;
			
			// Auto-generate summary if none provided
			if (!preparation.summaryEntry && preparation.targetId) {
				// Find nearest tag for context
				const sm = ctx.sessionManager;
				const branch = sm.getBranch();
				const targetIndex = branch.findIndex((e: any) => e.id === preparation.targetId);
				
				let nearestTag = "checkpoint";
				if (targetIndex >= 0) {
					for (let i = targetIndex; i >= 0; i--) {
						const label = sm.getLabel(branch[i].id);
						if (label) { nearestTag = label; break; }
					}
				}
				
				return {
					summary: {
						summary: `[Branch from ${nearestTag}] Session state before branching.`,
						details: {
							contextPercent: audit.usage.percent.toFixed(0),
							branchLength: audit.branchLength,
							checkpoint: nearestTag,
						},
					},
				};
			}
		} catch (err) {
			console.error("[context-manager] session_before_tree error:", err);
		}
	});

	// ── Session Compact Event ────────────────────────────────────────────
	// Post-compaction: nudge agent to store key learnings
	// NOTE: session_compact fires ONLY on successful compaction.
	// For failure cases (overflow recovery failure, compaction throws), see compaction_end.
	pi.on("session_compact" as any, async (_event: any, _ctx: any) => {
		try {
			// Track this compaction so compaction_end knows not to duplicate the nudge
			const entry = _event.compactionEntry as any;
			if (entry?.id) {
				_compactedEntries.add(entry.id);
			}

			pi.sendMessage(
				{
					customType: "context",
					content: [{ type: "text" as const, text: "Context was just compacted. Consider storing key learnings in memory: memory_store(content=..., memoryType=\"insight\")" }],
					display: true,
				},
				{ deliverAs: "steer" },
			);
		} catch (err) {
			console.error("[context-manager] session_compact error:", err);
		}
	});

	// ── Compaction End Event ──────────────────────────────────────────────
	// Handles ALL compaction outcomes including failures.
	// session_compact only fires on success — this catches what it misses.
	pi.on("compaction_end" as any, async (event: any, _ctx: any) => {
		try {
			const { reason, willRetry, aborted, errorMessage, result } = event;

			// ── Overflow recovery failure ────────────────────────────────────
			// The most critical case: compaction worked but the retry still failed.
			// This means the underlying issue (wrong model, bad API key, or
			// non-overflow 400) persists regardless of context size.
			if (reason === "overflow" && !willRetry && !aborted) {
				// Only send if session_compact didn't already handle this (via entry ID check)
				const entryId = result?.firstKeptEntryId ?? (event as any).compactionEntry?.id;
				const alreadyHandled = entryId && _compactedEntries.has(entryId);
				const errMsg = errorMessage ?? "Compact succeeded but the retry still overflowed.";

				// Check if error is retryable (e.g. 529 overloaded is transient)
				if (!alreadyHandled && isCompactionRetryable(errMsg) && compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
					compactionRetryState.attempt++;
					compactionRetryState.lastError = errMsg;
					compactionRetryState.lastReason = reason;

					pi.sendMessage(
						{
							customType: "context",
							content: [{
								type: "text" as const,
								text: `⚠️ Overflow recovery failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
							}],
							display: true,
						},
						{ deliverAs: "steer" },
					);

					triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
					return;
				}

				// Non-retryable or exhausted retries - show permanent failure warning
				if (!alreadyHandled) {
					pi.sendMessage(
						{
							customType: "context",
							content: [{
								type: "text" as const,
								text: [
									"## ⚠️ Context overflow recovery failed",
									errMsg,
									"",
									"The API returned an overflow error even after compaction. This usually means:",
									"1. **Wrong model/provider** — the model ID doesn't match your API key",
									"2. **API key invalid** — Cerebras API key is wrong or account is suspended",
									"3. **Request format rejected** — the request itself violates the API's format rules",
									"",
									"**Immediate actions:**",
									"- Run `/model` to switch to a different model (e.g. anthropic/claude-3-5-sonnet)",
									"- Check your Cerebras API key in ~/.pi/settings.json",
									"- Run `context_audit()` to see session hygiene before continuing",
								].join("\n"),
							}],
							display: true,
						},
						{ deliverAs: "steer" },
					);
					_compactedEntries.add("overflow-failure-" + Date.now());
				}
				return;
			}

			// ── Aborted compaction ───────────────────────────────────────────
			if (aborted) {
				pi.sendMessage(
					{
						customType: "context",
						content: [{
							type: "text" as const,
							text: "Context compaction was aborted (no changes made). You can continue normally or run `/compact` manually when ready.",
						}],
						display: true,
					},
					{ deliverAs: "steer" },
				);
				return;
			}

			// ── Threshold/manual compaction failure (uncaught exception) ─────
			// result is undefined when compaction throws
			if ((reason === "threshold" || reason === "manual") && !result) {
				const errMsg = errorMessage ?? "Compaction threw an error.";

				// Check if error is retryable
				if (isCompactionRetryable(errMsg) && compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
					// Start or continue retry sequence
					compactionRetryState.attempt++;
					compactionRetryState.lastError = errMsg;
					compactionRetryState.lastReason = reason;

					const delayMs = getCompactionRetryDelay(compactionRetryState.attempt);
					pi.sendMessage(
						{
							customType: "context",
							content: [{
								type: "text" as const,
								text: `⚠️ Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
							}],
							display: true,
						},
						{ deliverAs: "steer" },
					);

					triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
					return;
				}

				// Non-retryable or exhausted retries - show warning
				pi.sendMessage(
					{
						customType: "context",
						content: [{
							type: "text" as const,
							text: [
								"## ⚠️ Auto-compaction failed",
								errMsg,
								"",
								"Your context is still large. Consider:",
								"- Running `/compact` manually to control the summary focus",
								"- Using `context_checkout` with `backupTag` to branch and preserve progress",
								"- Storing key learnings in memory before continuing",
							].join("\n"),
						}],
						display: true,
					},
					{ deliverAs: "steer" },
				);
				return;
			}

			// ── Successful compaction (willRetry=false, e.g. threshold/manual) ─
			// session_compact handles willRetry=true (overflow recovery success).
			// Here we handle successful non-recovery compaction.
			if (result && willRetry === false) {
				const entryId = result.firstKeptEntryId;
				const alreadyHandled = _compactedEntries.has(entryId);
				if (!alreadyHandled) {
					pi.sendMessage(
						{
							customType: "context",
							content: [{
								type: "text" as const,
								text: "Context was just compacted (auto-threshold). Consider storing key learnings in memory: memory_store(content=..., memoryType=\"insight\")",
							}],
							display: true,
						},
						{ deliverAs: "steer" },
					);
					_compactedEntries.add(entryId);
				}
			}
		} catch (err) {
			console.error("[context-manager] compaction_end error:", err);
		}
	});

	// ── /compact Command ──────────────────────────────────────────────
	// Manual compaction triggered by user. Uses ctx.compact() with callbacks
	// for real-time feedback (vs pi.sendMessage + triggerTurn approach).
	pi.registerCommand("compact", {
		description: "Manually compact the session context. Accepts optional custom instructions for the summary focus.",
		handler: async (args, ctx) => {
			const customInstructions = args.trim() || undefined;

			ctx.ui.notify("Compaction started...", "info");

			ctx.compact({
				customInstructions,
				onComplete: () => {
					ctx.ui.notify("Compaction completed.", "info");
				},
				onError: (error) => {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});
		},
	});

	// ── Compaction Auto-Retry Handler ──────────────────────────────────
	// Intercepts our hidden retry triggers to clean them from context.
	// This prevents the retry prompt from being seen by the LLM.
	pi.on("context", async (event) => {
		const messages = event.messages;
		let cleaned = false;
		const result = messages.map((msg: any) => {
			if (msg.role === "custom" && msg.customType === COMPACTION_RETRY_CUSTOM_TYPE) {
				cleaned = true;
				return null; // Mark for filtering
			}
			return msg;
		}).filter(Boolean);

		if (cleaned) {
			return { messages: result };
		}
	});

	// ── Compaction Retry Trigger ────────────────────────────────────────
	// Sends a hidden trigger message that causes the agent to retry compaction.
	// This uses triggerTurn to kick off a new turn with a compact retry prompt.
	function triggerCompactionRetry(pi: ExtensionAPI, attempt: number, errorMessage: string): void {
		// Clear any existing retry state
		clearCompactionRetry();

		const delayMs = getCompactionRetryDelay(attempt);
		const delaySec = (delayMs / 1000).toFixed(0);

		console.log(
			`[context-manager] Compaction retry ${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS} in ${delaySec}s: ${errorMessage}`,
		);

		compactionRetryState.retryTimeout = setTimeout(() => {
			compactionRetryState.retryTimeout = null;

			// Send hidden trigger message that prompts retry
			pi.sendMessage(
				{
					customType: COMPACTION_RETRY_CUSTOM_TYPE,
					content: [
						{
							type: "text" as const,
							text: attempt === 1
								? `[Auto-retry] Compaction failed (${errorMessage}). Retrying... (${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`
								: `[Auto-retry] Compaction retry ${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS}: ${errorMessage}`,
						},
					],
					display: false, // Hidden from user
				},
				{ triggerTurn: true },
			);
		}, delayMs);
	}

	// ── Compaction Retry Message Handler ────────────────────────────────
	// When we receive our hidden trigger, check if we should retry compaction
	// and if so, prompt the agent to run /compact again.
	pi.on("agent_end", async (event: any, ctx: any) => {
		// Only act if this was a compaction retry turn
		const messages = event.messages;
		let hasRetryTrigger = false;

		for (const msg of messages) {
			if (msg.role === "custom" && msg.customType === COMPACTION_RETRY_CUSTOM_TYPE) {
				hasRetryTrigger = true;
				break;
			}
		}

		if (!hasRetryTrigger) return;

		// Check if this turn's response was successful
		let lastAssistant: any = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				lastAssistant = messages[i];
				break;
			}
		}

		if (lastAssistant && lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") {
			// Success! Reset retry state
			if (compactionRetryState.attempt > 0) {
				ctx.ui.notify(
					`Compaction retry succeeded on attempt ${compactionRetryState.attempt}.`,
					"info",
				);
			}
			resetCompactionRetry();
			return;
		}

		// This retry turn also failed - check if we should retry again
		const errorMessage = lastAssistant?.errorMessage || compactionRetryState.lastError;

		if (compactionRetryState.attempt >= COMPACTION_RETRY_MAX_ATTEMPTS) {
			// Exhausted retries
			console.error(
				`[context-manager] Compaction retry exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errorMessage}`,
			);

			ctx.ui.notify(
				`Compaction failed permanently after ${COMPACTION_RETRY_MAX_ATTEMPTS} retries: ${errorMessage}`,
				"error",
			);

			ctx.ui.setStatus("context-manager", undefined);
			resetCompactionRetry();
			return;
		}

		// Increment attempt and schedule next retry
		compactionRetryState.attempt++;
		compactionRetryState.lastError = errorMessage;

		const delayMs = getCompactionRetryDelay(compactionRetryState.attempt);
		ctx.ui.setStatus(
			"context-manager",
			`Compaction failed "${errorMessage}", retrying (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`,
		);

		triggerCompactionRetry(pi, compactionRetryState.attempt, errorMessage);
	});

	// ── Auto-Retry End Event ──────────────────────────────────────────────
	// Catches non-overflow retry failures (429 rate limits, 500s, network errors).
	// NOTE: overflow errors do NOT use retry — they use compaction instead.
	pi.on("auto_retry_end" as any, async (event: any, _ctx: any) => {
		try {
			const { success, attempt, finalError } = event;

			if (!success) {
				pi.sendMessage(
					{
						customType: "context",
						content: [{
							type: "text" as const,
							text: [
								"## ⚠️ API retry failed after " + attempt + " attempt(s)",
								finalError ?? "Unknown error",
								"",
								"The API kept returning errors despite retries. Possible causes:",
								"- Rate limit (429) — wait a moment or switch models",
								"- Server error (500/502/503) — provider is having issues",
								"- Network error — check your connection",
								"",
								"Actions: Run `/model` to switch models, or wait and retry.",
							].join("\n"),
						}],
						display: true,
					},
					{ deliverAs: "steer" },
				);
			}
		} catch (err) {
			console.error("[context-manager] auto_retry_end error:", err);
		}
	});
}
