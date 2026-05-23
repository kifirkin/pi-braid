// ── Context-Manager Tools ─────────────────────────────────────────────────────
// All 6 tool registrations + 1 command registration.

import { Type } from "typebox";
import type { CompactOptions } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../analysis.js";
import {
  log,
  getCmState,
  isInternal,
  resolveTarget,
  findByLabel,
  resolveDefaultTarget,
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
  backupTag: Type.Optional(
    Type.String({ description: "Tag name for current position before checkout" }),
  ),
});

const contextPruneSchema = Type.Object({
  minAge: Type.Optional(Type.Number({ description: "Minimum age in turns (default 5)" })),
  toolFilter: Type.Optional(Type.Array(Type.String())),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), shows what would be removed without deleting. Set to false to actually remove entries.",
    }),
  ),
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
    promptSnippet: "Create a named save point in conversation history",
    description:
      "Create a named save point in conversation history before risky changes or when you want a stable checkpoint.",
    parameters: contextTagSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const sm = ctx.sessionManager;
      let targetId = params.target ? resolveTarget(ctx, params.target) : null;
      if (!targetId) targetId = resolveDefaultTarget(ctx);
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
    promptSnippet: "View conversation history with usage and milestones",
    description:
      "View conversation history with context usage and milestones — use like git log to inspect session progress.",
    parameters: contextLogSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
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
            const text =
              typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? "");
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
      } catch {
        /* non-fatal: usage unavailable */
      }

      let steps = 0;
      let nearestTag = "none";
      for (let i = branch.length - 1; i >= 0; i--) {
        const lbl = sm.getLabel(branch[i].id);
        if (lbl) {
          nearestTag = lbl;
          break;
        }
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
    promptSnippet: "Navigate to any point in conversation history",
    description:
      "Navigate to any point in conversation history — use like git checkout to restore or replay a previous state.",
    parameters: contextCheckoutSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
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
      getCmState(ctx).checkoutParams = {
        target: params.target,
        newId,
        targetId,
        backupTag: params.backupTag,
      };
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
    promptSnippet: "Identify and remove obsolete session entries",
    description:
      "Analyze session for entries eligible for removal. " +
      "Dry-run (default) filters candidates by minAge/toolFilter to show what would be removed. " +
      "Set dryRun=false to remove them via compaction with auto-resume. " +
      "Accepts optional `keep` to preserve recent N messages.",
    parameters: contextPruneSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const isDryRun = params.dryRun !== false;
      const minAge = params.minAge ?? 5;
      const audit = analyzeSession(ctx);
      let candidates = audit.candidates.filter((c) => c.age >= minAge);
      if (params.toolFilter?.length) {
        candidates = candidates.filter((c) => c.toolName && params.toolFilter.includes(c.toolName));
      }

      // ── EXECUTION MODE (dryRun=false): Actually remove entries ────────
      if (!isDryRun) {
        try {
          // Schedule a resume timer before compacting — otherwise agent stalls
          try {
            const { scheduleTimer } = await import("../../../tools/timer/index.js");
            scheduleTimer(
              1500,
              "Context pruning done — continue your task",
              "compaction-resume",
            );
          } catch {
            // Non-fatal — timer unavailable, agent must type to resume
          }
          const options: CompactOptions = {};
          if (params?.keep != null) {
            options.customInstructions = `Keep the most recent ${params.keep} messages.`;
          }

          // Build result BEFORE ctx.compact() — compact disconnects the
          // agent, making any code after it (including return) dead code.
          const result = {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Prune executed** (dryRun=false): pi.compact() triggered`,
                  `  Before: ${audit.usage.percent.toFixed(1)}% context used (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
                  `  Candidates identified: ${candidates.length}`,
                  `  Keep recent: ${params?.keep ?? "auto"}`,
                  ``,
                  `Agent will resume after compaction completes.`,
                ].join("\n"),
              },
            ],
            details: {
              mode: "execute",
              triggered: true,
              beforeUsagePercent: audit.usage.percent,
              candidatesFound: candidates.length,
              keepMessages: params?.keep ?? "auto",
            },
          };

          setTimeout(() => {
            try {
              ctx.compact(options);
            } catch {
              // Non-fatal — agent disconnect
            }
          }, 0);

          return result;
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to prune: ${e.message}` }],
            details: { mode: "execute", error: e.message },
          };
        }
      }

      // ── DRY-RUN MODE (default) ──────────────────────────────────────
      const topCandidates = candidates.slice(0, 15);
      const lines: string[] = [];
      lines.push(`## Context Prune — Dry Run`);
      lines.push("\n**Dry-run mode** — set dryRun=false to actually remove these.");
      lines.push("Automatic rule-based pruning also runs on every LLM call.");
      lines.push(
        `\n**Context Usage:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
      );
      lines.push(
        `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
      );
      lines.push(
        `**Auto-pruned:** ${getCmState(ctx).pruningState.stats.totalPruned} messages (${getCmState(ctx).pruningState.stats.totalProcessed} total processed)`,
      );

      if (topCandidates.length === 0) {
        lines.push("\n✓ No prune candidates found (session is clean)");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            mode: "analyze",
            candidatesFound: 0,
            audit,
            stats: getCmState(ctx).pruningState.stats,
          },
        };
      }

      lines.push(`\n## Prune Candidates (${topCandidates.length} of ${candidates.length} shown)`);
      lines.push("\n" + formatPruneCandidates(topCandidates));
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          mode: "analyze",
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
    promptSnippet: "Full analysis of session context health and recommendations",
    description:
      "Get a comprehensive analysis of session context health with recommendations — use when optimizing context or debugging session issues. Returns usage stats, hygiene score, prune candidates, branching triggers.",
    parameters: contextAuditSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const includeRecs = params.includeRecommendations ?? true;
      const detail = params.detailLevel ?? "detailed";
      const audit = analyzeSession(ctx);
      const lines: string[] = [];
      lines.push("## Context Audit Report");
      lines.push("\n### Usage Statistics");
      lines.push(
        `- **Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K tokens)`,
      );
      lines.push(`- **Branch length:** ${audit.branchLength} entries`);
      lines.push(`- **Tree depth:** ${audit.treeDepth} total nodes`);
      lines.push(`- **Tags:** ${audit.tagCount}`);
      lines.push(`- **Summaries:** ${audit.summaryCount}`);
      lines.push(`- **Branches:** ${audit.branchCount}`);
      if (audit.oldestEntry)
        lines.push(
          `- **Oldest entry:** ${audit.oldestEntry.id.slice(0, 8)} (${audit.oldestEntry.age} turns ago)`,
        );

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

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { hygieneScore, audit },
      };
    },
  });

  // ── context_snapshot ──────────────────────────────────────────────
  pi.registerTool({
    name: "context_snapshot",
    label: "Context Snapshot",
    promptSnippet: "Quick health check of session context",
    description:
      "Quick health check on session context: usage %, hygiene score, prune candidates, top recommendation. " +
      "Use before other context management tools. Simpler than context_audit.",
    parameters: Type.Object({}),
    execute: async (
      _toolCallId: string,
      _params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const audit = analyzeSession(ctx);

      let hygieneScore = 1.0;
      if (audit.usage.percent > 80) hygieneScore -= 0.3;
      else if (audit.usage.percent > 60) hygieneScore -= 0.15;
      if (audit.tagCount === 0 && audit.branchLength > 10) hygieneScore -= 0.2;
      if (audit.candidates.length > 10) hygieneScore -= 0.15;
      if (audit.summaryCount === 0 && audit.branchLength > 20) hygieneScore -= 0.2;
      hygieneScore = Math.max(0, Math.min(1, hygieneScore));

      const scoreIcon = hygieneScore >= 0.8 ? "✓" : hygieneScore >= 0.5 ? "⚠" : "✗";
      const topRec = audit.recommendations
        .filter((r: any) => r.priority === "high" || r.priority === "medium")
        .slice(0, 1);

      const lines = [
        `**Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K)`,
        `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
        `**Hygiene:** ${scoreIcon} ${(hygieneScore * 100).toFixed(0)}%`,
        `**Prune candidates:** ${audit.candidates.length}`,
      ];
      if (topRec.length > 0) {
        lines.push(`**Top action:** ${topRec[0].action} — ${topRec[0].reason}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          usagePercent: audit.usage.percent,
          branchLength: audit.branchLength,
          tagCount: audit.tagCount,
          hygieneScore,
          pruneCandidates: audit.candidates.length,
          topRecommendation: topRec[0]?.action ?? null,
        },
      };
    },
  });

  // ── context_compact ──────────────────────────────────────────────
  pi.registerTool({
    name: "context_compact",
    label: "Compact Context",
    promptSnippet: "Trigger compaction to free up context space",
    description:
      "Remove obsolete/duplicate entries via compaction. " +
      "Accepts optional `keep` parameter to preserve recent N messages. " +
      "Auto-resumes after completion — freed space visible next turn.",
    parameters: Type.Object({
      keep: Type.Optional(
        Type.Number({
          description: "Number of most recent messages to preserve from pruning (default: auto)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      try {
        // CRITICAL: Must return tool result BEFORE ctx.compact().
        // ctx.compact() calls _disconnectFromAgent() + abort() in pi core,
        // which terminates the tool execution context. Any code after
        // ctx.compact() — including the return statement — is dead code.
        // Without this fix, the tool result is NEVER persisted to the
        // session file and NEVER seen by the agent, causing the agent to
        // hang on the [compaction] summary with no context for how it got
        // there.

        const audit = analyzeSession(ctx);
        const result = {
          content: [
            {
              type: "text" as const,
              text: [
                `**Compaction triggered** — agent will resume after compression.`,
                `  Before: ${audit.usage.percent.toFixed(1)}% used (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
                `  Keep recent: ${params?.keep ?? "auto"}`,
                ``,
                `On resume: the [compaction] summary shows what was preserved.`,
              ].join("\n"),
            },
          ],
          details: {
            compactionTriggered: true,
            beforeUsagePercent: audit.usage.percent,
            keep: params?.keep ?? "auto",
          },
        };

        // Schedule resume timer AFTER building result but BEFORE compacting
        try {
          const { scheduleTimer } = await import("../../../tools/timer/index.js");
          scheduleTimer(
            1500,
            "Context compaction done — continue your task",
            "compaction-resume",
          );
        } catch {
          // Non-fatal — timer unavailable, agent must type to resume
        }

        const options: CompactOptions = {};
        if (params?.keep != null) {
          options.customInstructions = `Keep the most recent ${params.keep} messages.`;
        }

        // CRITICAL: Use setTimeout to defer ctx.compact() so pi core can
        // fully process the tool result (persist to session, inject into
        // agent context) BEFORE the agent is disconnected.
        // ctx.compact() calls _disconnectFromAgent() which terminates the
        // tool execution context — any code after it is dead code.
        // queueMicrotask isn't safe here: the result Promise resolution
        // microtask queues are flushed before result processing completes.
        setTimeout(() => {
          try {
            ctx.compact(options);
          } catch {
            // Agent already disconnected — non-fatal
          }
        }, 0);

        return result;
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to compact: ${e.message}` }],
          details: { error: e.message },
        };
      }
    },
  });

  // ── context_archive ──────────────────────────────────────────────
  pi.registerTool({
    name: "context_archive",
    label: "Compress Context",
    promptSnippet: "Compress conversation range into a summary",
    description:
      "Compress a range of messages into a topic summary, freeing context space. " +
      "Original messages are preserved in session file (not deleted). " +
      "Auto-selects oldest ~20% when startIndex/endIndex omitted.",
    parameters: Type.Object({
      topic: Type.String({
        description: "Brief topic label (e.g., 'Auth Implementation', 'Bug Fix')",
      }),
      startIndex: Type.Optional(
        Type.Number({ description: "Index of first message to compress (auto if omitted)" }),
      ),
      endIndex: Type.Optional(
        Type.Number({ description: "Index of last message to compress (auto if omitted)" }),
      ),
      summary: Type.String({ description: "Comprehensive summary of what was accomplished" }),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      let { topic, startIndex, endIndex, summary } = params;

      // Auto-detect range if omitted
      if (startIndex === undefined || endIndex === undefined) {
        const audit = analyzeSession(ctx);
        const sessionLength = audit.branchLength;
        // Archive the oldest ~20% of entries (up to 100)
        const archiveCount = Math.min(Math.max(Math.floor(sessionLength * 0.2), 10), 100);
        startIndex = 0;
        endIndex = archiveCount - 1;
      }

      if (startIndex < 0 || endIndex < startIndex) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid range: startIndex must be >= 0 and endIndex must be >= startIndex",
            },
          ],
          details: { error: true },
        };
      }
      const sm = ctx.sessionManager;
      sm.appendCustomEntry("context_compression", {
        topic,
        startIndex,
        endIndex,
        summary,
        timestamp: Date.now(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Compressed ${endIndex - startIndex + 1} messages into summary: "${topic}"\n\nThe summary will be visible in context. Original messages are preserved in session file.`,
          },
        ],
        details: { compressed: endIndex - startIndex + 1, topic },
      };
    },
  });

  // ── context-stats Command ───────────────────────────────────────────
  pi.registerCommand("context-stats", {
    description: "Show context pruning statistics",
    handler: async (_args: string | undefined, ctx: any) => {
      const stats = getCmState(ctx).pruningState.stats;
      const rules = getCmState(ctx)
        .pruningState.rules.filter((r: any) => r.enabled)
        .map((r: any) => r.id);
      ctx.ui.notify(
        [
          "Context Pruning Stats:",
          `  Total pruned: ${stats.totalPruned}`,
          `  Total processed: ${stats.totalProcessed}`,
          `  Active rules: ${rules.join(", ") || "none"}`,
          `  Keep recent: ${getCmState(ctx).pruningState.keepRecentCount} messages`,
          `  Prune reasons: ${
            Object.entries(stats.pruneReasons)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ") || "none"
          }`,
        ].join("\n"),
        "info",
      );
    },
  });
}
