/**
 * context_log — View conversation history with milestones.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { log, isInternal } from "../shared.js";

export const contextLogSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max entries (default 50)" })),
  verbose: Type.Optional(Type.Boolean({ description: "Show all entries" })),
});

export function registerContextLog(pi: ExtensionAPI): void {
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
}
