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
import {
  getSessionsDir,
  projectFromPath,
  pathMatchesProject,
  dateFromPath,
  searchFiles,
  searchFilesWithInfo,
  searchLineHits,
  excludeSessionPath,
  walkJsonlFiles,
  tokenizeQuery,
  labelFromCwd,
  messagesMatchingTerms,
  MAX_SEARCH_RESULTS,
  MAX_SNIPPETS_PER_SESSION,
} from "./search.js";
import { rankSearchResults } from "./rank.js";
import { corpusIndexFreshness, loadCorpusIndex } from "./corpus-index.js";
import { askCorpusIndex, formatAskResult, MAX_ASK_HITS } from "./ask.js";
import { loadSessionMessages, serializeSession, QUERY_SYSTEM_PROMPT } from "./query.js";
import { collectSessionStats } from "./stats.js";
import { summarizeSession, buildAnalysisInput, ANALYZE_SYSTEM_PROMPT } from "./analyze.js";
import { aggregateContextAdoption, formatContextAggregate } from "./context-aggregate.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { fenceMemoryContext } from "../../../lib/utils/memory-fence.js";
import { TURN_END } from "../../../lib/core/event-names.js";

// Local re-exports so internal callers can use the short names.
const extractLineMessages = import_textUtils.extractLineMessages;
const snippetAround = import_textUtils.snippetAround;
const estimateTokens = import_textUtils.estimateTokens;
const MAX_ARCHIVE_MESSAGES = import_textUtils.MAX_ARCHIVE_MESSAGES;

// Schemas

const sessionSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("ask"),
      Type.Literal("query"),
      Type.Literal("batch"),
      Type.Literal("stats"),
      Type.Literal("analyze"),
      Type.Literal("context"),
    ],
    {
      description: "Action: search | ask | query | batch | stats | analyze | context",
    },
  ),
  // search/ask
  query: Type.Optional(
    Type.String({
      description:
        "Search terms, space-separated; a file matching any term is returned and files carrying the whole phrase rank first. action=search. " +
        "For action=ask, the question in words: it is scored against the corpus index of user turns and the top turns are cited.",
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
    Type.Number({
      description: "Max sessions to sample when analyzing (action=analyze, default: all)",
    }),
  ),
  // batch-only
  pattern: Type.Optional(
    Type.String({ description: "Pattern to search for across all sessions (action=batch)" }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Filter by project directory (default: current cwd). Use 'all' for all projects.",
    }),
  ),
  since: Type.Optional(
    Type.String({ description: "Only include sessions since this date (YYYY-MM-DD). Optional." }),
  ),
  until: Type.Optional(
    Type.String({ description: "Only include sessions until this date (YYYY-MM-DD). Optional." }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max sessions in output (default: 10)" })),
});

/**
 * Read an optional session limit. Argument validation converts a blank string
 * to 0 for `Type.Optional(Type.Number())` and the converted value passes, so
 * the handler cannot tell a blank from a typed 0. 0 used to select the
 * documented "all sessions" mode, which a blank then triggered silently; a
 * deliberate 0 is indistinguishable from a blank after conversion, so the
 * documented default is the safe reading and the unbounded mode is no longer
 * reachable through this selector.
 */
function positiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Helpers the search, ask and batch actions share

/** Passages one `batch` result renders across all its sessions. */
const MAX_BATCH_LINES = 20;

/**
 * The session file this call runs in.
 *
 * A session must never match its own transcript: the current turn's own words
 * are the query, so it would outrank the earlier evidence it is looking for.
 * pi exposes the file on the session manager; the environment carries it for a
 * context without one.
 */
function callingSessionFile(ctx: unknown): string | null {
  const manager = (
    ctx as
      | {
          sessionManager?: {
            getSessionFile?: () => string | null | undefined;
            sessionFile?: string;
          };
        }
      | undefined
  )?.sessionManager;
  const fromManager = manager?.getSessionFile?.() ?? manager?.sessionFile;
  if (typeof fromManager === "string" && fromManager) return fromManager;
  const fromEnv = process.env.PI_SESSION_FILE;
  return typeof fromEnv === "string" && fromEnv ? fromEnv : null;
}

/**
 * One matched JSONL line as a readable passage, or null when the line carries
 * no message text. A compaction envelope holds many messages in one physical
 * line, so the messages carrying the pattern are preferred over the first.
 */
function linePassage(rawLine: string, query: string): string | null {
  const parsed = extractLineMessages(rawLine);
  const terms = tokenizeQuery(query);
  const shown =
    parsed.isArchive && terms.length > 0
      ? messagesMatchingTerms(parsed.messages, terms)
      : parsed.messages;
  const first = shown[0] ?? parsed.messages[0];
  if (!first) return null;
  const text = snippetAround(first.text, query, 110).replace(/\s+/g, " ").trim();
  return `  [${first.role}] ${text}`;
}

/**
 * Ranked passages across matched sessions: term coverage first, then recency,
 * capped at MAX_BATCH_LINES. One read per session, and only for the sessions
 * the caller's limit already selected.
 */
async function batchPassages(
  sessions: Array<{ path: string }>,
  pattern: string,
): Promise<string[]> {
  const scored: Array<{ weight: number; when: string; text: string }> = [];
  for (const session of sessions) {
    if (scored.length >= MAX_BATCH_LINES) break;
    const hits = await searchLineHits(pattern, session.path, MAX_SNIPPETS_PER_SESSION);
    for (const hit of hits) {
      const passage = linePassage(hit.text, pattern);
      if (!passage) continue;
      scored.push({
        weight: hit.hits,
        when: dateFromPath(session.path),
        text: `${passage}  \`${basename(session.path)}:${hit.line}\``,
      });
    }
  }
  scored.sort((a, b) => b.weight - a.weight || b.when.localeCompare(a.when));
  return scored.slice(0, MAX_BATCH_LINES).map((entry) => entry.text);
}

// Extension

export default function sessionRecallExtension(pi: ExtensionAPI) {
  let currentModel: Model<any> | undefined;
  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  pi.registerTool({
    name: "session",
    label: "Session",
    promptSnippet: "Access past session history — search, ask, query, analyze, stats, or context",
    description:
      "Access past session history: search, ask, query a specific session, analyze multiple, batch across sessions, stats, or context (cross-session §8 adoption aggregate). " +
      "ask answers a question from the indexed user turns and cites every hit (project, session path, line, timestamp); it refuses when the index cannot answer. " +
      "LLM-driven except search, ask, batch, stats, and context.",
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
                content: [
                  { type: "text" as const, text: "action=search requires 'query' parameter" },
                ],
                details: { error: true, action: "search" },
              };
            }
            const sessionsDir = getSessionsDir(_ctx);
            if (!(await asyncExists(sessionsDir))) {
              return {
                content: [{ type: "text" as const, text: "No sessions directory found." }],
                details: { error: true, matchCount: 0 },
              };
            }
            const currentProject = _ctx?.cwd ? labelFromCwd(_ctx.cwd) : undefined;
            const ownSession = callingSessionFile(_ctx);
            // The four-signal ranker also picks the bounded candidate set the
            // role signal is refined on; see search.ts ROLE_REFINE_LIMIT. The
            // caller's own session is dropped before either read, so a session
            // can never match itself (search.ts excludeSessionPath).
            const info = await searchFilesWithInfo(params.query, sessionsDir, {
              rankCandidates: (matches) =>
                rankSearchResults(excludeSessionPath(matches, ownSession), { currentProject }),
            });
            const allMatches = excludeSessionPath(info.matches, ownSession);
            if (allMatches.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No sessions found matching "${params.query}". Try fewer, shorter terms -- terms are matched literally, meaning is not.`,
                  },
                ],
                details: {
                  matchCount: 0,
                  query: params.query,
                  backend: info.backend,
                  elapsedMs: info.elapsedMs,
                },
              };
            }
            // Rank by occurrences, recency, project and role; the top slice is
            // what gets read and rendered. See rank.ts for the blend.
            const fileMatches = rankSearchResults(allMatches, { currentProject }).slice(
              0,
              MAX_SEARCH_RESULTS,
            );
            const results: string[] = [];
            const queryTerms = tokenizeQuery(params.query);
            for (const { path: filePath } of fileMatches) {
              const project = projectFromPath(filePath);
              const date = dateFromPath(filePath);
              const matchLines = await searchLineHits(
                params.query,
                filePath,
                MAX_SNIPPETS_PER_SESSION,
              );
              const snippets: string[] = [];
              let archiveNote = "";
              for (const hit of matchLines) {
                const parsed = extractLineMessages(hit.text);
                // A live line carries one message. A compaction envelope carries
                // the whole archived batch inside its `originals` string, and the
                // one physical line matches if the query is anywhere in that
                // batch — so select the archived messages that contain the query
                // instead of snippetting the first N and dropping the match. Live
                // lines keep line-level semantics: the line matched, so
                // render it without re-testing the extracted text.
                const shown = parsed.isArchive
                  ? messagesMatchingTerms(parsed.messages, queryTerms)
                  : parsed.messages;
                for (const msg of shown) {
                  if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
                  snippets.push(
                    `  [${msg.role}] L${hit.line}: ${snippetAround(msg.text, params.query)}`,
                  );
                }
                if (parsed.isArchive) {
                  const parts = [
                    `${parsed.totalMessages} archived message${parsed.totalMessages === 1 ? "" : "s"}`,
                  ];
                  if (typeof parsed.compactedMessages === "number") {
                    parts.push(`compacted=${parsed.compactedMessages}`);
                  }
                  if (typeof parsed.keptMessages === "number") {
                    parts.push(`kept=${parsed.keptMessages}`);
                  }
                  if (parsed.truncated) {
                    parts.push(
                      `scanned first ${MAX_ARCHIVE_MESSAGES} (later messages not searched)`,
                    );
                  }
                  archiveNote = `  _(compaction archive: ${parts.join(", ")})_`;
                }
                if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
              }
              // An archive whose match sits past the scan cap (or outside the
              // text content) renders the provenance line alone, so the session
              // is never dropped silently. A live file drops when no line
              // matches.
              if (snippets.length === 0 && !archiveNote) continue;
              results.push(
                `**${date}** - \`${project}\`\n` +
                  `Session: \`${filePath}\`\n` +
                  [...snippets, archiveNote].filter(Boolean).join("\n"),
              );
            }
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No readable matches found for "${params.query}". Try shorter, more specific terms -- terms are matched literally, not as meaning.`,
                  },
                ],
                details: { matchCount: 0 },
              };
            }
            const output =
              `**Search:** "${params.query}" - matched lines from ${results.length} session${results.length > 1 ? "s" : ""}, ranked:\n\n` +
              results.join("\n\n---\n\n");
            return {
              content: [{ type: "text" as const, text: output }],
              details: {
                matchCount: results.length,
                query: params.query,
                backend: info.backend,
                elapsedMs: info.elapsedMs,
                roleRefined: info.roleRefined,
                selfSessionExcluded: Boolean(ownSession),
              },
            };
          }
          case "ask": {
            if (!params.query) {
              return {
                content: [{ type: "text" as const, text: "action=ask requires 'query' parameter" }],
                details: { error: true, action: "ask" },
              };
            }
            const projectFilter =
              params.project === "all"
                ? null
                : (params.project ?? (_ctx?.cwd ? labelFromCwd(_ctx.cwd) : null));
            const loaded = await loadCorpusIndex(projectFilter ? { project: projectFilter } : {});
            if (!loaded.ok) {
              const hint = projectFilter ? ` Pass project=all to query every project's shard.` : "";
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `The corpus index cannot answer: ${loaded.reason}.${hint} ` +
                      `Index directory: \`${loaded.dir}\`. Build it with ` +
                      `\`node packages/core/scripts/build-corpus-index.mjs\` (one pass over the ` +
                      `session files), then ask again.`,
                  },
                ],
                details: {
                  error: true,
                  action: "ask",
                  indexDir: loaded.dir,
                  reason: loaded.reason,
                  shards: loaded.shards,
                },
              };
            }
            // The answer states its own freshness: a shard is derived data, so
            // the drift is measured and printed rather than assumed away.
            const freshness = await corpusIndexFreshness(loaded.shards, getSessionsDir(_ctx));
            const result = askCorpusIndex(loaded.shards, params.query, {
              project: projectFilter,
              since: params.since ?? null,
              limit: positiveLimit(params.limit) ?? MAX_ASK_HITS,
              excludeSession: callingSessionFile(_ctx),
              freshness,
            });
            return {
              content: [{ type: "text" as const, text: formatAskResult(result) }],
              details: {
                action: "ask",
                answered: result.answered,
                query: params.query,
                terms: result.terms,
                matchedTerms: result.matched_terms,
                unmatchedTerms: result.unmatched_terms,
                hits: result.hits.map((hit) => ({
                  project: hit.turn.project,
                  session: hit.turn.session,
                  sessionId: hit.turn.session_id,
                  line: hit.turn.line,
                  ts: hit.turn.ts,
                  score: Number(hit.score.toFixed(3)),
                })),
                population: result.population,
                freshness,
                indexDir: loaded.dir,
                selfSessionExcluded: result.self_excluded,
              },
            };
          }
          case "query": {
            if (!params.sessionPath || !params.question) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "action=query requires 'sessionPath' and 'question'",
                  },
                ],
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
                  {
                    type: "text" as const,
                    text: `Error: Session file not found: ${params.sessionPath}`,
                  },
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
                content: [
                  { type: "text" as const, text: "action=batch requires 'pattern' parameter" },
                ],
                details: { error: true, action: "batch" },
              };
            }
            const sessionsDir = getSessionsDir(_ctx);
            if (!(await asyncExists(sessionsDir))) {
              return {
                content: [{ type: "text" as const, text: "No sessions directory found." }],
                details: { error: true, matchCount: 0 },
              };
            }
            const ownSession = callingSessionFile(_ctx);
            const allMatches = excludeSessionPath(
              await searchFiles(params.pattern, sessionsDir),
              ownSession,
            );
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

            const projectFilter =
              params.project === "all"
                ? null
                : (params.project ?? (_ctx?.cwd ? basename(_ctx.cwd) : null));
            let filtered = allMatches;
            if (projectFilter) {
              filtered = allMatches.filter((m) => pathMatchesProject(m.path, projectFilter));
            }

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

            // Top N sessions. A blank limit is read as absent (see positiveLimit),
            // never as the old unbounded mode.
            const limit = positiveLimit(params.limit) ?? 10;
            const topSessions = filtered.slice(0, limit);

            // The result leads with passages, not a count: aggregate numbers
            // say how much matched, never what matched. Reads are bounded by
            // the session limit above and MAX_BATCH_LINES below.
            const passages = await batchPassages(topSessions, params.pattern);

            const lines: string[] = [
              `## Batch: "${params.pattern}"`,
              ``, //
            ];
            if (passages.length > 0) {
              lines.push(
                `**Matched lines** (${passages.length} of ${totalMatches} matches, ranked):`,
              );
              lines.push(...passages);
            } else {
              lines.push(
                `**Matched lines:** none rendered - the matching sessions carry the pattern only in ` +
                  `text this reader does not extract (tool results, metadata).`,
              );
            }
            lines.push("");
            lines.push(
              `**Aggregates:** ${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${filtered.length} session${filtered.length === 1 ? "" : "s"}`,
            );
            lines.push("");

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
                renderedPassages: passages.length,
                selfSessionExcluded: Boolean(ownSession),
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
            if (
              !params.sessionPaths ||
              !Array.isArray(params.sessionPaths) ||
              params.sessionPaths.length === 0
            ) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "action=analyze requires 'sessionPaths' (array of session file paths) and 'question'",
                  },
                ],
                details: { error: true, action: "analyze" },
              };
            }
            if (!params.question) {
              return {
                content: [
                  { type: "text" as const, text: "action=analyze requires 'question' parameter" },
                ],
                details: { error: true, action: "analyze" },
              };
            }

            const validPaths: string[] = [];
            for (const p of params.sessionPaths) {
              if (await asyncExists(p)) {
                validPaths.push(p);
              }
            }

            if (validPaths.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: "None of the provided session paths exist." },
                ],
                details: { error: true, action: "analyze", providedPaths: params.sessionPaths },
              };
            }

            let pathsToAnalyze = validPaths;
            if (params.sample && params.sample > 0 && params.sample < validPaths.length) {
              // Shuffle and take sample
              const shuffled = [...validPaths].sort(() => Math.random() - 0.5);
              pathsToAnalyze = shuffled.slice(0, params.sample);
            }

            const summaries: Array<{
              path: string;
              date: string;
              project: string;
              compressed: string;
            }> = [];
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
                content: [
                  { type: "text" as const, text: "Analysis input is empty after windowing." },
                ],
                details: { error: true, action: "analyze" },
              };
            }

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

              const windowNote = windowed
                ? " (windowed — some sessions omitted due to context limits)"
                : "";
              const errorNote =
                errors.length > 0
                  ? `\n\n**Warnings:** ${errors.length} session(s) failed to load.`
                  : "";

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
          case "context": {
            const sessionsDir = getSessionsDir(_ctx);
            if (!(await asyncExists(sessionsDir))) {
              return {
                content: [{ type: "text" as const, text: "No sessions directory found." }],
                details: { error: true, action: "context" },
              };
            }
            const aggregate = await aggregateContextAdoption(sessionsDir, {
              since: params.since,
              until: params.until,
              project: params.project === "all" ? null : (params.project ?? null),
              maxFiles: positiveLimit(params.limit),
            });
            return {
              content: [{ type: "text" as const, text: formatContextAggregate(aggregate) }],
              details: {
                action: "context",
                ...aggregate,
              },
            };
          }
          case "stats": {
            const sessionsDir = getSessionsDir(_ctx);
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

            const projectFilter = params.project === "all" ? null : (params.project ?? null);

            const sinceTs = params.since
              ? new Date(params.since + "T00:00:00.000Z").getTime()
              : null;
            const untilTs = params.until
              ? new Date(params.until + "T23:59:59.999Z").getTime()
              : null;

            // Stat each file: size, project, date, archive class
            const {
              entries: sessionStats,
              totalSize,
              archives,
            } = await collectSessionStats(allFiles, {
              project: projectFilter,
              since: sinceTs,
              until: untilTs,
            });

            if (sessionStats.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: "No session files match the given filters." },
                ],
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

            const limit = positiveLimit(params.limit) ?? 10;
            const topSessions = [...sessionStats].sort((a, b) => b.size - a.size).slice(0, limit);

            function formatSize(bytes: number): string {
              if (bytes < 1024) return `${bytes} B`;
              if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
              return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            }

            const avgSize = sessionStats.length > 0 ? totalSize / sessionStats.length : 0;

            const lines: string[] = [
              `## Session Statistics`,
              ``, //
              `**Total sessions:** ${sessionStats.length}`,
              `**Total size:** ${formatSize(totalSize)}`,
              `**Average session size:** ${formatSize(avgSize)}`,
              `**Archives:** ${archives.files} of these file${archives.files === 1 ? "" : "s"}, carrying ${archives.messages} archived message${archives.messages === 1 ? "" : "s"}`,
              ``, //
            ];

            // By project
            const projectEntries = Object.entries(byProject).sort(
              (a, b) => b[1].count - a[1].count,
            );
            lines.push("**By project:**");
            for (const [proj, stats] of projectEntries) {
              lines.push(
                `  ${proj}: ${stats.count} session${stats.count === 1 ? "" : "s"}, ${formatSize(stats.size)}`,
              );
            }
            lines.push("");

            // By month (timeline)
            const monthEntries = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
            lines.push("**By month (timeline):**");
            for (const [month, stats] of monthEntries) {
              lines.push(
                `  ${month}: ${stats.count} session${stats.count === 1 ? "" : "s"}, ${formatSize(stats.size)}`,
              );
            }
            lines.push("");

            // Top sessions by size
            lines.push(
              `**Top ${topSessions.length} session${topSessions.length === 1 ? "" : "s"} by size:**`,
            );
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
                archives: { files: archives.files, messages: archives.messages },
                byProject: projectEntries.map(([project, st]) => ({
                  project,
                  count: st.count,
                  size: st.size,
                })),
                byMonth: monthEntries.map(([month, st]) => ({
                  month,
                  count: st.count,
                  size: st.size,
                })),
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
            throw new Error(
              `Unknown session action: ${params?.action}. Use: search, ask, query, batch, stats, analyze, context.`,
            );
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

  // Mid-Task Auto Recall
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

    const sessionsDir = getSessionsDir(ctx);
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
                // Cross-session recall pointers are fenced non-user context.
                text: fenceMemoryContext(
                  `Past session found: "${basename(strongMatches[0].path)}" (${strongMatches[0].count} matches)`,
                ),
              },
            ],
          },
          { delivery: "park", deliverAs: "steer" },
          { type: "memory", source: "session-recall" },
        );
      }
    } catch {
      // Non-fatal: recall failed, continue without
    }
  });
}
