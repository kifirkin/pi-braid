/**
 * context_tag — Create a named save point in conversation history.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveTarget, findByLabel, resolveDefaultTarget } from "../shared.js";

export const contextTagSchema = Type.Object({
  name: Type.String({ description: "Tag/milestone name" }),
  target: Type.Optional(Type.String({ description: "Entry ID or tag name (defaults to HEAD)" })),
});

export function registerContextTag(pi: ExtensionAPI): void {
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
}
