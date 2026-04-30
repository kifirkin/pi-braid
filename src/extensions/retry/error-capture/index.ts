import { createLogger } from "../../../lib/logger.js";

const log = createLogger("error-capture");
/**
 * Error Capture Extension - Auto-catches and logs extension errors
 *
 * Intercepts extension errors via:
 * 1. tool_execution_end events with isError=true
 * 2. turn_end events with errored tools
 *
 * Logs to: ~/.pi/agent/errors/error-log.jsonl
 *
 * Tools provided:
 * - error_list: List recent errors with counts
 * - error_get: Get detailed error by ID
 * - error_clear: Clear an error after handling
 * - error_stats: Get error statistics by type/source
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

// Storage

const ERROR_DIR = path.join(os.homedir(), ".pi", "agent", "errors");
const ERROR_FILE = path.join(ERROR_DIR, "error-log.jsonl");
const MAX_ERRORS = 100;

async function ensureErrorDir(): Promise<void> {
  await fs.mkdir(ERROR_DIR, { recursive: true });
}

async function loadErrors(): Promise<ErrorEntry[]> {
  await ensureErrorDir();
  try {
    const data = await fs.readFile(ERROR_FILE, "utf-8");
    return data
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function saveError(entry: ErrorEntry): Promise<void> {
  await ensureErrorDir();
  await fs.appendFile(ERROR_FILE, JSON.stringify(entry) + "\n");

  // Prune if over limit
  const entries = await loadErrors();
  if (entries.length > MAX_ERRORS) {
    const pruned = entries.slice(-MAX_ERRORS);
    await fs.writeFile(ERROR_FILE, pruned.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

function generateErrorId(): string {
  return `err-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
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

// Schema

const errorListSchema = Type.Object({
  limit: Type.Optional(Type.Number({ default: 10, description: "Max errors to return" })),
  source: Type.Optional(Type.String({ description: "Filter by source (extension or tool name)" })),
  unhandledOnly: Type.Optional(
    Type.Boolean({ default: false, description: "Only show unhandled errors" }),
  ),
});

const errorGetSchema = Type.Object({
  id: Type.String({ description: "Error ID to retrieve" }),
});

const errorClearSchema = Type.Object({
  id: Type.String({ description: "Error ID to mark as handled" }),
});

const errorStatsSchema = Type.Object({});

// Extension

export default function errorCaptureExtension(pi: ExtensionAPI): void {
  // Capture tool execution errors from turn_end
  pi.on("turn_end", async (event) => {
    const results = event.toolResults || [];
    for (const result of results) {
      if (result.isError) {
        await captureError(result.toolName, `Tool failed: ${result.toolName}`, undefined, {
          turn: "current",
        });
      }
    }
  });

  // Error list tool
  const errorListTool: AgentTool<typeof errorListSchema> = {
    name: "error_list",
    label: "Error List",
    description: "List recent errors captured by the system",
    parameters: errorListSchema,
    execute: async (_toolCallId: string, params: any) => {
      const entries = await loadErrors();
      const limit = params.limit ?? 10;
      const source = params.source;
      const unhandledOnly = params.unhandledOnly ?? false;

      let filtered = entries;
      if (source) {
        filtered = filtered.filter((e) => e.source.includes(source));
      }
      if (unhandledOnly) {
        filtered = filtered.filter((e) => !e.handled);
      }

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
    },
  };

  pi.registerTool(errorListTool);

  // Error get tool
  const errorGetTool: AgentTool<typeof errorGetSchema> = {
    name: "error_get",
    label: "Error Get",
    description: "Get detailed error by ID",
    parameters: errorGetSchema,
    execute: async (_toolCallId: string, params: any) => {
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
    },
  };

  pi.registerTool(errorGetTool);

  // Error clear tool
  const errorClearTool: AgentTool<typeof errorClearSchema> = {
    name: "error_clear",
    label: "Error Clear",
    description: "Mark an error as handled",
    parameters: errorClearSchema,
    execute: async (_toolCallId: string, params: any) => {
      const entries = await loadErrors();
      const idx = entries.findIndex((e) => e.id === params.id);

      if (idx === -1) {
        return {
          content: [{ type: "text" as const, text: `Error ${params.id} not found.` }],
          details: { found: false },
        };
      }

      entries[idx].handled = true;
      await fs.writeFile(ERROR_FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      return {
        content: [{ type: "text" as const, text: `Error ${params.id} marked as handled.` }],
        details: { found: true, id: params.id },
      };
    },
  };

  pi.registerTool(errorClearTool);

  // Error stats tool
  const errorStatsTool: AgentTool<typeof errorStatsSchema> = {
    name: "error_stats",
    label: "Error Stats",
    description: "Get error statistics by source and type",
    parameters: errorStatsSchema,
    execute: async () => {
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
    },
  };

  pi.registerTool(errorStatsTool);
}
