import { createLogger } from "../../../lib/core/logger.js";
import { safeSessionManager } from "../../../lib/state/extension-state.js";

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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { callLlm } from "../../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../../lib/ai/model-resolver.js";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { asyncExists } from "../../../lib/utils/async-fs.js";
import { homedir } from "node:os";
import { AGENT } from "../../../lib/config/braid-paths.js";

// Config





// ── Default config (file loading was dead code - removed) ──

// Schemas

// Consolidated session schema (was sessionSearchSchema + sessionQuerySchema).
// action=search: keyword search across past sessions (grep-based, no LLM)
// action=query:  LLM-driven analysis of a specific session file
const sessionSchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("query")], {
    description: "Action: search | query",
  }),
  // search-only
  query: Type.Optional(
    Type.String({
      description: "Search keywords. Multiple words searched as phrase. Use simple, specific terms. (action=search)",
    }),
  ),
  // query-only
  sessionPath: Type.Optional(
    Type.String({ description: "Full path to .jsonl session file (action=query)" }),
  ),
  question: Type.Optional(
    Type.String({ description: "What to ask about the session (action=query)" }),
  ),
});

// Helpers

function getSessionsDir(): string {
  return join(AGENT, "sessions");
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
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { TURN_END } from "../../../lib/core/event-names.js";

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

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) results.push(full);
    }
  }
  await walk(dir);
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
  const files = await walkJsonlFiles(sessionsDir);
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

  // Consolidated session tool (was session_search + session_query)
  pi.registerTool({
    name: "session",
    label: "Session",
    promptSnippet: "Search past sessions or query a specific session",
    description:
      "Access past session history. " +
      "Use action=search with query to find sessions matching keywords (plain-text grep, no LLM). " +
      "Use action=query with sessionPath + question to analyze a specific session (LLM-driven).",
    parameters: sessionSchema,
    execute: async (
      _toolCallId,
      params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ): Promise<any> => {
      try {
        switch (params?.action) {
          case "search": {
            if (!params.query) {
              return {
                content: [{ type: "text" as const, text: "action=search requires 'query' parameter" }],
                details: { error: true, action: "search" },
              };
            }
            const sessionsDir = getSessionsDir();
            if (!(await asyncExists(sessionsDir))) {
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
          }
          case "query": {
            if (!params.sessionPath || !params.question) {
              return {
                content: [{ type: "text" as const, text: "action=query requires 'sessionPath' and 'question'" }],
                details: { error: true, action: "query" },
              };
            }
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
            if (!(await asyncExists(params.sessionPath))) {
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
            const ctx = _ctx; // eslint-disable-line @typescript-eslint/no-unused-vars
            // Get model from ctx (runtime) with fallback to cached model_select event
            const baseModel = resolveUtilityModel(ctx) ?? ctx?.model ?? currentModel;
            const model = baseModel;
            const contextWindow = model?.contextWindow ?? 200000;
            const tokenBudget = Math.floor(contextWindow * 0.8);
            const fullText = serializeSession(messages);
            const fullTokens = estimateTokens(fullText);
            let conversationText = fullText;
            let wasWindowed = false;
            if (fullTokens > tokenBudget) {
              const lines = messages;
              const keep = Math.floor(tokenBudget / 100);
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
                timeoutMs: 180_000,
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
          }
          default:
            throw new Error(`Unknown session action: ${params?.action}. Use: search, query.`);
        }
      } catch (err) {
        log.error(`session tool failed: ${err}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${err}` }],
          details: { error: true, action: params?.action },
        };
      }
    },
  });
  // ── R6: Mid-Task Auto Recall ────────────────────────────────────────
  // Fires once per session (on first tool execution). Uses actual task text
  // from the first user message (not tool names) and requires strong relevance
  // (>=5 matches + same project) to avoid flooding the agent with noise.
  let midTaskRecallDone = false;

  onEvent(pi, TURN_END, async (_event: unknown, ctx: any) => {
    if (midTaskRecallDone) return;
    midTaskRecallDone = true;

    // Extract first user message as task context
    // Use safeSessionManager to avoid assertActive() crash on stale ctx
    const manager = safeSessionManager(ctx) as { getBranch?(): any[] } | undefined;
    const entries = manager?.getBranch?.();
    if (!entries || entries.length === 0) return;
    const firstUserMsg = entries.find(
      (e: any) => e.type === "message" && e.message?.role === "user",
    );
    if (!firstUserMsg) return;
    const content = firstUserMsg.message?.content;
    const taskText =
      typeof content === "string"
        ? content.slice(0, 300)
        : Array.isArray(content)
          ? content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ")
              .slice(0, 300)
          : "";
    if (!taskText || taskText.length < 20) return;

    const sessionsDir = getSessionsDir();
    if (!(await asyncExists(sessionsDir))) return;

    try {
      const results = await searchFiles(taskText, sessionsDir);
      // Only surface if strongly relevant: >=5 matches AND same project directory
      const projectId = ctx?.cwd ? basename(ctx.cwd) : "";
      const strongMatches = results.filter(
        (r) => r.count >= 5 && (!projectId || r.path.includes(projectId)),
      );
      if (strongMatches.length > 0) {
        sendTrackedMessage(
          pi,
          {
            customType: "memory",
            display: true,
            content: [
              {
                type: "text" as const,
                text: `[recall] Past session found: "${basename(strongMatches[0].path)}" (${strongMatches[0].count} matches)`,
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
