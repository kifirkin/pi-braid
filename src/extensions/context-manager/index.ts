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
import { getExtensionState } from "../../lib/extension-state.js";
import { addEvidence } from "../../lib/evidence-pool.js";
import { type PruningState, createPruningState, applyPruningWorkflow } from "./pruning.js";
import { type PruneCandidate, type AuditResult, analyzeSession, formatPruneCandidates } from "./analysis.js";
import {
	compactionRetryState, overflowRetryState, compactedEntries as _compactedEntries,
	COMPACTION_RETRY_MAX_ATTEMPTS, COMPACTION_RETRY_CUSTOM_TYPE, OVERFLOW_RETRY_MAX_ATTEMPTS,
	OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR,
	getCompactionRetryDelay, clearCompactionRetry, resetCompactionRetry,
	isTransientCompactionError, triggerCompactionRetry,
	getOverflowRetryDelay, clearOverflowRetry, resetOverflowRetry,
	triggerOverflowRetry,
} from "./retry.js";

// ── Session-Scoped State ──────────────────────────────────────────────────────

interface CmState {
	pruningState: PruningState;
	checkoutParams: any;
}

function getCmState(ctx: ExtensionContext): CmState {
	return getExtensionState(ctx, "context-manager", () => ({
		pruningState: createPruningState(),
		checkoutParams: null,
	}));
}

// ── Module Logger ────────────────────────────────────────────────────────────

const log = createLogger("context-manager");

// Pruning logic extracted to ./pruning.ts
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

// Session analysis extracted to ./analysis.ts
// Extension

// getCmState(ctx).checkoutParams moved to CmState (via getCmState)
// State and retry logic extracted to ./retry.ts
// Pruning state extracted to ./pruning.ts
// Session analysis extracted to ./analysis.ts


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
			getCmState(ctx).checkoutParams = { target: params.target, newId, targetId, backupTag: params.backupTag };
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
			lines.push(`**Auto-pruned:** ${getCmState(ctx).pruningState.stats.totalPruned} messages (${getCmState(ctx).pruningState.stats.totalProcessed} total processed)`);

			if (topCandidates.length === 0) {
				lines.push("\n✓ No prune candidates found (session is clean)");
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { candidatesFound: 0, audit, stats: getCmState(ctx).pruningState.stats },
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
					stats: getCmState(ctx).pruningState.stats,
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
		if (!getCmState(ctx).checkoutParams) return;
		try {
			// Navigate silently - user already notified by the command handler
		} catch (err) {
			log.error("turn_end error:", err);
		}
		getCmState(ctx).checkoutParams = null;
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

			// Record compaction as evidence about session state
			if (entry) {
				addEvidence(ctx, "context_compacted", "session",
					`Context compressed: ${entry.summary?.slice(0, 80) ?? "no summary"}`, 0.8);
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

			const filtered = applyPruningWorkflow(getCmState(ctx).pruningState, messages);

			// Log stats if we pruned anything
			const pruned = messages.length - filtered.length;
			if (pruned > 0) {
				addEvidence(ctx, "context_pruned", "session",
					`Pruned ${pruned} messages from context`, 0.7);
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
			const stats = getCmState(ctx).pruningState.stats;
			const rules = getCmState(ctx).pruningState.rules.filter((r) => r.enabled).map((r) => r.id);

			ctx.ui.notify(
				[
					"Context Pruning Stats:",
					`  Total pruned: ${stats.totalPruned}`,
					`  Total processed: ${stats.totalProcessed}`,
					`  Active rules: ${rules.join(", ") || "none"}`,
					`  Keep recent: ${getCmState(ctx).pruningState.keepRecentCount} messages`,
					`  Prune reasons: ${Object.entries(stats.pruneReasons).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
