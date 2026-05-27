/**
 * context_checkout — Navigate to any point in conversation history.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveTarget, getCmState } from "../shared.js";

export const contextCheckoutSchema = Type.Object({
  target: Type.String({ description: "Tag name or entry ID to navigate to" }),
  message: Type.String({ description: "Summary to carry forward" }),
  backupTag: Type.Optional(
    Type.String({ description: "Tag name for current position before checkout" }),
  ),
});

export function registerContextCheckout(pi: ExtensionAPI): void {
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
}
