/**
 * Session Recall Extension
 *
 * Four tools for searching, querying, analyzing, and getting stats on past pi sessions:
 *
 * Tools:
 * 1. session_search - Find relevant past sessions by keywords.
 *    Use when the user mentions something from a previous session.
 *
 * 2. session_query - Deep dive into a specific session.
 *    Use after session_search to get detailed information.
 *
 * 3. session_analyze - Multi-session LLM analysis.
 *    Use to compare patterns across sessions.
 *
 * 4. session_stats - Aggregate session statistics (count, size, by project/month).
 *    No LLM, fast.
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
import { getSessionsDir, projectFromPath, dateFromPath, searchFiles, searchLines, walkJsonlFiles, MAX_SEARCH_RESULTS, MAX_SNIPPETS_PER_SESSION } from "./search.js";
import { loadSessionMessages, serializeSession, QUERY_SYSTEM_PROMPT } from "./query.js";
import { summarizeSession, buildAnalysisInput, ANALYZE_SYSTEM_PROMPT } from "./analyze.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { TURN_END } from "../../../lib/core/event-names.js";

// Local re-exports so internal callers can use the short names.
const extractMessageText = import_textUtils.extractMessageText;
const snippetAround = import_textUtils.snippetAround;
const estimateTokens = import_textUtils.estimateTokens;

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("query"), Type.Literal("batch"), Type.Literal("stats"), Type.Literal("analyze")], {
    description: "Action: search | query | batch | stats | analyze",
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
  // analyze-only
  sessionPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Session file paths to analyze (action=analyze)" }),
  ),
  sample: Type.Optional(
    Type.Number({ description: "Max sessions to sample when analyzing (action=analyze, default: all)" }),
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
  until: Type.Optional(
    Type.String({ description: "Only include sessions until this date (YYYY-MM-DD). Optional." }),
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
    promptSnippet: "Search past sessions, query a session, analyze multiple sessions, or get session statistics",
    description:
      "Access past session history. " +
      "Use action=search with query to find sessions matching keywords (plain-text grep, no LLM). " +
      "Use action=query with sessionPath + question to analyze a specific session (LLM-driven). " +
      "Use action=analyze with sessionPaths + question to analyze multiple sessions (LLM-driven). " +
      "Use action=batch with pattern to aggregate matches across all sessions (no LLM, fast). " +
      "Use action=stats for session statistics overview (no LLM, fast).",
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
          case "analyze": {
            if (!params.sessionPaths || !Array.isArray(params.sessionPaths) || params.sessionPaths.length === 0) {
              return {
                content: [{ type: "text" as const, text: "action=analyze requires 'sessionPaths' (array of session file paths) and 'question'" }],
                details: { error: true, action: "analyze" },
              };
            }
            if (!params.question) {
              return {
                content: [{ type: "text" as const, text: "action=analyze requires 'question' parameter" }],
                details: { error: true, action: "analyze" },
              };
            }

            // Validate paths exist
            const validPaths: string[] = [];
            for (const p of params.sessionPaths) {
              if (await asyncExists(p)) {
                validPaths.push(p);
              }
            }

            if (validPaths.length === 0) {
              return {
                content: [{ type: "text" as const, text: "None of the provided session paths exist." }],
                details: { error: true, action: "analyze", providedPaths: params.sessionPaths },
              };
            }

            // Apply sampling
            let pathsToAnalyze = validPaths;
            if (params.sample && params.sample > 0 && params.sample < validPaths.length) {
              // Shuffle and take sample
              const shuffled = [...validPaths].sort(() => Math.random() - 0.5);
              pathsToAnalyze = shuffled.slice(0, params.sample);
            }

            // Build summaries for each session
            const summaries: Array<{ path: string; date: string; project: string; compressed: string }> = [];
            const errors: string[] = [];

            for (const sessionPath of pathsToAnalyze) {
              try {
                const project = projectFromPath(sessionPath);
                const date = dateFromPath(sessionPath);
                const summary = await summarizeSession(sessionPath, project, date);
                summaries.push({
                  path: sessionPath,
                  date: summary.date,
                  project: summary.project,
                  compressed: summary.compressed,
                });
              } catch (err) {
                errors.push(`Failed to summarize ${sessionPath}: ${err}`);
              }
            }

            if (summaries.length === 0) {
              return {
                content: [{ type: "text" as const, text: "Failed to summarize any sessions." }],
                details: { error: true, action: "analyze", errors },
              };
            }

            // Prepare LLM input
            const ctx = _ctx;
            const baseModel = resolveUtilityModel(ctx) ?? ctx?.model ?? currentModel;
            const model = baseModel;
            const contextWindow = model?.contextWindow ?? 200000;
            const tokenBudget = Math.floor(contextWindow * 0.8);

            const { text: analysisInput, windowed } = buildAnalysisInput(
              summaries.map((s) => ({
                path: s.path,
                date: s.date,
                project: s.project,
                messageCount: 0,
                turnCount: 0,
                events: [],
                toolsUsed: [],
                errorCount: 0,
                compressed: s.compressed,
              })),
              params.question,
              tokenBudget - estimateTokens(ANALYZE_SYSTEM_PROMPT) - 5000, // reserve 5K for response
            );

            if (analysisInput.length === 0) {
              return {
                content: [{ type: "text" as const, text: "Analysis input is empty after windowing." }],
                details: { error: true, action: "analyze" },
              };
            }

            // Call LLM for analysis
            try {
              const apiKey = ctx?.modelRegistry
                ? await ctx.modelRegistry.getApiKeyForProvider(model.provider)
                : "";
              const llmResult = await callLlm(model, apiKey, ANALYZE_SYSTEM_PROMPT, analysisInput, {
                timeoutMs: 300_000,
                ...(signal ? { signal } : {}),
              });

              if ("error" in llmResult) {
                return {
                  content: [{ type: "text" as const, text: `Analysis failed: ${llmResult.error}` }],
                  details: { error: true, action: "analyze" },
                };
              }

              const answer = llmResult.text;
              if (!answer) {
                return {
                  content: [{ type: "text" as const, text: "LLM returned empty response." }],
                  details: { error: true, action: "analyze" },
                };
              }

              const windowNote = windowed ? " (windowed — some sessions omitted due to context limits)" : "";
              const errorNote = errors.length > 0 ? `\n\n**Warnings:** ${errors.length} session(s) failed to load.` : "";

              return {
                content: [
                  {
                    type: "text" as const,
                    text: `**Analysis of ${summaries.length} session${summaries.length === 1 ? "" : "s"}**${windowNote}${errorNote}\n\n---\n\n${answer}\n\n*Analyzed by ${model.id} (${model.provider})*`,
                  },
                ],
                details: {
                  action: "analyze",
                  question: params.question,
                  sessionCount: summaries.length,
                  totalRequested: params.sessionPaths.length,
                  validCount: validPaths.length,
                  windowed,
                  errors: errors.length > 0 ? errors : undefined,
                  sessions: summaries.map((s) => ({
                    path: s.path,
                    date: s.date,
                    project: s.project,
                  })),
                },
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error analyzing sessions: ${err}` }],
                details: { error: true, action: "analyze" },
              };
            }
          }
          case "stats": {
            const sessionsDir = getSessionsDir();
            if (!(await asyncExists(sessionsDir))) {
              return {
                content: [{ type: "text" as const, text: "No sessions directory found." }],
                details: { error: true, matchCount: 0 },
              };
            }

            const allFiles = await walkJsonlFiles(sessionsDir);
            if (allFiles.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No session files found." }],
                details: { sessionCount: 0 },
              };
            }

            // Apply filters
            const projectFilter = params.project === "all"
              ? null
              : (params.project ?? null);

            const sinceTs = params.since
              ? new Date(params.since + "T00:00:00.000Z").getTime()
              : null;
            const untilTs = params.until
              ? new Date(params.until + "T23:59:59.999Z").getTime()
              : null;

            // Stat each file: size, project, date
            const { stat } = await import("node:fs/promises");
            const sessionStats: Array<{ path: string; size: number; project: string; date: string }> = [];
            let totalSize = 0;

            for (const filePath of allFiles) {
              // Apply project filter
              if (projectFilter && !filePath.includes(projectFilter)) continue;

              const dateStr = dateFromPath(filePath);

              // Apply date filters
              if (dateStr === "unknown") continue;
              const fileTs = new Date(dateStr + "T00:00:00.000Z").getTime();
              if (sinceTs && fileTs < sinceTs) continue;
              if (untilTs && fileTs > untilTs) continue;

              let size = 0;
              try {
                const st = await stat(filePath);
                size = st.size;
              } catch {
                // skip unreadable files
                continue;
              }

              const project = projectFromPath(filePath);
              totalSize += size;
              sessionStats.push({ path: filePath, size, project, date: dateStr });
            }

            if (sessionStats.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No session files match the given filters." }],
                details: { sessionCount: 0 },
              };
            }

            // Aggregate by project
            const byProject: Record<string, { count: number; size: number }> = {};
            for (const s of sessionStats) {
              if (!byProject[s.project]) byProject[s.project] = { count: 0, size: 0 };
              byProject[s.project].count++;
              byProject[s.project].size += s.size;
            }

            // Aggregate by month
            const byMonth: Record<string, { count: number; size: number }> = {};
            for (const s of sessionStats) {
              const month = s.date.slice(0, 7);
              if (!byMonth[month]) byMonth[month] = { count: 0, size: 0 };
              byMonth[month].count++;
              byMonth[month].size += s.size;
            }

            // Sort top sessions by size descending
            const limit = params.limit ?? 10;
            const topSessions = [...sessionStats].sort((a, b) => b.size - a.size).slice(0, limit);

            // Format size helper
            function formatSize(bytes: number): string {
              if (bytes < 1024) return `${bytes} B`;
              if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
              return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            }

            const avgSize = sessionStats.length > 0 ? totalSize / sessionStats.length : 0;

            // Build output
            const lines: string[] = [
              `## Session Statistics`,
              ``,//
              `**Total sessions:** ${sessionStats.length}`,
              `**Total size:** ${formatSize(totalSize)}`,
              `**Average session size:** ${formatSize(avgSize)}`,
              ``,//
            ];

            // By project
            const projectEntries = Object.entries(byProject).sort((a, b) => b[1].count - a[1].count);
            lines.push("**By project:**");
            for (const [proj, stats] of projectEntries) {
              lines.push(`  ${proj}: ${stats.count} session${stats.count === 1 ? "" : "s"}, ${formatSize(stats.size)}`);
            }
            lines.push("");

            // By month (timeline)
            const monthEntries = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
            lines.push("**By month (timeline):**");
            for (const [month, stats] of monthEntries) {
              lines.push(`  ${month}: ${stats.count} session${stats.count === 1 ? "" : "s"}, ${formatSize(stats.size)}`);
            }
            lines.push("");

            // Top sessions by size
            lines.push(`**Top ${topSessions.length} session${topSessions.length === 1 ? "" : "s"} by size:**`);
            for (const s of topSessions) {
              lines.push(`  ${s.date} ${s.project}: ${formatSize(s.size)}`);
              lines.push(`    ${s.path}`);
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {
                action: "stats",
                sessionCount: sessionStats.length,
                totalSize,
                avgSize: Math.round(avgSize),
                byProject: projectEntries.map(([project, st]) => ({ project, count: st.count, size: st.size })),
                byMonth: monthEntries.map(([month, st]) => ({ month, count: st.count, size: st.size })),
                topSessions: topSessions.map((s) => ({
                  path: s.path,
                  date: s.date,
                  project: s.project,
                  size: s.size,
                })),
                appliedFilters: {
                  project: projectFilter,
                  since: params.since ?? null,
                  until: params.until ?? null,
                  limit,
                },
              },
            };
          }
          default:
            throw new Error(`Unknown session action: ${params?.action}. Use: search, query, batch, stats, analyze.`);
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