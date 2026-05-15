import { createLogger } from "../../../lib/logger.js";

const log = createLogger("session-recall");
/**
 * Session Recall Extension
 *
 * Two tools for searching and querying past pi sessions:
 *
 * Tools:
 * 1. session_search - Find relevant past sessions by keywords.
 *    Use when the user mentions something from a previous session.
 *
 * 2. session_query - Deep dive into a specific session.
 *    Use after session_search to get detailed information.
 *
 * Storage: ~/.pi/agent/sessions/ (auto-discovered)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { callLlm } from "../../../lib/llm-call.js";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { SESSION_RECALL_FILE, BRAID } from "../../../lib/braid-paths.js";

// Config

interface SessionRecallConfig {
  queryModel?: { provider: string; id: string };
}

function getConfigPath(): string {
  return SESSION_RECALL_FILE;
}

function loadConfig(): SessionRecallConfig {
  try {
    const data = readFileSync(getConfigPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
  /* Non-fatal: prior session read failed */
}

// Schemas

const sessionSearchSchema = Type.Object({
  query: Type.String({
    description: "Search keywords. Multiple words searched as phrase. Use simple, specific terms.",
  }),
});

const sessionQuerySchema = Type.Object({
  sessionPath: Type.String({ description: "Full path to .jsonl session file" }),
  question: Type.String({ description: "What to ask about the session" }),
});

// Helpers

function getSessionsDir(): string {
  return join(BRAID, "sessions");
}

function projectFromPath(sessionPath: string): string {
  const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
  if (!match || !match[1]) return "~";
  let encoded = match[1].slice(2, -2);
  const homeEncoded = homedir()
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  if (encoded.startsWith(homeEncoded + "-")) {
    encoded = encoded.slice(homeEncoded.length + 1);
  } else if (encoded === homeEncoded) {
    return "~";
  }
  return encoded.replace(/-/g, "/") || "~";
}

function dateFromPath(sessionPath: string): string {
  const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T/);
  return match?.[1] ?? "unknown";
}

function extractMessageText(jsonLine: string): { role: string; text: string } | null {
  try {
    const entry = JSON.parse(jsonLine);
    if (entry.type !== "message") return null;
    const msg = entry.message as {
      role: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    const role = msg.role;
    const texts = (msg.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    if (!texts) return null;
    return { role, text: texts };
  } catch {
    return null;
  }
  /* Non-fatal: prior session read failed */
}

function snippetAround(text: string, keyword: string, radius = 100): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end) + suffix;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPETS_PER_SESSION = 3;

// Search

type SearchBackend = "rg" | "grep" | "node";
import { getExtensionState } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

function getRecallState(ctx?: ExtensionContext): { cachedBackend: SearchBackend | undefined } {
  if (ctx) return getExtensionState(ctx, "session-recall", () => ({ cachedBackend: undefined }));
  return _default;
}
const _default: { cachedBackend: SearchBackend | undefined } = { cachedBackend: undefined };

function getSearchBackend(): SearchBackend {
  const s = getRecallState();
  if (s.cachedBackend !== undefined) return s.cachedBackend;
  for (const cmd of ["rg", "grep"] as const) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
      s.cachedBackend = cmd;
      return cmd;
    } catch {
      /* try next */
    }
  }
  s.cachedBackend = "node";
  return "node";
}

function walkJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) results.push(full);
    }
  }
  walk(dir);
  return results;
}

interface FileMatchCount {
  path: string;
  count: number;
}

async function searchFiles(
  query: string,
  sessionsDir: string,
  timeout = 10000,
): Promise<FileMatchCount[]> {
  const backend = getSearchBackend();

  if (backend === "rg") {
    try {
      const output = execFileSync("rg", ["-i", "-c", "-F", query, sessionsDir], {
        encoding: "utf-8",
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return parseCountOutput(output);
    } catch (err: any) {
      if (err.status === 1) return [];
    }
  }

  if (backend === "grep") {
    try {
      const output = execFileSync(
        "grep",
        ["-r", "-i", "-c", "-F", "--include=*.jsonl", query, sessionsDir],
        { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] },
      );
      return parseCountOutput(output);
    } catch (err: any) {
      if (err.status === 1) return [];
    }
  }

  // Node fallback
  return nodeSearchFiles(query, sessionsDir);
}

function parseCountOutput(output: string): FileMatchCount[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const lastColon = line.lastIndexOf(":");
      return { path: line.slice(0, lastColon), count: parseInt(line.slice(lastColon + 1), 10) };
    });
}

async function nodeSearchFiles(query: string, sessionsDir: string): Promise<FileMatchCount[]> {
  const files = walkJsonlFiles(sessionsDir);
  const results: FileMatchCount[] = [];
  const lowerQuery = query.toLowerCase();

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      let count = 0;
      for (const line of content.split("\n")) {
        if (line.toLowerCase().includes(lowerQuery)) count++;
      }
      if (count > 0) results.push({ path: filePath, count });
    } catch {
      /* skip bad files */
    }
    /* Non-fatal: session restore failed */
  }

  return results;
}

async function searchLines(query: string, filePath: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.toLowerCase().includes(lowerQuery)) {
        results.push(line);
        if (results.length >= limit) break;
      }
    }
  } catch {
    /* skip */
  }

  return results;
}

// Session Loading (for query)

async function loadSessionMessages(
  sessionPath: string,
): Promise<Array<{ role: string; content: string }>> {
  const messages: Array<{ role: string; content: string }> = [];

  try {
    const content = await readFile(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const msg = extractMessageText(line);
      if (msg) messages.push({ role: msg.role, content: msg.text });
    }
  } catch {
    /* skip */
  }

  return messages;
}

function serializeSession(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

// Extension

const QUERY_SYSTEM_PROMPT = `You are analyzing a past pi coding assistant conversation.
Answer the user's question based on the conversation transcript.
Be specific and reference relevant parts of the conversation.
If the conversation doesn't contain enough information, say so.`;

export default function sessionRecallExtension(pi: ExtensionAPI) {
  // Track the current model for use in tools (extension tools don't receive ctx via _ctx)
  let currentModel: Model<any> | undefined;
  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  // ── session_search ────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    promptSnippet: "Search past sessions by keywords",
    description:
      "Search past sessions by keywords using plain-text grep — use before querying a specific session to find relevant history. Returns matching sessions with snippets.",
    parameters: sessionSearchSchema,
    execute: async (
      _toolCallId,
      params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ): Promise<any> => {
      const sessionsDir = getSessionsDir();

      if (!existsSync(sessionsDir)) {
        return {
          content: [{ type: "text" as const, text: "No sessions directory found." }],
          details: { error: true, matchCount: 0 },
        };
      }

      const allMatches = await searchFiles(params.query, sessionsDir);

      if (allMatches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No sessions found matching "${params.query}". Try broader terms (fewer words) -- search is literal grep, not semantic.`,
            },
          ],
          details: { matchCount: 0 },
        };
      }

      const fileMatches = allMatches
        .sort((a, b) => b.count - a.count || b.path.localeCompare(a.path))
        .slice(0, MAX_SEARCH_RESULTS);

      const results: string[] = [];

      for (const { path: filePath, count } of fileMatches) {
        const project = projectFromPath(filePath);
        const date = dateFromPath(filePath);
        const matchLines = await searchLines(params.query, filePath, MAX_SNIPPETS_PER_SESSION);

        const snippets: string[] = [];
        for (const line of matchLines) {
          const msg = extractMessageText(line);
          if (!msg) continue;
          const snippet = snippetAround(msg.text, params.query);
          snippets.push(`  [${msg.role}] ${snippet}`);
        }

        if (snippets.length === 0) continue;

        results.push(
          `**${date}** · \`${project}\` · ${count} match${count > 1 ? "es" : ""}\n` +
            `Session: \`${filePath}\`\n` +
            snippets.join("\n"),
        );
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No readable matches found for "${params.query}". Try shorter/more general keywords -- this is literal grep, not AI search.`,
            },
          ],
          details: { matchCount: 0 },
        };
      }

      const output =
        `Found ${results.length} session${results.length > 1 ? "s" : ""} matching "${params.query}":\n\n` +
        results.join("\n\n---\n\n");

      return {
        content: [{ type: "text" as const, text: output }],
        details: { matchCount: results.length, query: params.query },
      };
    },
  });

  // ── session_query ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_query",
    label: "Session Query",
    promptSnippet: "Analyze a specific session file in detail",
    description:
      "Analyze a specific session file in detail — use after session_search to examine a matching session's content and decisions.",
    parameters: sessionQuerySchema,
    execute: async (
      _toolCallId,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      if (!params.sessionPath.endsWith(".jsonl")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Invalid session path (expected .jsonl): ${params.sessionPath}`,
            },
          ],
          details: { error: true },
        };
      }

      if (!existsSync(params.sessionPath)) {
        return {
          content: [
            { type: "text" as const, text: `Error: Session file not found: ${params.sessionPath}` },
          ],
          details: { error: true },
        };
      }

      const messages = await loadSessionMessages(params.sessionPath);

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Session is empty - no messages found." }],
          details: { empty: true },
        };
      }

      // Get model from ctx (runtime) with fallback to cached model_select event
      const model = ctx?.model ?? currentModel;
      const contextWindow = model?.contextWindow ?? 200000;
      const tokenBudget = Math.floor(contextWindow * 0.8);

      // Serialize
      const fullText = serializeSession(messages);
      const fullTokens = estimateTokens(fullText);

      let conversationText = fullText;
      let wasWindowed = false;

      if (fullTokens > tokenBudget) {
        // Simple windowing: take first + last portions
        const lines = messages;
        const keep = Math.floor(tokenBudget / 100); // rough chars per message
        const startCount = Math.min(5, Math.floor(keep / 2));
        const endCount = Math.min(5, keep - startCount);

        if (lines.length > startCount + endCount) {
          const start = lines.slice(0, startCount);
          const end = lines.slice(-endCount);
          const omitted = lines.length - startCount - endCount;
          conversationText =
            start.map((m) => `[${m.role}]\n${m.content}`).join("\n\n") +
            `\n\n[... ${omitted} messages omitted ...]\n\n` +
            end.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
          wasWindowed = true;
        }
      }

      const contextNote = wasWindowed
        ? "\n\n**Note:** Large session windowed to relevant sections."
        : "";

      const userMessage = `## Session Conversation${contextNote}\n\n${conversationText}\n\n## Question\n\n${params.question}`;

      try {
        const apiKey = ctx?.modelRegistry
          ? await ctx.modelRegistry.getApiKeyForProvider(model.provider)
          : "";

        const llmResult = await callLlm(model, apiKey, QUERY_SYSTEM_PROMPT, userMessage, {
          signal: _signal,
        });

        if ("error" in llmResult) {
          return {
            content: [{ type: "text" as const, text: `Query failed: ${llmResult.error}` }],
            details: { error: true },
          };
        }

        const answer = llmResult.text;

        if (!answer) {
          return {
            content: [{ type: "text" as const, text: "LLM returned empty response." }],
            details: { error: true },
          };
        }

        const windowNote = wasWindowed ? " (windowed)" : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `**Query:** ${params.question}\n\n---\n\n${answer}\n\n*Answered by ${model.id} (${model.provider})${windowNote}*`,
            },
          ],
          details: {
            sessionPath: params.sessionPath,
            question: params.question,
            messageCount: messages.length,
            wasWindowed,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error querying session: ${err}` }],
          details: { error: true },
        };
      }
    },
  });
  // ── R6: Mid-Task Auto Recall ────────────────────────────────────────
  // Auto-search past sessions at natural breakpoints during a task.
  // Fires once per session (on first user message processed) to give
  // the agent relevant prior context without explicit recall commands.
  let midTaskRecallDone = false;

  pi.on("turn_end" as never, async (_event: unknown, ctx: any) => {
    if (midTaskRecallDone) return;
    midTaskRecallDone = true;

    // Extract context: the tools used so far tell us what kind of task this is
    const toolNames = pi.getActiveTools().slice(0, 5).join(" ");
    if (!toolNames) return;

    // Quick search for broad terms that might match past sessions
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) return;

    try {
      const results = await searchFiles(toolNames.slice(0, 60), sessionsDir);
      if (results.length > 0 && results[0].count >= 2) {
        // Inject as a quiet whisper with display:false
        sendTrackedMessage(
          pi,
          {
            customType: "memory",
            display: true,
            content: [
              {
                type: "text" as const,
                text: `[recall] Past session found: "${basename(results[0].path)}" (${results[0].count} matches)`,
              },
            ],
          },
          { deliverAs: "steer", triggerTurn: false },
          { type: "memory", source: "session-recall" },
        );
      }
    } catch {
      // Non-fatal: recall failed, continue without
    }
  });
}
