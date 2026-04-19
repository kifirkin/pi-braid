/**
 * Context Manager Extension
 *
 * Git-like context management for sessions:
 * - context_tag: Create named save points (milestones)
 * - context_log: View history with token usage
 * - context_checkout: Navigate to previous state
 *
 * Rule-based context pruning:
 * - deduplication: Removes duplicate tool outputs
 * - superseded_writes: Removes older writes when newer versions exist
 * - error_purging: Removes resolved errors
 * - recency: Protects recent messages from pruning
 *
 * Key: pi in factory is ExtensionAPI (registration only).
 * Session manager methods accessed via ctx in tool execute and event handlers.
 */

import type { ExtensionAPI, SessionBeforeCompactEvent, SessionBeforeTreeEvent, SessionCompactEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CompactionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import { createLogger } from "../../lib/logger.js";

// ── Module Logger ────────────────────────────────────────────────────────────

const log = createLogger("context-manager");

// Rule-Based Pruning Types

interface MessageWithMetadata {
	message: AgentMessage;
	metadata: PruneMetadata;
}

interface PruneMetadata {
	hash?: string;
	filePath?: string;
	fileVersion?: string;
	isError?: boolean;
	errorResolved?: boolean;
	recencyScore?: number;
	shouldPrune?: boolean;
	pruneReason?: string;
	[key: string]: unknown;
}

interface PruneContext {
	messages: MessageWithMetadata[];
	index: number;
}

interface PruneRule {
	/** Internal rule identifier (not a tool name) */
	id: string;
	description?: string;
	enabled?: boolean;
	prepare?: (msg: MessageWithMetadata, ctx: PruneContext) => void;
	process?: (msg: MessageWithMetadata, ctx: PruneContext) => void;
}

// Pruning State

interface PruningState {
	enabled: boolean;
	rules: PruneRule[];
	keepRecentCount: number;
	protectedTools: Set<string>;
	stats: {
		totalPruned: number;
		totalProcessed: number;
		pruneReasons: Record<string, number>;
	};
}

const pruningState: PruningState = {
	enabled: true,
	rules: [],
	keepRecentCount: 10,
	protectedTools: new Set(["write", "edit"]),
	stats: {
		totalPruned: 0,
		totalProcessed: 0,
		pruneReasons: {},
	},
};

// Utility Functions

function hashMessage(msg: AgentMessage): string {
	const content = extractMessageContent(msg);
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36);
}

function extractMessageContent(msg: AgentMessage): string {
	if (!msg) return "";
	if (msg.role === "user" || msg.role === "assistant") {
		const content = msg.content;
		if (!content) return "";
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((p) => {
					if (typeof p === "object" && p !== null) {
						if ("text" in p) return (p as { text: string }).text;
						if ("thinking" in p) return (p as { thinking: string }).thinking;
					}
					return "";
				})
				.join(" ");
		}
	}
	return "";
}

function extractFilePath(msg: AgentMessage): string | undefined {
	if (msg.role !== "toolResult") return undefined;
	const details = (msg as { details?: { path?: string } }).details;
	if (details && typeof details === "object" && "path" in details && typeof details.path === "string") {
		return details.path;
	}
	return undefined;
}

function isErrorMessage(msg: AgentMessage): boolean {
	return msg.role === "toolResult" && (msg as { isError?: boolean }).isError === true;
}

function isSameOperation(msg1: AgentMessage, msg2: AgentMessage): boolean {
	const tool1 = (msg1 as { toolName?: string }).toolName;
	const tool2 = (msg2 as { toolName?: string }).toolName;
	if (tool1 !== tool2) return false;

	const args1 = (msg1 as { toolCallId?: string }).toolCallId;
	const args2 = (msg2 as { toolCallId?: string }).toolCallId;
	return args1 === args2;
}

function hasToolUse(msg: AgentMessage): boolean {
	if (msg.role !== "assistant") return false;
	if (!Array.isArray(msg.content)) return false;
	return msg.content.some((c: any) => c.type === "toolCall");
}

function hasToolResult(msg: AgentMessage): boolean {
	return msg.role === "toolResult" || msg.role === "bashExecution";
}

function extractToolUseIds(msg: AgentMessage): string[] {
	if (msg.role !== "assistant") return [];
	if (!Array.isArray(msg.content)) return [];
	return msg.content
		.filter((c: any) => c.type === "toolCall" && typeof c.id === "string")
		.map((c: any) => c.id as string);
}

function extractResultIds(msg: AgentMessage): string[] {
	if (!hasToolResult(msg)) return [];
	return [(msg as { toolCallId?: string }).toolCallId].filter((id): id is string => Boolean(id));
}

// Built-in Prune Rules

const deduplicationRule: PruneRule = {
	id: "deduplication",
	description: "Remove duplicate tool outputs based on content hash",
	enabled: true,

	prepare(msg: MessageWithMetadata) {
		msg.metadata.hash = hashMessage(msg.message);
	},

	process(msg: MessageWithMetadata, ctx: PruneContext) {
		if (msg.metadata.shouldPrune) return;
		if (msg.message.role === "user") return;
		if (hasToolUse(msg.message)) return;

		const currentHash = msg.metadata.hash;
		if (!currentHash) return;

		const seenBefore = ctx.messages.slice(0, ctx.index).some(
			(m) => m.metadata.hash === currentHash
		);

		if (seenBefore) {
			msg.metadata.shouldPrune = true;
			msg.metadata.pruneReason = "duplicate content";
		}
	},
};

const supersededWritesRule: PruneRule = {
	id: "superseded_writes",
	description: "Remove older file writes when newer versions exist",
	enabled: true,

	prepare(msg: MessageWithMetadata) {
		const filePath = extractFilePath(msg.message);
		if (filePath) {
			msg.metadata.filePath = filePath;
			msg.metadata.fileVersion = hashMessage(msg.message);
		}
	},

	process(msg: MessageWithMetadata, ctx: PruneContext) {
		if (msg.metadata.shouldPrune) return;
		if (!msg.metadata.filePath) return;
		if (msg.message.role === "user") return;

		const laterWrite = ctx.messages.slice(ctx.index + 1).find(
			(m) => m.metadata.filePath === msg.metadata.filePath
		);

		if (laterWrite) {
			msg.metadata.shouldPrune = true;
			msg.metadata.pruneReason = `superseded by later write to ${msg.metadata.filePath}`;
		}
	},
};

const errorPurgingRule: PruneRule = {
	id: "error_purging",
	description: "Remove resolved errors from context",
	enabled: true,

	prepare(msg: MessageWithMetadata, ctx: PruneContext) {
		const isError = isErrorMessage(msg.message);
		msg.metadata.isError = isError;

		if (isError) {
			const laterSuccess = ctx.messages.slice(ctx.index + 1).find(
				(m: MessageWithMetadata) => isSameOperation(m.message, msg.message) && !isErrorMessage(m.message)
			);
			msg.metadata.errorResolved = !!laterSuccess;
		}
	},

	process(msg: MessageWithMetadata) {
		if (msg.metadata.shouldPrune) return;
		if (msg.message.role === "user") return;

		if (msg.metadata.isError && msg.metadata.errorResolved) {
			msg.metadata.shouldPrune = true;
			msg.metadata.pruneReason = "error resolved by later success";
		}
	},
};

const recencyRule: PruneRule = {
	id: "recency",
	description: "Protect recent messages from pruning",
	enabled: true,

	prepare(msg: MessageWithMetadata, ctx: PruneContext) {
		msg.metadata.recencyScore = ctx.messages.length - 1 - ctx.index;
	},

	process(msg: MessageWithMetadata) {
		if (msg.metadata.recencyScore !== undefined && msg.metadata.recencyScore < pruningState.keepRecentCount) {
			msg.metadata.shouldPrune = false;
		}
	},
};

// Batch Context Reduction (BCR) - P4
// Collapse consecutive repeated tool call sequences into single entries with count.
// E.g., three `read` calls on same file → one entry with count=3.

interface BCRMetadata {
	bcrCount?: number;
	bcrCollapsed?: boolean;
	bcrKey?: string;
}

const batchCollapseRule: PruneRule = {
	id: "batch_collapse",
	description: "Collapse consecutive repeated tool calls into single entries with count",
	enabled: true,

	prepare(msg: MessageWithMetadata) {
		if (msg.message.role !== "assistant") return;
		if (!Array.isArray(msg.message.content)) return;

		const toolCalls = msg.message.content.filter((c: any) => c.type === "toolCall");
		if (toolCalls.length !== 1) return; // Only collapse single-tool entries

		const toolCall = toolCalls[0] as any;
		const toolName = toolCall.name;
		const toolArgs = JSON.stringify(toolCall.arguments ?? {});
		msg.metadata.bcrKey = `${toolName}:${toolArgs}`;
	},

	process(msg: MessageWithMetadata, ctx: PruneContext) {
		if (!msg.metadata.bcrKey) return;

		// Look for previous consecutive entries with the same tool call
		let count = 1;
		let prevIndex = ctx.index - 1;

		while (prevIndex >= 0) {
			const prev = ctx.messages[prevIndex];
			if (prev.metadata.bcrKey !== msg.metadata.bcrKey) break;

			// Check if it's the same assistant message (consecutive)
			if (prev.metadata.bcrCollapsed) {
				count += (prev.metadata.bcrCount as number) ?? 1;
			} else {
				count += 1;
			}
			prevIndex--;
		}

		if (count > 1) {
			// This is a repeated tool call - collapse it
			msg.metadata.bcrCount = count;
			msg.metadata.bcrCollapsed = true;
			msg.metadata.shouldPrune = true;
			msg.metadata.pruneReason = `collapsed ${count}x repeated tool call`;
		}
	},
};

// Register built-in rules
pruningState.rules = [
	batchCollapseRule,
	deduplicationRule,
	supersededWritesRule,
	errorPurgingRule,
	recencyRule,
];

// Pruning Workflow

function applyPruningWorkflow(messages: AgentMessage[]): AgentMessage[] {
	if (!pruningState.enabled || messages.length === 0) {
		return messages;
	}

	// Phase 1: Wrap messages with metadata
	const withMetadata: MessageWithMetadata[] = messages.map((message) => ({
		message,
		metadata: {} as PruneMetadata,
	}));

	// Phase 2: Prepare - annotate metadata
	for (const rule of pruningState.rules) {
		if (!rule.enabled) continue;
		if (!rule.prepare) continue;

		withMetadata.forEach((msg, index) => {
			try {
				rule.prepare!(msg, { messages: withMetadata, index });
			} catch (err) {
				log.error(`Rule "${rule.id}" prepare error:`, err);
			}
		});
	}

	// Phase 3: Process - make pruning decisions
	for (const rule of pruningState.rules) {
		if (!rule.enabled) continue;
		if (!rule.process) continue;

		withMetadata.forEach((msg, index) => {
			try {
				rule.process!(msg, { messages: withMetadata, index });
			} catch (err) {
				log.error(`Rule "${rule.id}" process error:`, err);
			}
		});
	}

	// Phase 3.5: Repair orphaned tool pairs
	repairOrphanedToolPairs(withMetadata);

	// Phase 4: Filter
	const filtered = withMetadata.filter((m) => !m.metadata.shouldPrune).map((m) => m.message);

	// Update stats
	const prunedCount = messages.length - filtered.length;
	if (prunedCount > 0) {
		pruningState.stats.totalPruned += prunedCount;
		pruningState.stats.totalProcessed += messages.length;

		withMetadata
			.filter((m) => m.metadata.shouldPrune && m.metadata.pruneReason)
			.forEach((m) => {
				const reason = m.metadata.pruneReason!;
				pruningState.stats.pruneReasons[reason] = (pruningState.stats.pruneReasons[reason] || 0) + 1;
			});
		}

	return filtered;
}

function repairOrphanedToolPairs(messages: MessageWithMetadata[]): void {
	// Collect tool_use IDs from kept assistant messages
	const keptToolUseIds = new Set<string>();
	for (const msg of messages) {
		if (msg.metadata.shouldPrune) continue;
		if (!hasToolUse(msg.message)) continue;
		for (const id of extractToolUseIds(msg.message)) {
			keptToolUseIds.add(id);
		}
	}

	// Find orphaned tool_results and resurrect their assistants
	const resurrected: MessageWithMetadata[] = [];
	for (const msg of messages) {
		if (msg.metadata.shouldPrune) continue;
		if (!hasToolResult(msg.message)) continue;

		const resultIds = extractResultIds(msg.message);
		for (const id of resultIds) {
			if (keptToolUseIds.has(id)) continue;

			// Orphaned - find and resurrect the matching assistant
			for (const candidate of messages) {
				if (!candidate.metadata.shouldPrune) continue;
				if (!hasToolUse(candidate.message)) continue;
				const candidateIds = extractToolUseIds(candidate.message);
				if (candidateIds.includes(id)) {
					candidate.metadata.shouldPrune = false;
					candidate.metadata.pruneReason = undefined;
					resurrected.push(candidate);
					for (const cid of candidateIds) keptToolUseIds.add(cid);
					break;
				}
			}
		}
	}

	// Second pass: un-prune tool_results paired with resurrected assistants
	for (const assistant of resurrected) {
		const assistantIds = extractToolUseIds(assistant.message);
		for (const msg of messages) {
			if (!msg.metadata.shouldPrune) continue;
			if (!hasToolResult(msg.message)) continue;
			const resultIds = extractResultIds(msg.message);
			if (resultIds.some((id) => assistantIds.includes(id))) {
				msg.metadata.shouldPrune = false;
				msg.metadata.pruneReason = undefined;
			}
		}
	}

	// Third pass: mark orphaned tool_results for pruning (their assistants were compacted)
	// This prevents "tool result's tool id not found" errors after compaction
	for (const msg of messages) {
		if (msg.metadata.shouldPrune) continue;
		if (!hasToolResult(msg.message)) continue;

		const resultIds = extractResultIds(msg.message);
		for (const id of resultIds) {
			if (keptToolUseIds.has(id)) continue;

			// This tool_result's tool_call was compacted away
			// Mark for pruning to prevent validation errors
			msg.metadata.shouldPrune = true;
			msg.metadata.pruneReason = "orphaned_tool_result";
			log.debug(`Marking orphaned tool_result for pruning: ${id}`);
			break;
		}
	}
}

// Schemas

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
	/** Min turns since entry to consider for pruning analysis (default: 5) */
	minAge: Type.Optional(Type.Number()),
	/** Focus analysis on specific tool types (e.g. ['bash', 'read']) */
	toolFilter: Type.Optional(Type.Array(Type.String())),
});

const contextAuditSchema = Type.Object({
	includeRecommendations: Type.Optional(Type.Boolean({ description: "Include action recommendations (default: true)" })),
	detailLevel: Type.Optional(StringEnum(
		["summary", "detailed", "full"],
		{ description: "How much detail (default: detailed)" },
	)),
});

// Helpers

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
				if (!isInternal(String((msg as any).toolName ?? ""))) { targetId = entry.id; break; }
			} else if (msg.role === "assistant") {
				const hasInternal = msg.content.some(
					(c: any) => c.type === "toolCall" && isInternal(String(c.name ?? "")),
				);
				if (!hasInternal) { targetId = entry.id; break; }
			}
		}
		// Already handled above
		break;
	}
	if (!targetId && branch.length > 0) {
		targetId = ctx.sessionManager.getLeafId();
	}
	return targetId;
}

// Analysis Helpers

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
			const msg = entry.message;

			if (msg.role === "toolResult") {
				const toolResult = msg as { toolName?: string; details?: Record<string, unknown>; content?: Array<{ text?: string }> };
				// Check for obsolete tool calls
				const toolName = toolResult.toolName;

				// Internal tools are low value
				if (isInternal(String(toolName))) {
					score += 0.3;
					reason = "Internal tool result (low semantic value)";
				}

				// bash/read without file changes in result are often obsolete
				if (["bash", "read", "grep"].includes(toolName ?? "")) {
					const details = toolResult.details;
					const hasOutput = (details as Record<string, unknown>)?.stdout || (details as Record<string, unknown>)?.content;
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
					content: String((toolResult as any).content?.[0]?.text ?? "").slice(0, 100),
				});
			} else if (msg.role === "assistant") {
				// Assistant messages with only tool calls (no text)
				const hasText = msg.content?.some((c: any) => c.type === "text" && (c.text?.length ?? 0) > 50);
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
			reason: `Context at ${usage.percent.toFixed(1)}% - approaching limit`,
		});
	} else if (usage.percent > 60) {
		recommendations.push({
			priority: "medium",
			action: "Consider creating a checkpoint",
			reason: `Context at ${usage.percent.toFixed(1)}% - moderate usage`,
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
			reason: "No tags in session - consider creating milestones for navigation",
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

// Extension

let _checkoutParams: any = null;

/** Module state for cross-event tracking */
const state = {
	compactionHappened: false,
};

// Compaction Auto-Retry Configuration

const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
const COMPACTION_RETRY_BASE_DELAY_MS = 2000;
const COMPACTION_RETRY_CUSTOM_TYPE = "__compact_retry_trigger";

// Overflow Recovery Retry Configuration
// When overflow retry fails, we need to try MORE aggressive compaction
const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
const OVERFLOW_RETRY_BASE_DELAY_MS = 3000;
// Each retry keeps less context to ensure we fit in the model's limits
const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.7; // Keep 30% less each retry

/** Track compaction retry state */
interface CompactionRetryState {
	attempt: number;
	lastError: string;
	lastReason: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
}

/** Track overflow recovery retry state */
interface OverflowRetryState {
	attempt: number;
	lastError: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
	aggressiveMode: boolean; // When true, keep less context each retry
}

const compactionRetryState: CompactionRetryState = {
	attempt: 0,
	lastError: "",
	lastReason: "",
	retryTimeout: null,
};

const overflowRetryState: OverflowRetryState = {
	attempt: 0,
	lastError: "",
	retryTimeout: null,
	aggressiveMode: false,
};

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

/** Check if an error message indicates a transient server error that may succeed on retry */
function isTransientCompactionError(errorMessage: string | null | undefined): boolean {
	if (!errorMessage) return false;

	// 529 is Cerebras overload code
	if (/\b529\b/.test(errorMessage)) return true;

	// overloaded_error is Anthropic/Cerebras
	if (/overloaded_error/i.test(errorMessage)) return true;

	// Server overload indicators
	if (/server.*(overload|cluster.*load|high.*load|under.*high.*load)/i.test(errorMessage)) return true;

	// Rate limiting
	if (/rate.?limit|too.?many.?requests|429\b/i.test(errorMessage)) return true;

	// Server errors (5xx)
	if (/\b5\d{2}\b.*server/i.test(errorMessage)) return true;

	// 503 service unavailable
	if (/\b503\b/.test(errorMessage)) return true;

	return false;
}

function resetCompactionRetry(): void {
	clearCompactionRetry();
	compactionRetryState.attempt = 0;
	compactionRetryState.lastError = "";
	compactionRetryState.lastReason = "";
}

/** Get delay for overflow retry with exponential backoff */
function getOverflowRetryDelay(attempt: number): number {
	return OVERFLOW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/** Clear any pending overflow retry timeout */
function clearOverflowRetry(): void {
	if (overflowRetryState.retryTimeout) {
		clearTimeout(overflowRetryState.retryTimeout);
		overflowRetryState.retryTimeout = null;
	}
}

function resetOverflowRetry(): void {
	clearOverflowRetry();
	overflowRetryState.attempt = 0;
	overflowRetryState.lastError = "";
	overflowRetryState.aggressiveMode = false;
}

/**
 * Trigger aggressive overflow recovery retry.
 * Each retry keeps less context to ensure we fit in the model's limits.
 * Uses hidden steer message to trigger manual /compact with reduced keepRecentTokens.
 */
function triggerOverflowRetry(pi: ExtensionAPI, attempt: number, errorMessage: string, ctx: ExtensionContext | undefined): void {
	clearOverflowRetry();

	const delayMs = getOverflowRetryDelay(attempt);
	overflowRetryState.attempt = attempt;
	overflowRetryState.lastError = errorMessage;
	overflowRetryState.aggressiveMode = attempt > 1;

	overflowRetryState.retryTimeout = setTimeout(() => {
		overflowRetryState.retryTimeout = null;

		// Calculate reduced keepRecentTokens for aggressive compaction
		const baseKeep = 20000; // Default keepRecentTokens
		const reducedKeep = Math.floor(baseKeep * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, attempt - 1));

		// Send hidden trigger message that prompts aggressive /compact
		pi.sendMessage(
			{
				customType: "__overflow_retry_trigger",
				content: [
					{
						type: "text" as const,
						text: attempt === 1
							? `[Overflow Recovery] Initial compaction failed (${errorMessage}). Retrying with reduced context... (${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`
							: `[Overflow Recovery] Retry ${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS}: ${errorMessage}. Attempting more aggressive compaction (keep ≤${reducedKeep} tokens)...`,
					},
				],
				display: true, // Hidden from user
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}

/**
 * Deduplication set for compaction events.
 * session_compact and compaction_end can both fire for the same compaction.
 * We track entry IDs to avoid sending duplicate nudges.
 */
const _compactedEntries = new Set<string>();

export default function contextManagerExtension(pi: ExtensionAPI) {
	// ── Session start: raise reserveTokens above the 16384 default. ────────
	// The harness tracks text tokens but does not count tool schemas in usage,
	// so a small reserve fires compaction too late. Tool schemas alone can be
	// 8–15 K tokens; with tokenizer variance a 50 K reserve ensures compaction
	// fires well before hitting the context limit (e.g. 154.8 K for a 204.8 K model).
	pi.on("session_start", async (_event, ctx) => {
		try {
			const sm = ctx.sessionManager as { globalSettings?: { compaction?: { reserveTokens?: number } }; save?: () => void };
			if (sm?.globalSettings?.compaction) {
				sm.globalSettings.compaction.reserveTokens = 50_000;
				sm.save?.();
			}
		} catch { /* non-fatal */ }
	});

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
	// Analysis tool - identifies candidates for pruning (not actual removal)
	// Actual pruning happens via the `context` event handler
	pi.registerTool({
		name: "context_prune",
		label: "Context Prune",
		description:
			"Analyze session and identify obsolete entries for potential pruning. " +
			"This is ANALYSIS ONLY - it does not remove entries. " +
			"Automatic pruning runs on every LLM call via rule-based filtering (dedup, superseded writes, errors, recency). " +
			"Use `context_compress` for LLM-driven compression of specific ranges.",
		parameters: contextPruneSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const minAge = params.minAge ?? 5;

			const audit = analyzeSession(ctx);

			// Filter candidates by minAge and optional tool filter
			let candidates = audit.candidates.filter((c) => c.age >= minAge);

			if (params.toolFilter?.length) {
				candidates = candidates.filter((c) =>
					c.toolName && params.toolFilter.includes(c.toolName)
				);
			}

			const topCandidates = candidates.slice(0, 15);

			const lines: string[] = [];

			lines.push(`## Context Prune Analysis`);
			lines.push("\n📊 **Analysis mode** - This is analysis only.");
			lines.push("Automatic rule-based pruning runs on every LLM call.");
			lines.push("Use `context_compress` for LLM-driven compression.");

			lines.push(`\n**Context Usage:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K tokens)`);
			lines.push(`**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`);
			lines.push(`**Auto-pruned:** ${pruningState.stats.totalPruned} messages (${pruningState.stats.totalProcessed} total processed)`);

			if (topCandidates.length === 0) {
				lines.push("\n✓ No prune candidates found (session is clean)");
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { candidatesFound: 0, audit, stats: pruningState.stats },
				};
			}

			lines.push(`\n## Prune Candidates (${topCandidates.length} of ${candidates.length} shown)`);
			lines.push("\n" + formatPruneCandidates(topCandidates));

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					candidatesFound: candidates.length,
					topCandidates: topCandidates.map((c) => ({ id: c.id, score: c.score, reason: c.reason })),
					audit,
					stats: pruningState.stats,
				},
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
			// Navigate silently - user already notified by the command handler
		} catch (err) {
			log.error("turn_end error:", err);
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
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
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
				instructions.push(`${highPriorityPrune.length} entries are prune candidates with low semantic value - summarize briefly.`);
			}

			// Context usage context
			if (audit.usage.percent > 70) {
				instructions.push(`Context at ${audit.usage.percent.toFixed(0)}% - prioritize summarization of tool-heavy sections.`);
			}

			// Memory hint
			instructions.push("After compaction: consider storing key learnings in memory for cross-session continuity.");

			if (instructions.length > 0) {
				// Send a context message with custom instructions to guide compaction
				pi.sendMessage({
					customType: "context",
					display: true,
					content: [{ type: "text", text: `[COMPACTION_INSTRUCTIONS] ${instructions.join(" ")}` }],
				});
			}
		} catch (err) {
			log.error("session_before_compact error:", err);
		}
	});

	// ── Tree Navigation Integration ──────────────────────────────────────
	// Provide intelligent defaults before tree navigation
	pi.on("session_before_tree", async (event, ctx) => {
		try {
			const audit = analyzeSession(ctx);
			const preparation = event.preparation;

			// Auto-generate summary if none provided
			if (!(preparation as any).summaryEntry && (preparation as any).targetId) {
				// Find nearest tag for context
				const sm = ctx.sessionManager;
				const branch = sm.getBranch();
				const targetIndex = branch.findIndex((e: any) => e.id === (preparation as any).targetId);

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
			log.error("session_before_tree error:", err);
		}
	});

	// ── Session Compact Event ────────────────────────────────────────────
	// Post-compaction: nudge agent to store key learnings
	// NOTE: session_compact fires ONLY on successful compaction.
	// For failure cases (overflow recovery failure, compaction throws), see compaction_end.
	pi.on("session_compact", async (event: SessionCompactEvent, _ctx: ExtensionContext) => {
		try {
			// Track this compaction so compaction_end knows not to duplicate the nudge
			const entry = event.compactionEntry;
			if (entry?.id) {
				_compactedEntries.add(entry.id);
			}

			// Memory nudge: enforcement session_compact handles this (reads scratchpad for
		// unpersisted learnings, sends detailed memory_store() commands).
		// _compactedEntries tracking above dedupes against compaction_end.
		} catch (err) {
			log.error("session_compact error:", err);
		}
	});

	// ── Compaction End Event ──────────────────────────────────────────────
	// Handles ALL compaction outcomes including failures.
	// session_compact only fires on success - this catches what it misses.
	pi.on("compaction_end" as any, async (event: { reason?: string; willRetry?: boolean; aborted?: boolean; errorMessage?: string; result?: { firstKeptEntryId?: string }; compactionEntry?: { id?: string } }, _ctx: ExtensionContext) => {
		try {
			const { reason, willRetry, aborted, errorMessage, result } = event;

			// ── Overflow recovery failure ────────────────────────────────────
			// Compaction WORKED but the retry after compaction failed.
			// This could mean:
			// 1. Compaction didn't reduce enough (most common)
			// 2. Wrong model/provider configuration
			// 3. API key or format issues
			// We retry with MORE aggressive compaction instead of giving up.
			if (reason === "overflow" && !willRetry && !aborted) {
				const entryId = result?.firstKeptEntryId ?? event.compactionEntry?.id;

				const errMsg: string = errorMessage ?? "Compaction succeeded but the retry overflowed.";;

				// Retry with more aggressive compaction (up to OVERFLOW_RETRY_MAX_ATTEMPTS)
				if (overflowRetryState.attempt < OVERFLOW_RETRY_MAX_ATTEMPTS) {
					_compactedEntries.add(entryId ?? "overflow-" + Date.now());

					// Calculate reduced keepRecentTokens
					const baseKeep = 20000;
					const reducedKeep = Math.floor(baseKeep * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, overflowRetryState.attempt));

					pi.sendMessage({
						customType: "context",
						content: [{
							type: "text" as const,
							text: [
								`## ⚠️ Context overflow recovery failed (attempt ${overflowRetryState.attempt + 1}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`,
								errMsg,
								"",
								overflowRetryState.attempt === 0
									? "Retrying with more aggressive compaction..."
									: `Retrying with keep ≤${reducedKeep} tokens (attempt ${overflowRetryState.attempt + 1}/${OVERFLOW_RETRY_MAX_ATTEMPTS})...`,
								"",
								"If this persists, possible causes:",
								"1. **Model context limit exceeded** - Consider switching to a larger-context model",
								"2. **API configuration issue** - Run `/model` to verify settings",
								"3. **Tokenizer mismatch** - Local count differs from API",
							].join("\n"),
						}],
						display: true,
					}, { deliverAs: "steer" });

					// Trigger overflow retry with context
					triggerOverflowRetry(pi, overflowRetryState.attempt + 1, errMsg, undefined);
					return;
				}

				// Exhausted overflow retries
				_compactedEntries.add(entryId ?? "overflow-" + Date.now());

				pi.sendMessage({
					customType: "context",
					content: [{
						type: "text" as const,
						text: [
							"## ⚠️ Context overflow recovery exhausted",
							errMsg,
							"",
							"After " + OVERFLOW_RETRY_MAX_ATTEMPTS + " attempts, compaction cannot reduce context enough.",
							"",

							"**Possible context limit exceeded:**",
							"- Switch to a larger-context model\n- Start a new session\n- Store learnings in memory first",
							"",
							"**Manual intervention required:**",
							"- Run `/model` to switch to a different model (e.g. anthropic/claude-3-5-sonnet)",
							"- Run `context_audit()` to see session state",
							"- Consider using `memory_store()` to preserve key learnings before switching",
						].join("\n"),
					}],
					display: true,
				}, { deliverAs: "steer" });

				resetOverflowRetry();
				return;
			}

			// ── Aborted compaction ───────────────────────────────────────────
			if (aborted) {
				pi.sendMessage({
					customType: "context",
					content: [{
						type: "text" as const,
						text: "Context compaction was aborted (no changes made). You can continue normally or run `/compact` manually when ready.",
					}],
					display: true,
				}, { deliverAs: "steer" });
				return;
			}

			// ── Transient server error (529, overloaded, etc.) ─────────────────
			// Retry with backoff for transient errors regardless of reason code.
			// These errors indicate server overload, not session-specific issues.
			const errMsg: string = errorMessage ?? "Compaction threw an error.";;
			if (isTransientCompactionError(errorMessage)) {
				if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
					compactionRetryState.attempt++;
					compactionRetryState.lastError = errMsg;
					compactionRetryState.lastReason = reason ?? "";

					pi.sendMessage({
						customType: "context",
						content: [{
							type: "text" as const,
							text: `⚠️ Server overload (${errMsg}). Auto-retrying with backoff... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
						}],
						display: true,
					}, { deliverAs: "steer" });

					triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
					return;
				}

				// Exhausted retries
				pi.sendMessage({
					customType: "context",
					content: [{
						type: "text" as const,
						text: [
							"## ⚠️ Auto-compaction failed after retries (server overload)",
							errMsg,
							"",
							"The summarization server is experiencing high load.",
							"Consider waiting a moment and running `/compact` manually.",
						].join("\n"),
					}],
					display: true,
				}, { deliverAs: "steer" });
				return;
			}

			// ── Threshold/manual compaction failure ────────────────────────────
			// Compaction itself failed. Retry with backoff (max 3 attempts).
			if ((reason === "threshold" || reason === "manual") && !result) {
				if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
					compactionRetryState.attempt++;
					compactionRetryState.lastError = errMsg;
					compactionRetryState.lastReason = reason ?? "";

					pi.sendMessage({
						customType: "context",
						content: [{
							type: "text" as const,
							text: `⚠️ Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
						}],
						display: true,
					}, { deliverAs: "steer" });

					triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
					return;
				}

				// Exhausted retries
				pi.sendMessage({
					customType: "context",
					content: [{
						type: "text" as const,
						text: [
							"## ⚠️ Auto-compaction failed permanently",
							errMsg,
							"",
							"Your context is still large. Consider:",
							"- Running `/compact` manually to control the summary focus",
							"- Using `context_checkout` with `backupTag` to branch and preserve progress",
							"- Storing key learnings in memory before continuing",
						].join("\n"),
					}],
					display: true,
				}, { deliverAs: "steer" });
				return;
			}

			// ── Successful compaction ──────────────────────────────────────────
			// Memory nudge for successful compaction is handled by enforcement session_compact
			// (reads scratchpad, sends detailed memory_store() commands for unpersisted learnings).
			// Nothing needed here - enforcement covers it.
		} catch (err) {
			log.error("compaction_end error:", err);
		}
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
			if (msg.role === "custom" && msg.customType === "__overflow_retry_trigger") {
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

		// Schedule delayed retry with exponential backoff
		const delayMs = getCompactionRetryDelay(attempt);

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
		// Only act if this was a compaction retry turn or overflow retry turn
		const messages = event.messages;
		let hasRetryTrigger = false;
		let hasOverflowRetryTrigger = false;

		for (const msg of messages) {
			if (msg.role === "custom" && msg.customType === COMPACTION_RETRY_CUSTOM_TYPE) {
				hasRetryTrigger = true;
				break;
			}
			if (msg.role === "custom" && msg.customType === "__overflow_retry_trigger") {
				hasOverflowRetryTrigger = true;
			}
		}

		// Handle overflow retry separately
		if (hasOverflowRetryTrigger) {
			// Check if this turn's response was successful
			let lastAssistant: any = null;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") {
					lastAssistant = messages[i];
					break;
				}
			}

			if (lastAssistant && lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") {
				// Success! Reset overflow retry state
				if (overflowRetryState.attempt > 0) {
					ctx.ui.notify(
						`Overflow recovery succeeded on attempt ${overflowRetryState.attempt}!`,
						"info",
					);
				}
				resetOverflowRetry();
				return;
			}

			// This overflow retry also failed
			const errorMessage = lastAssistant?.errorMessage || overflowRetryState.lastError;

			if (overflowRetryState.attempt >= OVERFLOW_RETRY_MAX_ATTEMPTS) {
				// Exhausted overflow retries - this is handled in compaction_end
				resetOverflowRetry();
				return;
			}

			// Increment attempt and schedule next retry
			overflowRetryState.attempt++;
			overflowRetryState.lastError = errorMessage;

			const delayMs = getOverflowRetryDelay(overflowRetryState.attempt);
			ctx.ui.setStatus(
				"context-manager",
				`Overflow recovery "${errorMessage}", retrying (${overflowRetryState.attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`,
			);

			triggerOverflowRetry(pi, overflowRetryState.attempt, errorMessage, ctx);
			return;
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
            log.error(
                `Compaction retry exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errorMessage}`
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
	// NOTE: overflow errors do NOT use retry - they use compaction instead.
	pi.on("auto_retry_end" as any, async (event: any, _ctx: ExtensionContext) => {
		try {
			const { success, attempt, finalError } = event as { success?: boolean; attempt?: number; finalError?: string };

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
								"- Rate limit (429) - wait a moment or switch models",
								"- Server error (500/502/503) - provider is having issues",
								"- Network error - check your connection",
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
			log.error("auto_retry_end error:", err);
		}
	});

	// ── Context Event Handler ─────────────────────────────────────────────
	// Real pruning via message array transformation
	// This runs before each LLM call to filter/prune messages
	pi.on("context", async (event: any, ctx: any) => {
		try {
			const messages = event.messages as AgentMessage[];
			if (!messages || messages.length === 0) return;

			const filtered = applyPruningWorkflow(messages);

			// Log stats if we pruned anything
			const pruned = messages.length - filtered.length;
			if (pruned > 0) {
				// Debug logging suppressed to avoid leaking to TUI prompt
			}

			return { messages: filtered };
		} catch (err) {
			log.error("context event error:", err);
		}
	});

	// ── context_compress Tool ──────────────────────────────────────────────
	// LLM-driven compression: remove ranges and inject synthetic summaries
	pi.registerTool({
		name: "context_compress",
		label: "Compress Context",
		description:
			"Compress a range of conversation into a summary. The LLM generates a summary, " +
			"and the original messages are marked for removal from context (not deleted from session). " +
			"Use when a task is complete and the details are no longer needed in context.",
		parameters: Type.Object({
			topic: Type.String({ description: "Brief topic label (e.g., 'Auth Implementation', 'Bug Fix')" }),
			startIndex: Type.Number({ description: "Index of first message to compress" }),
			endIndex: Type.Number({ description: "Index of last message to compress" }),
			summary: Type.String({ description: "Comprehensive summary of what was accomplished" }),
		}),
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const { topic, startIndex, endIndex, summary } = params;

			if (startIndex < 0 || endIndex < startIndex) {
				return {
					content: [{ type: "text" as const, text: "Invalid range: startIndex must be >= 0 and endIndex must be >= startIndex" }],
					details: { error: true },
				};
			}

			// Store compression in session for persistence
			const sm = ctx.sessionManager;
			sm.appendCustomEntry("context_compression", {
				topic,
				startIndex,
				endIndex,
				summary,
				timestamp: Date.now(),
			});

			return {
				content: [{
					type: "text" as const,
					text: `Compressed ${endIndex - startIndex + 1} messages into summary: "${topic}"\n\n` +
							`The summary will be visible in context. Original messages are preserved in session file.`,
				}],
				details: {
					compressed: endIndex - startIndex + 1,
					topic,
				},
			};
		},
	});

	// ── context_prune_stats Command ───────────────────────────────────────
	pi.registerCommand("context-stats", {
		description: "Show context pruning statistics",
		handler: async (_args: string | undefined, ctx: any) => {
			const stats = pruningState.stats;
			const rules = pruningState.rules.filter((r) => r.enabled).map((r) => r.id);

			ctx.ui.notify(
				[
					"Context Pruning Stats:",
					`  Total pruned: ${stats.totalPruned}`,
					`  Total processed: ${stats.totalProcessed}`,
					`  Active rules: ${rules.join(", ") || "none"}`,
					`  Keep recent: ${pruningState.keepRecentCount} messages`,
					`  Prune reasons: ${Object.entries(stats.pruneReasons).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
