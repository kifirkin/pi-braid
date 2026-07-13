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
 *
 * Split into:
 *   - search.ts — grep-based keyword search (rg/grep/node backends)
 *   - query.ts — LLM-driven session analysis
 *   - text-utils.ts — text extraction and token estimation helpers
 *   - index.ts — extension factory and tool registration
 */

import { createLogger } from "../../../lib/core/logger.js";
import { safeSessionManagerTyped } from "../../../lib/state/extension-state.js";

const log = createLogger("session-recall");

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { callLlm } from "../../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../../lib/ai/model-resolver.js";
import { Type } from "typebox";
import { basename } from "node:path";
import { asyncExists } from "../../../lib/utils/async-fs.js";
import * as import_textUtils from "./text-utils.js";
import { getSessionsDir, projectFromPath, dateFromPath, searchFiles, searchLines, MAX_SEARCH_RESULTS, MAX_SNIPPETS_PER_SESSION } from "./search.js";
import { loadSessionMessages, serializeSession, QUERY_SYSTEM_PROMPT } from "./query.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { TURN_END } from "../../../lib/core/event-names.js";

// Local re-exports so internal callers can use the short names.
const extractMessageText = import_textUtils.extractMessageText;
const snippetAround = import_textUtils.snippetAround;
const estimateTokens = import_textUtils.estimateTokens;

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("query"), Type.Literal("batch")], {
    description: "Action: search | query | batch",
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
  // batch-only
  pattern: Type.Optional(
    Type.String({ description: "Pattern to search for across all sessions (action=batch)" }),
  ),
  project: Type.Optional(
    Type.String({ description: "Filter by project directory (default: current cwd). Use 'all' for all projects." }),
  ),
  since: Type.Optional(
    Type.String({ description: "Only include sessions since this date (YYYY-MM-DD). Optional." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max sessions in output (default: 10). Use 0 for all." }),
  ),
});

// ── Extension ─────────────────────────────────────────────────────────────────

export default function sessionRecallExtension(pi: ExtensionAPI) {
  let currentModel: Model<any> | undefined;
  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  pi.registerTool({
    name: "session",
    label: "Session",
    promptSnippet: "Search past sessions or query a specific session",
    description:
      "Access past session history. " +
      "Use action=search with query to find sessions matching keywords (plain-text grep, no LLM). " +
      "Use action=query with sessionPath + question to analyze a specific session (LLM-driven). " +
      "Use action=batch with pattern to aggregate matches across all sessions (no LLM, fast).",
    parameters: sessionSchema,
    execute: async (
      _toolCallId,
      params: any,
      signal: AbortSignal | undefined,
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
                `**${date}** - \`${project}\` - ${count} match${count > 1 ? "es" : ""}\n` +
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
            const ctx = _ctx;
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
                ...(signal ? { signal } : {}),
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
          case "batch": {
            if (!params.pattern) {
              return {
                content: [{ type: "text" as const, text: "action=batch requires 'pattern' parameter" }],
                details: { error: true, action: "batch" },
              };
            }
            const sessionsDir = getSessionsDir();
            if (!(await asyncExists(sessionsDir))) {
              return {
                content: [{ type: "text" as const, text: "No sessions directory found." }],
                details: { error: true, matchCount: 0 },
              };
            }
            const allMatches = await searchFiles(params.pattern, sessionsDir);
            if (allMatches.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No sessions found matching "${params.pattern}".`,
                  },
                ],
                details: { matchCount: 0, pattern: params.pattern },
              };
            }

            // Apply project filter (default to current cwd)
            const projectFilter = params.project === "all"
              ? null
              : (params.project ?? (_ctx?.cwd ? basename(_ctx.cwd) : null));
            let filtered = allMatches;
            if (projectFilter) {
              filtered = allMatches.filter((m) => m.path.includes(projectFilter));
            }

            // Apply since filter (YYYY-MM-DD)
            if (params.since) {
              const sinceTs = new Date(params.since + "T00:00:00.000Z").getTime();
              if (!isNaN(sinceTs)) {
                filtered = filtered.filter((m) => {
                  const dateStr = dateFromPath(m.path);
                  if (!dateStr || dateStr === "unknown") return false;
                  return new Date(dateStr + "T00:00:00.000Z").getTime() >= sinceTs;
                });
              }
            }

            if (filtered.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No sessions found matching "${params.pattern}" with the given filters.`,
                  },
                ],
                details: { matchCount: 0, pattern: params.pattern },
              };
            }

            // Sort by match count descending
            filtered.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

            // Aggregate by project
            const byProject: Record<string, number> = {};
            for (const m of filtered) {
              const proj = projectFromPath(m.path);
              byProject[proj] = (byProject[proj] || 0) + m.count;
            }

            // Aggregate by month
            const byMonth: Record<string, number> = {};
            for (const m of filtered) {
              const dateStr = dateFromPath(m.path);
              if (dateStr && dateStr !== "unknown") {
                const month = dateStr.slice(0, 7); // YYYY-MM
                byMonth[month] = (byMonth[month] || 0) + m.count;
              }
            }

            // Total matches
            const totalMatches = filtered.reduce((sum, m) => sum + m.count, 0);

            // Top N sessions
            const limit = params.limit ?? 10;
            const topSessions = limit > 0 ? filtered.slice(0, limit) : filtered;

            // Build output
            const lines: string[] = [
              `## Batch: "${params.pattern}"`,
              ``,//
              `**Total matches:** ${totalMatches} in ${filtered.length} session${filtered.length === 1 ? "" : "s"}`,
              ``,//
            ];

            // By project
            const projectEntries = Object.entries(byProject).sort((a, b) => b[1] - a[1]);
            lines.push("**By project:**");
            for (const [proj, count] of projectEntries) {
              lines.push(`  ${proj}: ${count}`);
            }
            lines.push("");

            // By month (timeline)
            const monthEntries = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
            lines.push("**By month:**");
            for (const [month, count] of monthEntries) {
              lines.push(`  ${month}: ${count}`);
            }
            lines.push("");

            // Top sessions
            lines.push("**Top sessions:**");
            for (const m of topSessions) {
              const date = dateFromPath(m.path);
              const proj = projectFromPath(m.path);
              lines.push(`  ${date} ${proj}: ${m.count} matches`);
              lines.push(`    ${m.path}`);
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {
                action: "batch",
                pattern: params.pattern,
                totalMatches,
                sessionCount: filtered.length,
                byProject: projectEntries,
                byMonth: monthEntries,
                topSessions: topSessions.map((m) => ({
                  path: m.path,
                  date: dateFromPath(m.path),
                  project: projectFromPath(m.path),
                  matches: m.count,
                })),
                appliedFilters: {
                  project: projectFilter,
                  since: params.since ?? null,
                  limit,
                },
              },
            };
          }
          default:
            throw new Error(`Unknown session action: ${params?.action}. Use: search, query, batch.`);
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
  let midTaskRecallDone = false;

  onEvent(pi, TURN_END, async (_event: unknown, ctx: any) => {
    if (midTaskRecallDone) return;
    midTaskRecallDone = true;

    const manager = safeSessionManagerTyped(ctx);
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