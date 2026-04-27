// ── Context-Manager Tools ─────────────────────────────────────────────────────
// All 6 tool registrations + 1 command registration.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../analysis.js";
import {
	log, getCmState, isInternal, resolveTarget, findByLabel, resolveDefaultTarget,
	formatPruneCandidates,
} from "./shared.js";

// ── Schema definitions ────────────────────────────────────────────────────────
const contextTagSchema = Type.Object({
	name: Type.String({ description: "Tag/milestone name" }),
	target: Type.Optional(Type.String({ description: "Entry ID or tag name (defaults to HEAD)" })),
});

const contextLogSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max entries (default 50)" })),
	verbose: Type.Optional(Type.Boolean({ description: "Show all entries" })),
});

const contextCheckoutSchema = Type.Object({
	target: Type.String({ description: "Tag name or entry ID to navigate to" }),
	message: Type.String({ description: "Summary to carry forward" }),
	backupTag: Type.Optional(Type.String({ description: "Tag name for current position before checkout" })),
});

const contextPruneSchema = Type.Object({
	minAge: Type.Optional(Type.Number({ description: "Minimum age in turns (default 5)" })),
	toolFilter: Type.Optional(Type.Array(Type.String())),
});

const contextAuditSchema = Type.Object({
	includeRecommendations: Type.Optional(Type.Boolean({ default: true })),
	detailLevel: Type.Optional(Type.String({ enum: ["summary", "detailed", "full"] })),
});

export function registerTools(pi: any): void {
	// ── context_tag ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "context_tag",
		label: "Context Tag",
		description: "Create a named save point (milestone) in conversation history. Use before risky changes or when stable.",
		parameters: contextTagSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
			const sm = ctx.sessionManager;
			let targetId = params.target ? resolveTarget(ctx, params.target) : null;
			if (!targetId) targetId = resolveDefaultTarget(ctx);
			if (!targetId) {
				return { content: [{ type: "text" as const, text: "No entry to tag. Conversation may be empty." }], details: {} };
			}
			const existing = findByLabel(ctx, params.name);
			if (existing) {
				return { content: [{ type: "text" as const, text: `Tag '${params.name}' already exists at ${existing}. Use a different name.` }], details: { error: true, existingId: existing } };
			}
			sm.appendLabelChange(targetId, params.name);
			return { content: [{ type: "text" as const, text: `Created tag '${params.name}' at ${targetId}` }], details: { tag: params.name, targetId } };
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
					if ((child.type === "branch_summary" || child.type === "compaction") && !backboneIds.has(child.id)) {
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
			sequence.forEach((e: any) => { if (verbose || isInteresting(e)) visibleIds.add(e.id); });

			const visibleArr = sequence.filter((e: any) => visibleIds.has(e.id));
			const trimmed = visibleArr.slice(-limit);
			const trimmedIds = new Set(trimmed.map((e: any) => e.id));

			const lines: string[] = [];
			let hiddenCount = 0;

			sequence.forEach((entry: any) => {
				if (!trimmedIds.has(entry.id)) { hiddenCount++; return; }
				if (hiddenCount > 0) { lines.push(`  :  ... (${hiddenCount} hidden) ...`); hiddenCount = 0; }

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

				const meta = [isHead ? "HEAD" : null, label ? `tag: ${label}` : null].filter(Boolean).join(", ");
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
			} catch { /* non-fatal: usage unavailable */ }

			let steps = 0;
			let nearestTag = "none";
			for (let i = branch.length - 1; i >= 0; i--) {
				const lbl = sm.getLabel(branch[i].id);
				if (lbl) { nearestTag = lbl; break; }
				steps++;
			}

			const hud = `[Context] Usage: ${usageStr} · Segment: ${steps} steps since '${nearestTag}'`;
			return { content: [{ type: "text" as const, text: hud + "\n" + (lines.join("\n") || "(empty)") }], details: { usage: usageStr, stepsSinceTag: steps, nearestTag } };
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
				return { content: [{ type: "text" as const, text: `Could not resolve target '${params.target}'` }], details: { error: true } };
			}
			if (currentLeaf === targetId) {
				return { content: [{ type: "text" as const, text: `Already at ${targetId}` }], details: { noop: true } };
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
			return { content: [{ type: "text" as const, text: `Checking out ${params.target}...` }], details: { checkout: true, newId } };
		},
	});

	// ── context_prune ─────────────────────────────────────────────────
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
			let candidates = audit.candidates.filter((c) => c.age >= minAge);
			if (params.toolFilter?.length) {
				candidates = candidates.filter((c) => c.toolName && params.toolFilter.includes(c.toolName));
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
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { candidatesFound: 0, audit, stats: getCmState(ctx).pruningState.stats } };
			}

			lines.push(`\n## Prune Candidates (${topCandidates.length} of ${candidates.length} shown)`);
			lines.push("\n" + formatPruneCandidates(topCandidates));
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { candidatesFound: candidates.length, topCandidates: topCandidates.map((c) => ({ id: c.id, score: c.score, reason: c.reason })), audit, stats: getCmState(ctx).pruningState.stats },
			};
		},
	});

	// ── context_audit ──────────────────────────────────────────────────
	pi.registerTool({
		name: "context_audit",
		label: "Context Audit",
		description: "Comprehensive analysis of session context: usage stats, hygiene score, prune candidates, branching triggers, and actionable recommendations.",
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
			if (audit.oldestEntry) lines.push(`- **Oldest entry:** ${audit.oldestEntry.id.slice(0, 8)} (${audit.oldestEntry.age} turns ago)`);

			let hygieneScore = 1.0;
			if (audit.usage.percent > 80) hygieneScore -= 0.3;
			else if (audit.usage.percent > 60) hygieneScore -= 0.15;
			if (audit.tagCount === 0 && audit.branchLength > 10) hygieneScore -= 0.2;
			if (audit.candidates.length > 10) hygieneScore -= 0.15;
			if (audit.summaryCount === 0 && audit.branchLength > 20) hygieneScore -= 0.2;
			hygieneScore = Math.max(0, Math.min(1, hygieneScore));
			const scoreEmoji = hygieneScore >= 0.8 ? "✓" : hygieneScore >= 0.5 ? "⚠" : "✗";
			lines.push(`\n### Hygiene Score: ${scoreEmoji} ${(hygieneScore * 100).toFixed(0)}%`);

			if (includeRecs && audit.recommendations.length > 0) {
				lines.push("\n### Recommendations");
				for (const rec of audit.recommendations) {
					const icon = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";
					lines.push(`${icon} **[${rec.priority.toUpperCase()}]** ${rec.action}`);
					lines.push(`   └─ ${rec.reason}`);
				}
			}

			if (audit.branchingTriggers.length > 0) {
				lines.push("\n### Branching Triggers");
				lines.push("Consider `context_checkout` with `backupTag` to branch if:");
				for (const trigger of audit.branchingTriggers) {
					lines.push(`- ${trigger.reason}: ${trigger.current} (threshold: ${trigger.threshold})`);
				}
			}

			if (detail === "full" || detail === "detailed") {
				const topPrune = audit.candidates.slice(0, detail === "full" ? 20 : 5);
				if (topPrune.length > 0) {
					lines.push(`\n### Top Prune Candidates (${topPrune.length})`);
					lines.push(formatPruneCandidates(topPrune, topPrune.length));
				}
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { hygieneScore, audit } };
		},
	});

	// ── context_compress ──────────────────────────────────────────────
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
				return { content: [{ type: "text" as const, text: "Invalid range: startIndex must be >= 0 and endIndex must be >= startIndex" }], details: { error: true } };
			}
			const sm = ctx.sessionManager;
			sm.appendCustomEntry("context_compression", { topic, startIndex, endIndex, summary, timestamp: Date.now() });
			return {
				content: [{
					type: "text" as const,
					text: `Compressed ${endIndex - startIndex + 1} messages into summary: "${topic}"\n\nThe summary will be visible in context. Original messages are preserved in session file.`,
				}],
				details: { compressed: endIndex - startIndex + 1, topic },
			};
		},
	});

	// ── context-stats Command ───────────────────────────────────────────
	pi.registerCommand("context-stats", {
		description: "Show context pruning statistics",
		handler: async (_args: string | undefined, ctx: any) => {
			const stats = getCmState(ctx).pruningState.stats;
			const rules = getCmState(ctx).pruningState.rules.filter((r: any) => r.enabled).map((r: any) => r.id);
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
