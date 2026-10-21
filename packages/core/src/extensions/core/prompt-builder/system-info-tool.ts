/**
 * System Info Tool — returns the runtime environment on demand.
 *
 * Extracts the Instance section (Agent version, pi-core version, paths,
 * OS, session stats, extensions, other instances) from the system prompt
 * into a read-on-demand tool. The prompt keeps only the compact one-line
 * orientation (build + install root, model, PID, session, resource counts)
 * at the bottom; the full Instance block lives here.
 *
 * This saves ~60-100+ tokens per prompt turn while keeping the data
 * available when the agent actually needs it.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gatherInstanceData, renderInstance } from "./instance-composition.js";

const systemInfoSchema = Type.Object({
  detail: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("compact")], {
      description:
        '"full" (default) returns the complete Instance block with extensions and other instances. ' +
        '"compact" returns only the essentials (version, core, cwd, session).',
      default: "full",
    }),
  ),
});

export function createSystemInfoTool(pi: ExtensionAPI) {
  return {
    name: "system_info" as const,
    label: "System Info",
    promptSnippet: "Show the runtime environment: versions, paths, session stats, extensions",
    description:
      "Show the runtime environment: versions, paths, OS, session stats, extensions, other Pi instances; " +
      "detail='compact' for essentials.",
    parameters: systemInfoSchema,

    execute: async (
      _toolCallId: string,
      params: { detail?: "full" | "compact" },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<any> => {
      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "system_info requires a valid context." }],
          details: { error: "no_context" },
        };
      }

      const data = await gatherInstanceData(pi, ctx, {
        skillCount: 0,
        skillDirs: [],
        skills: [],
        memoryCount: 0,
      });

      const raw = await renderInstance(data);

      if (params.detail === "compact") {
        // Compact mode: identity, paths, session, environment lines
        const lines = raw.split("\n");
        const compact = lines.filter((l) => {
          return (
            l.startsWith("Agent:") ||
            l.startsWith("Core:") ||
            l.startsWith("Cwd:") ||
            l.startsWith("Settings:") ||
            l.startsWith("Session:") ||
            l.startsWith("OS:") ||
            l.startsWith("Started:") ||
            l.startsWith("PID:")
          );
        });
        return {
          content: [{ type: "text" as const, text: compact.join("\n") }],
        };
      }

      return {
        content: [{ type: "text" as const, text: raw }],
      };
    },
  };
}
