/**
 * context_navigate - Navigate session history, tag, and inspect.
 *
 * Consolidates context_log (view history), context_checkout (navigate to point),
 * and context_tag (create save point) into one tool with action param.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  resolveTarget,
  findByLabel,
  resolveDefaultTarget,
  getRecoveryFallback,
  getCmState,
  isInternal,
  recordNavigationAction,
} from "../shared.js";
import { getContextUsage } from "../../../../../lib/detection/context-tiers.js";
import { formatTokensK } from "../../../../../lib/detection/context-usage.js";

export const contextNavigateSchema = Type.Object({
  action: Type.String({
    enum: ["log", "checkout", "tag"],
    description:
      "log = view conversation history with milestones (like context_log). " +
      "checkout = navigate to a point in history (like context_checkout). " +
      "tag = create a named save point (like context_tag).",
  }),
  limit: Type.Optional(
    Type.Number({ description: "Max entries for log (default 50). Only used with action=log." }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Show all entries for log. Only used with action=log." }),
  ),
  // checkout params
  target: Type.Optional(
    Type.String({
      description: "Tag name or entry ID to navigate to. Required for action=checkout.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Summary to carry forward. Required for action=checkout.",
    }),
  ),
  backupTag: Type.Optional(
    Type.String({
      description:
        "Custom tag for current position before checkout; defaults to 'before-<target>'. action=checkout only.",
    }),
  ),
  // tag params
  name: Type.Optional(
    Type.String({
      description: "Tag/milestone name. Required for action=tag.",
    }),
  ),
});

function formatLog(ctx: any, sm: any, params: any): string | { error: true; text: string } {
  const verbose = params.verbose ?? false;
  const limit = params.limit ?? 50;
  const branch = sm.getBranch();
  const currentLeafId = sm.getLeafId();

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
    const marker = isHead ? "*" : role === "USER" ? "*" : "|";
    lines.push(`${marker} ${entry.id}${meta ? ` (${meta})` : ""} [${role}] ${body}`);
  });

  if (hiddenCount > 0) lines.push(`  :  ... (${hiddenCount} hidden) ...`);

  let usageStr = "unknown";
  try {
    const usage = getContextUsage(ctx);
    if (usage) {
      const pct = usage.percent?.toFixed(1) || "?";
      // tokens/contextWindow are required on the tool-exec ctx per the
      // session-manager contract; defaults never fire (preserved from the
      // original required-typed access).
      const tokens = usage.tokens ?? 0;
      const contextWindow = usage.contextWindow ?? 0;
      usageStr = `${pct}% (${formatTokensK(tokens)}/${formatTokensK(contextWindow)})`;
    }
  } catch {
    // Usage line is display-only context for navigation output; omitting it
    // beats failing the navigation itself.
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

  const hud = `[Context] Usage: ${usageStr} - Segment: ${steps} steps since '${nearestTag}'`;
  return hud + "\n" + (lines.join("\n") || "(empty)");
}

export function registerContextNavigate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_navigate",
    label: "Context Navigate",
    promptSnippet: "View history, navigate to a point, or create a save point",
    description:
      "Navigate session history. " +
      "Pipeline: tag your position before archival — use action=tag to create a save point, " +
      "then call context_compress(action='archive') to compress older messages. " +
      "action=log: view conversation history with milestones (like context_log). " +
      "action=checkout: navigate to any point in history. Auto-tags the current position as 'before-<target>' and captures recent context into the branch summary. " +
      "Provide a `message` describing what you're going to do at the target. " +
      "action=tag: create a named save point (like context_tag). " +
      "When to use: tag before any major operation (starting complex work, before a risky edit). " +
      "Log when you feel lost in history. Checkout to explore a leaf branch, then checkout back to resume.",
    parameters: contextNavigateSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const action = params.action;
      const sm = ctx.sessionManager;

      if (action === "log") {
        const result = formatLog(ctx, sm, params);
        if (typeof result === "object" && "error" in result) {
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: { action, error: true },
          };
        }
        // Only a real log render counts as navigation adoption (option B §8).
        recordNavigationAction(ctx, "log");
        return {
          content: [{ type: "text" as const, text: result }],
          details: {
            action,
            nextStep: result.includes("(empty)")
              ? undefined
              : {
                  tool: "context_navigate",
                  action: "checkout",
                  note: "pick a target from log output",
                },
          },
        };
      }

      if (action === "checkout") {
        if (!params.target || !params.message) {
          return {
            content: [
              {
                type: "text" as const,
                text: "target and message are required for action=checkout",
              },
            ],
            details: { action, error: "missing required params" },
          };
        }
        const targetId = resolveTarget(ctx, params.target);
        const currentLeaf = sm.getLeafId();
        // When resolveTarget returns null, propose a recovery fallback
        // instead of dead-ending: an unresolved target must leave the agent a
        // path forward (most-recent tag or session root), not a
        // "Could not resolve target" error and an aborted turn.
        if (!targetId) {
          const fallback = getRecoveryFallback(ctx, params.target);
          if (fallback) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Target '${params.target}' not found in this session.\n\n` +
                    `Recovery fallback available: '${fallback.label}' (${fallback.id}, ` +
                    `reason: ${fallback.reason}).\n\n` +
                    `If this is acceptable, run:\n` +
                    `  context_navigate(action="checkout", target="${fallback.id}", message="...")\n\n` +
                    `If not, run context_navigate(action="log") to inspect the session tree.`,
                },
              ],
              details: {
                action,
                error: "target_not_found",
                recovery: fallback,
                requested: params.target,
              },
            };
          }
          // No fallback: empty session, nothing to fall back to.
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Target '${params.target}' not found and the session is empty. ` +
                  `No recovery fallback available. ` +
                  `Run context_navigate(action="log") once the session has content.`,
              },
            ],
            details: { action, error: "target_not_found", recovery: null },
          };
        }
        if (currentLeaf === targetId) {
          return {
            content: [{ type: "text" as const, text: `Already at ${targetId}` }],
            details: { action, noop: true },
          };
        }
        // Auto-tag current position if no backupTag provided (ensures a return point)
        const tagName = params.backupTag || `before-${params.target}`;
        if (currentLeaf) {
          // Only tag if not already tagged with this name
          const existingTag = sm.getLabel(currentLeaf);
          if (!existingTag) {
            sm.appendLabelChange(currentLeaf, tagName);
          }
        }

        // Smart auto-capture: select the most useful content from the current branch
        // Priority: finalize results > last user message > last assistant message
        const branch = sm.getBranch();
        const messageEntries = branch.filter((e: any) => e.type === "message" && e.message?.role);

        // 1. Most recent finalize tool result (highest value — summarizes what was accomplished)
        const finalizeResult = [...messageEntries]
          .reverse()
          .find((e: any) => e.message.role === "toolResult" && e.message.toolName === "finalize");
        const finalizeSummary = finalizeResult
          ? typeof finalizeResult.message.content === "string"
            ? finalizeResult.message.content.slice(0, 200).replace(/\n/g, " ")
            : ""
          : null;

        // 2. Last user message (task context — what was being worked on)
        const lastUserMessage = [...messageEntries]
          .reverse()
          .find((e: any) => e.message.role === "user");
        const userSummary = lastUserMessage
          ? typeof lastUserMessage.message.content === "string"
            ? lastUserMessage.message.content.slice(0, 150).replace(/\n/g, " ")
            : "(non-text user message)"
          : null;

        // 3. Last assistant message (current thinking — what was being considered)
        const lastAssistantMessage = [...messageEntries]
          .reverse()
          .find((e: any) => e.message.role === "assistant");
        const assistantSummary = lastAssistantMessage
          ? typeof lastAssistantMessage.message.content === "string"
            ? lastAssistantMessage.message.content.slice(0, 150).replace(/\n/g, " ")
            : "(non-text assistant message)"
          : null;

        const contextParts: string[] = [];
        if (finalizeSummary) contextParts.push(`[finalize] ${finalizeSummary}`);
        if (userSummary) contextParts.push(`[task] ${userSummary}`);
        if (assistantSummary) contextParts.push(`[thinking] ${assistantSummary}`);

        const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
        const origin = currentLabel ? `tag: ${currentLabel}` : currentLeaf || "unknown";
        const enriched = [
          `Checkout from: ${origin}`,
          ...(contextParts.length > 0 ? contextParts : ["(no recent context)"]),
          `Follow-up: ${params.message}`,
        ].join("\n");
        const newId = sm.branchWithSummary(targetId, enriched);
        getCmState(ctx).checkoutParams = {
          target: params.target,
          newId,
          targetId,
          backupTag: params.backupTag,
        };
        // Abort only after a successful branchWithSummary: aborting on a
        // failed checkout kills the turn and leaves the session
        // half-checked-out (a corrupt session then fails the next LLM call).
        ctx.abort();
        // The checkout actually committed (branchWithSummary succeeded), so
        // count it as navigation adoption (option B §8).
        recordNavigationAction(ctx, "checkout");
        return {
          content: [{ type: "text" as const, text: `Checking out ${params.target}...` }],
          details: {
            action,
            checkout: true,
            newId,
            tagName,
            origin,
            nextStep: { tool: "context_inspect", detail: "quick" },
          },
        };
      }

      if (action === "tag") {
        if (!params.name) {
          return {
            content: [{ type: "text" as const, text: "name is required for action=tag" }],
            details: { action, error: "missing required params" },
          };
        }
        let targetId = params.target ? resolveTarget(ctx, params.target) : null;
        if (!targetId) targetId = resolveDefaultTarget(ctx);
        if (!targetId) {
          return {
            content: [
              { type: "text" as const, text: "No entry to tag. Conversation may be empty." },
            ],
            details: { action },
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
            details: { action, error: true, existingId: existing },
          };
        }
        sm.appendLabelChange(targetId, params.name);
        // The tag was written — count it as navigation adoption (option B §8).
        recordNavigationAction(ctx, "tag");
        return {
          content: [{ type: "text" as const, text: `Created tag '${params.name}' at ${targetId}` }],
          details: {
            action,
            tag: params.name,
            targetId,
            nextStep: { tool: "context_compress", action: "archive", beforeTag: params.name },
          },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Unknown action. Use log, checkout, or tag." }],
        details: { action, error: true },
      };
    },
  });
}
