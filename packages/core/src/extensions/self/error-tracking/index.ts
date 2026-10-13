import { eventBus } from "../../../lib/events/event-bus.js";
import { nextId } from "../../../lib/utils/id.js";

/**
 * Error Capture Extension - Auto-catches and logs extension errors
 *
 * Intercepts extension errors via:
 * 1. tool_execution_end events with isError=true
 * 2. turn_end events with errored tools
 *
 * Logs to: braidDir()/errors/errors.jsonl (braid-paths ERROR_LOG_FILE; the
 * legacy ~/.pi/agent/errors/error-log.jsonl file is not written any more)
 *
 * Tools provided (consolidated to one tool with 4 actions):
 * - error action=list:   List recent errors with counts
 * - error action=get:    Get detailed error by ID
 * - error action=clear:  Mark an error as handled
 * - error action=stats:  Get error statistics by type/source
 */

import * as fs from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Types

interface ErrorEntry {
  id: string;
  timestamp: number;
  source: string; // extension name or tool name
  message: string;
  stack?: string;
  context?: Record<string, unknown>; // turn count, tool calls, etc.
  handled: boolean;
}

import { errorDir, errorsFilePath } from "../../../lib/config/braid-paths.js";
import { TURN_END } from "../../../lib/core/event-names.js";

const MAX_ERRORS = 100;

async function ensureErrorDir(): Promise<void> {
  await fs.mkdir(errorDir(), { recursive: true });
}

async function loadErrors(): Promise<ErrorEntry[]> {
  try {
    await ensureErrorDir();
    const data = await fs.readFile(errorsFilePath(), "utf-8");
    return data
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    // Absent, unreadable, or refused (no absolute braid root): a reader
    // degrades to an empty list; the writer below is the loud side.
    return [];
  }
}

async function saveError(entry: ErrorEntry): Promise<void> {
  await ensureErrorDir();
  await fs.appendFile(errorsFilePath(), JSON.stringify(entry) + "\n");

  // Prune if over limit
  const entries = await loadErrors();
  if (entries.length > MAX_ERRORS) {
    const pruned = entries.slice(-MAX_ERRORS);
    await fs.writeFile(errorsFilePath(), pruned.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

function generateErrorId(): string {
  return nextId("err");
}

// Error Capture Logic

/** Capture an error from any source */
async function captureError(
  source: string,
  message: string,
  stack?: string,
  context?: Record<string, unknown>,
): Promise<ErrorEntry> {
  const entry: ErrorEntry = {
    id: generateErrorId(),
    timestamp: Date.now(),
    source,
    message,
    stack,
    context,
    handled: false,
  };
  await saveError(entry);
  return entry;
}

const errorSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("list"), Type.Literal("get"), Type.Literal("clear"), Type.Literal("stats")],
    { description: "Action: list | get | clear | stats" },
  ),
  // list-only
  limit: Type.Optional(Type.Number({ default: 10, description: "Max errors to return (list)" })),
  source: Type.Optional(Type.String({ description: "Filter by source (list)" })),
  unhandledOnly: Type.Optional(
    Type.Boolean({ default: false, description: "Only show unhandled errors (list)" }),
  ),
  id: Type.Optional(Type.String({ description: "Error ID (get/clear)" })),
});

export default function errorCaptureExtension(pi: ExtensionAPI): void {
  // Subscribe to tool_error events from enforcement's tool_result handler
  eventBus.on("tool_error", (event) => {
    captureError(event.toolName, event.error, undefined, {
      turn: String(event.turn),
    });
  });

  // Capture tool execution errors from turn_end
  // NOTE: Empty tool names (from proxy hallucination, e.g. agent-zero/venice) are silently dropped
  // to avoid polluting the error store with proxy artifacts.
  pi.on(TURN_END, async (event) => {
    const results = event.toolResults || [];
    for (const result of results) {
      if (result.isError && result.toolName && result.toolName.trim()) {
        await captureError(result.toolName, `Tool failed: ${result.toolName}`, undefined, {
          turn: "current",
        });
        eventBus.emit({
          type: "tool_error",
          toolName: result.toolName,
          error: `Tool failed: ${result.toolName}`,
          turn: 0,
          timestamp: Date.now(),
        });
      }
    }
  });

  // Consolidated error tool with 4 actions (list/get/clear/stats)
  const errorTool = {
    name: "error",
    description:
      "Inspect, get details, clear, and aggregate captured extension errors. " +
      "Use action=list to see recent errors, action=get id=<id> for details, " +
      "action=clear id=<id> to mark as handled, action=stats for aggregation.",
    label: "Error",
    parameters: errorSchema,
    execute: async (_toolCallId: string, params: any) => {
      switch (params.action) {
        case "list": {
          const entries = await loadErrors();
          const limit = params.limit ?? 10;
          const source = params.source;
          const unhandledOnly = params.unhandledOnly ?? false;

          let filtered = entries;
          if (source) filtered = filtered.filter((e) => e.source.includes(source));
          if (unhandledOnly) filtered = filtered.filter((e) => !e.handled);

          const recent = filtered.slice(-limit).reverse();

          if (recent.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No errors captured." }],
              details: { count: 0, total: 0 },
            };
          }

          const lines = recent.map((e) => {
            const age = Math.round((Date.now() - e.timestamp) / 60000);
            const status = e.handled ? "[handled]" : "[NEW]";
            return `${status} ${e.id} [${e.source}] ${age}m ago: ${e.message.slice(0, 100)}`;
          });

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: { count: recent.length, total: filtered.length },
          };
        }
        case "get": {
          if (!params.id) {
            return {
              content: [{ type: "text" as const, text: "action=get requires id parameter" }],
              details: { error: "missing_id" },
            };
          }
          const entries = await loadErrors();
          const entry = entries.find((e) => e.id === params.id);

          if (!entry) {
            return {
              content: [{ type: "text" as const, text: `Error ${params.id} not found.` }],
              details: { found: false },
            };
          }

          const age = Math.round((Date.now() - entry.timestamp) / 60000);
          const text = [
            `Error: ${entry.id}`,
            `Source: ${entry.source}`,
            `Time: ${age}m ago`,
            `Status: ${entry.handled ? "handled" : "UNHANDLED"}`,
            `\nMessage: ${entry.message}`,
            entry.stack ? `\nStack:\n${entry.stack}` : "",
            entry.context ? `\nContext: ${JSON.stringify(entry.context)}` : "",
          ].join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: { found: true, ...entry },
          };
        }
        case "clear": {
          if (!params.id) {
            return {
              content: [{ type: "text" as const, text: "action=clear requires id parameter" }],
              details: { error: "missing_id" },
            };
          }
          const entries = await loadErrors();
          const idx = entries.findIndex((e) => e.id === params.id);

          if (idx === -1) {
            return {
              content: [{ type: "text" as const, text: `Error ${params.id} not found.` }],
              details: { found: false },
            };
          }

          entries[idx].handled = true;
          await fs.writeFile(
            errorsFilePath(),
            entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
          );

          return {
            content: [{ type: "text" as const, text: `Error ${params.id} marked as handled.` }],
            details: { found: true, id: params.id },
          };
        }
        case "stats": {
          const entries = await loadErrors();
          const bySource: Record<string, number> = {};
          const byType: Record<string, number> = {};

          let unhandled = 0;
          for (const e of entries) {
            bySource[e.source] = (bySource[e.source] || 0) + 1;
            const type = e.message.split(" ")[0] || "unknown";
            byType[type] = (byType[type] || 0) + 1;
            if (!e.handled) unhandled++;
          }

          const topSources = Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([s, c]) => `${s}: ${c}`)
            .join("\n");

          const text = [
            `Total errors: ${entries.length}`,
            `Unhandled: ${unhandled}`,
            `\nTop sources:`,
            topSources || "none",
          ].join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: { bySource, byType, unhandled, total: entries.length },
          };
        }
        default:
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown action: ${params.action}. Use: list, get, clear, stats.`,
              },
            ],
            details: { error: "unknown_action" },
          };
      }
    },
  };

  pi.registerTool(errorTool as Parameters<typeof pi.registerTool>[0]);
}
