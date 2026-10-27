import { getContextUsage } from "../../../lib/detection/context-tiers.js";
import { formatTokensK } from "../../../lib/detection/context-usage.js";
import {
  describeUsage,
  measureLiveUsage,
  tokenArms,
  resolveWindow,
} from "../../../lib/detection/context-usage.js";
import { CONTEXT_COMPACT_REFUSE_PERCENT } from "../../../lib/detection/context-thresholds.js";
import { isInternal } from "./handlers/shared.js";

/**
 * Session analysis utilities for context-manager.
 * Pure functions - no module-level mutable state.
 */

export interface PruneCandidate {
  id: string;
  type: string;
  age: number;
  reason: string;
  score: number; // Higher = more candidates for pruning
  toolName?: string;
  content?: string;
}

export interface AuditResult {
  usage: { percent: number; tokens: number; contextWindow: number };
  /** How the usage number was produced (live working set vs fallback). */
  usageSource: string;
  /** The short provenance word for the number: measured or estimated. */
  usageSourceKind: "measured" | "estimated" | "unavailable";
  /** Whole-branch token sum - labeled "not sent" wherever displayed. */
  branchTokens: number;
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

// isInternal comes from ./handlers/shared.js — the canonical list shared
// with context-navigate.ts; keep one list to avoid drift.

function findNearestTag(ctx: any, entryId: string): { label: string; distance: number } {
  const sm = ctx.sessionManager;
  const branch = sm.getBranch();
  const entryIndex = new Map<string, number>();
  branch.forEach((e: any, i: number) => entryIndex.set(e.id, i));

  const targetIndex = entryIndex.get(entryId) ?? -1;
  if (targetIndex === -1) return { label: "none", distance: 999 };

  let nearestLabel = "none";
  let nearestDistance = 999;

  // Walk the branch (the live path), not getTree(): pi-core returns root
  // nodes only there, which hid every label from this scan.
  for (const entry of branch) {
    const label = sm.getLabel(entry.id);
    if (label) {
      const idx = entryIndex.get(entry.id);
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

export function analyzeSession(ctx: any): AuditResult {
  const sm = ctx.sessionManager;
  const branch = sm.getBranch();
  const tree = sm.getTree();

  let usage = { percent: 0, tokens: 0, contextWindow: 0 };
  let usageSource = "unavailable";
  let usageSourceKind: "measured" | "estimated" | "unavailable" = "unavailable";
  let branchTokens = 0;
  try {
    const live = measureLiveUsage(ctx);
    if (live) {
      usage = {
        percent: live.percent,
        tokens: live.tokens,
        contextWindow: live.contextWindow,
      };
      usageSource = `session tree, ${live.windowSource} window, ${describeUsage(live)}`;
      usageSourceKind = live.source;
      branchTokens = live.branchTokens;
    } else {
      // No session tree available - fall back to the duck-typed accessor,
      // keeping the resolver-derived window when the accessor has none.
      const window = resolveWindow(ctx?.model?.contextWindow);
      const ctxUsage = getContextUsage(ctx);
      usage = {
        percent: ctxUsage?.percent ?? 0,
        tokens: ctxUsage?.tokens ?? 0,
        contextWindow: ctxUsage?.contextWindow ?? window.contextWindow,
      };
      usageSource = "ctx.getContextUsage fallback";
      usageSourceKind = "estimated";
      branchTokens = usage.tokens;
    }
  } catch {
    /* non-fatal: neither source available */
  }

  let tagCount = 0;
  let summaryCount = 0;
  const branchIds = new Set<string>();

  // Count over the BRANCH (the live path), not getTree(): pi-core's
  // SessionManager.getTree() returns root nodes only, so a tree walk sees one
  // node for a linear session and every tag/summary on the path read as 0.
  // Labels attach to branch entry ids via sm.getLabel; summaries are
  // compaction entries, branch summaries, and context_compression archive
  // records (the archive action's summary entry).
  for (const entry of branch) {
    const label = sm.getLabel(entry.id);
    if (label) tagCount++;
    if (
      entry.type === "branch_summary" ||
      entry.type === "compaction" ||
      (entry.type === "custom" && entry.customType === "context_compression")
    ) {
      summaryCount++;
    }
    branchIds.add(entry.id);
  }

  const entryIndex = new Map<string, number>();
  branch.forEach((e: any, i: number) => entryIndex.set(e.id, i));

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
        const toolResult = msg as {
          toolName?: string;
          details?: Record<string, unknown>;
          content?: Array<{ text?: string }>;
        };
        const toolName = toolResult.toolName;

        // Internal tools are low value
        if (isInternal(String(toolName))) {
          score += 0.3;
          reason = "Internal tool result (low semantic value)";
        }

        // bash/read without file changes in result are often obsolete
        if (["bash", "read", "grep"].includes(toolName ?? "")) {
          const details = toolResult.details;
          const hasOutput =
            (details as Record<string, unknown>)?.stdout ||
            (details as Record<string, unknown>)?.content;
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
          content: String(
            (toolResult as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "",
          ).slice(0, 100),
        });
      } else if (msg.role === "assistant") {
        // Assistant messages with only tool calls (no text)
        const hasText = msg.content?.some(
          (c: { type?: string; text?: string }) => c.type === "text" && (c.text?.length ?? 0) > 50,
        );
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

  candidates.sort((a, b) => b.score - a.score);

  // Generate recommendations
  const recommendations: AuditResult["recommendations"] = [];

  // High usage warning — token arms are fractions of the resolved window
  // (tokenArms): the percent tiers are unreachable on very large or
  // configured windows, so the derived token ladder backs them up:
  // checkpoint advice at act (min(0.60W, 130k)), prune/summarize at backstop (0.90W).
  const arms = tokenArms(ctx?.model?.contextWindow);
  if (usage.percent > 80 || usage.tokens >= arms.backstop) {
    recommendations.push({
      priority: "high",
      action: "Prune or summarize before continuing",
      reason:
        usage.tokens >= arms.backstop
          ? `Context at ~${formatTokensK(usage.tokens)} tokens - large working set`
          : `Context at ${usage.percent.toFixed(1)}% - approaching limit`,
    });
  } else if (usage.percent > 60 || usage.tokens >= arms.act) {
    recommendations.push({
      priority: "medium",
      action: "Consider creating a checkpoint",
      reason:
        usage.tokens >= arms.act
          ? `Context at ~${formatTokensK(usage.tokens)} tokens - tag before growing further`
          : `Context at ${usage.percent.toFixed(1)}% - moderate usage`,
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
  // Token arm: the 70% percent trigger is unreachable on large or configured
  // windows; the escalate band (0.85W) carries the same suggestion there.
  if (usage.percent > CONTEXT_COMPACT_REFUSE_PERCENT || usage.tokens >= arms.escalate) {
    branchingTriggers.push({
      reason: "High context usage",
      threshold:
        usage.tokens >= arms.escalate
          ? `> ${formatTokensK(arms.escalate)} tokens`
          : `> ${CONTEXT_COMPACT_REFUSE_PERCENT}%`,
      current:
        usage.tokens >= arms.escalate
          ? `~${formatTokensK(usage.tokens)} tokens`
          : `${usage.percent.toFixed(1)}%`,
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
    usageSource,
    usageSourceKind,
    branchTokens,
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

export function formatPruneCandidates(candidates: PruneCandidate[], limit = 10): string {
  const lines: string[] = [];
  const shown = candidates.slice(0, limit);

  for (const c of shown) {
    const scoreBar =
      "█".repeat(Math.round(c.score * 10)) + "░".repeat(10 - Math.round(c.score * 10));
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
