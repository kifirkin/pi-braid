/**
 * Minimal pi extension — a single `hello` tool.
 *
 * Mirror the shape of a real braid contrib module (see
 * packages/contrib/sleep/index.ts): a default-exported factory that receives
 * the pi ExtensionAPI and registers tools. Parameters use TypeBox schemas so
 * pi validates the agent's arguments before execute runs.
 *
 * Load it by pointing pi at this file:
 *   { "extensions": ["file:/path/to/examples/minimal-extension/index.ts"] }
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function helloExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    promptSnippet: "Say hello to someone",
    description:
      "Say hello. Use when the agent wants to greet the user or acknowledge a " +
      "message with a friendly greeting.",
    parameters: Type.Object({
      who: Type.String({
        description: "Who or what to greet (defaults to 'world' if omitted)",
      }),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const who = params?.who ?? "world";
      return {
        content: [
          {
            type: "text" as const,
            text: `Hello, ${who}!`,
          },
        ],
        details: { who },
      };
    },
  } as ToolDefinition<any, any, any>);
}
