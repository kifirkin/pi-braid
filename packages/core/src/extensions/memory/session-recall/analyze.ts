/**
 * Session Recall - analyze functions
 *
 * Multi-session LLM analysis. For each session file:
 *   1. Parse JSONL → extract structured events
 *   2. Compress to 1-2K token summary
 *   3. Feed all summaries + question to the LLM
 *   4. Return analysis as structured text + details
 *
 * Supports progressive batching for large sample sizes.
 */

import { readFile } from "node:fs/promises";
import * as import_textUtils from "./text-utils.js";

const estimateTokens = import_textUtils.estimateTokens;

// Types

export interface SessionEvent {
  type:
    | "tool_call"
    | "tool_result"
    | "verify"
    | "finalize"
    | "error"
    | "whisper"
    | "thinking"
    | "message";
  /** Human-readable description of the event. */
  summary: string;
  /** Tool name (for tool_call / tool_result). */
  toolName?: string;
  /** Injecting subsystem for whisper events (the entry's customType). */
  whisperSource?: string;
  /** Shortened arguments or result snippet. */
  detail?: string;
  /** Whether the event was an error. */
  isError?: boolean;
  /** Verification result: pass / warn / fail. */
  verdict?: "pass" | "warn" | "fail";
}

export interface SessionSummary {
  /** Path to the session file. */
  path: string;
  date: string;
  project: string;
  /** Total number of messages in the session. */
  messageCount: number;
  /** Number of turns (user → assistant exchanges). */
  turnCount: number;
  /** Extracted events. */
  events: SessionEvent[];
  /** Tools used (deduplicated, sorted). */
  toolsUsed: string[];
  /** Number of errors encountered. */
  errorCount: number;
  /** Compressed text summary (~1-2K tokens). */
  compressed: string;
}

// Event extraction

/**
 * Parse a single JSONL line and extract structured event data.
 * Returns null for lines that don't contain actionable events.
 */
function extractEvent(jsonLine: string): SessionEvent | null {
  try {
    const entry = JSON.parse(jsonLine);
    if (entry.type === "custom_message") return extractWhisperEvent(entry);
    if (entry.type !== "message") return null;

    const msg = entry.message as {
      role: string;
      content?: Array<{ type?: string; text?: string; name?: string; arguments?: string }>;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };

    const role = msg.role;

    // Tool result messages
    if (role === "toolResult" && msg.toolName) {
      const isError = msg.isError === true;
      const contentText = extractContentText(msg.content);
      return {
        type: "tool_result",
        summary: `Tool result: ${msg.toolName}`,
        toolName: msg.toolName,
        detail: truncate(contentText, 120),
        isError,
      };
    }

    // Assistant messages may contain tool calls, thinking, or text
    if (role === "assistant" && msg.content) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.name) {
          const name = block.name;
          const args = block.arguments || "";
          const isVerify = name === "verify";
          const isFinalize = name === "finalize";

          if (isVerify) {
            const verdict: "pass" | "warn" | "fail" | undefined = undefined;
            try {
              const parsed = JSON.parse(typeof args === "string" ? args : "{}");
              const criteria = parsed.criteria;
              if (criteria) {
                return {
                  type: "verify",
                  summary: `Verify: ${Array.isArray(criteria) ? criteria.join(", ") : criteria}`,
                  toolName: "verify",
                  detail: truncate(typeof args === "string" ? args : JSON.stringify(args), 200),
                  verdict,
                };
              }
            } catch {
              // unparseable arguments, use raw
            }
            return {
              type: "verify",
              summary: `Verify call`,
              toolName: "verify",
              detail: truncate(typeof args === "string" ? args : JSON.stringify(args), 200),
              verdict,
            };
          }

          if (isFinalize) {
            let summary = "Finalize";
            try {
              const parsed = JSON.parse(typeof args === "string" ? args : "{}");
              if (parsed.summary) {
                summary = `Finalize: ${truncate(parsed.summary, 100)}`;
              }
            } catch {
              // Unparseable finalize args — the plain "Finalize" title is
              // correct for the entry either way.
            }
            return {
              type: "finalize",
              summary,
              toolName: "finalize",
              detail: truncate(typeof args === "string" ? args : JSON.stringify(args), 150),
            };
          }

          return {
            type: "tool_call",
            summary: `Tool call: ${name}`,
            toolName: name,
            detail: truncate(typeof args === "string" ? args : JSON.stringify(args), 150),
          };
        }

        if (block.type === "thinking" && block.text) {
          const text = block.text;
          const intent = text.length > 200 ? text.slice(0, 200) + "..." : text;
          return {
            type: "thinking",
            summary: truncate(intent, 150),
          };
        }

        if (block.type === "text" && block.text) {
          return {
            type: "message",
            summary: truncate(block.text, 150),
          };
        }
      }
    }

    // User messages
    if (role === "user" && msg.content) {
      const text = extractContentText(msg.content);
      if (text) {
        return {
          type: "message",
          summary: truncate(text, 150),
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * `custom_message` entries are the session's injected instructions: steers,
 * enforcement nudges, timer wakes. They stay a distinct event type because
 * pi folds their content into the model's user context, and because the
 * whisper record is what the session was told: a digest reader must be able
 * to tell an injected instruction from something the human typed.
 */
function extractWhisperEvent(entry: {
  customType?: unknown;
  content?: unknown;
}): SessionEvent | null {
  const content = entry.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type?: string; text?: string } =>
                !!block && typeof block === "object",
            )
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join(" ")
        : "";
  if (!text.trim()) return null;
  return {
    type: "whisper",
    summary: truncate(text, 150),
    whisperSource: typeof entry.customType === "string" ? entry.customType : undefined,
  };
}

/**
 * Extract text content from the content array (used by tool results and user messages).
 */
function extractContentText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// Session summary builder

/**
 * Load a session file and build a structured summary.
 */
export async function summarizeSession(
  sessionPath: string,
  project: string,
  date: string,
): Promise<SessionSummary> {
  const events: SessionEvent[] = [];
  const toolsUsed = new Set<string>();
  let errorCount = 0;
  let messageCount = 0;
  let turnCount = 0;
  let lastRole = "";

  try {
    const content = await readFile(sessionPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      messageCount++;

      const event = extractEvent(line);
      if (event) {
        events.push(event);
        if (event.toolName) toolsUsed.add(event.toolName);
        if (event.isError) errorCount++;
        if (event.type === "finalize" || event.type === "verify") {
          // These are notable events worth tracking
        }
      }

      try {
        const entry = JSON.parse(line);
        if (entry.type === "message") {
          const role = entry.message?.role;
          if (role === "user" && lastRole !== "user") turnCount++;
          lastRole = role;
        }
      } catch {
        // Malformed session line — skip it; turn counting tolerates gaps.
      }
    }
  } catch {
    // File read error — return what we have
  }

  const compressed = buildCompressedSummary(
    sessionPath,
    project,
    date,
    events,
    [...toolsUsed],
    errorCount,
    messageCount,
    turnCount,
  );

  return {
    path: sessionPath,
    date,
    project,
    messageCount,
    turnCount,
    events,
    toolsUsed: [...toolsUsed].sort(),
    errorCount,
    compressed,
  };
}

/**
 * The digest samples at most this many whispers, one per source family, so a
 * session steered hundreds of times by one subsystem does not crowd out the
 * others' first lines.
 */
const WHISPER_SAMPLE_LIMIT = 4;

/**
 * The by-source breakdown names at most this many sources; the remaining ones
 * are stated as a count. Without it the line grows with the session's source
 * vocabulary, which is open-ended.
 */
const WHISPER_SOURCE_LIMIT = 4;

/**
 * Source labels are clipped so a single long customType cannot blow the line
 * the breakdown and the samples render on. Real corpus names top out at 26.
 */
const WHISPER_SOURCE_NAME_LIMIT = 60;

/**
 * The Key events section keeps at most this many event lines. A tool-dense
 * session lists one event per tool call, so the count is what holds the
 * section inside the digest's token budget.
 */
const KEY_EVENT_LIMIT = 40;

/**
 * Rendered event lines are clipped at this length. Every extracted field is
 * already ellipsized, but a verify call's criteria summary and a tool name are
 * taken as-is; the cap keeps a single pathological line from dwarfing the
 * digest.
 */
const KEY_EVENT_LINE_LIMIT = 300;

/**
 * The `Tools used:` line names at most this many distinct tools. Tool names
 * are open-ended (plugins and MCP servers mint their own), so a session that
 * mints a name per call would grow the line without bound; no measured
 * session exceeds the cap (the corpus maximum is 40 distinct names).
 */
const TOOLS_USED_LIMIT = 40;

/**
 * A tool name is clipped at this length, so one pathological name cannot take
 * the whole line. Clean names in the measured corpus top out at 22 chars;
 * every longer name is a parse artifact (captured shell text, stray markup).
 */
const TOOLS_NAME_LIMIT = 40;

/**
 * The `Session:` line renders paths up to this length verbatim; longer paths
 * keep their longest whole trailing segments behind an `…` marker. The file
 * name and the directories nearest it are what identify a session, and the
 * marker makes the elision readable. Measured session paths top out at 208
 * chars.
 */
const SESSION_PATH_LIMIT = 256;

/**
 * Keep at most KEY_EVENT_LIMIT key events. The session's conclusion comes
 * first (finalize), then its failures, then its verifications, then the plain
 * tool-call stream; stream order decides within each class. The kept subset is
 * rendered in stream order, so the list still reads as the session's
 * narrative, and the dropped count is exact.
 */
function capKeyEvents(keyEvents: SessionEvent[]): { kept: SessionEvent[]; omitted: number } {
  if (keyEvents.length <= KEY_EVENT_LIMIT) return { kept: keyEvents, omitted: 0 };
  const rank = (e: SessionEvent): number => {
    if (e.type === "finalize") return 0;
    if (e.isError) return 1;
    if (e.type === "verify") return 2;
    return 3;
  };
  const byRank = [0, 1, 2, 3].flatMap((r) => keyEvents.filter((e) => rank(e) === r));
  const chosen = new Set(byRank.slice(0, KEY_EVENT_LIMIT));
  return { kept: keyEvents.filter((e) => chosen.has(e)), omitted: keyEvents.length - chosen.size };
}

/**
 * Keep the tools the session actually invoked when the vocabulary exceeds the
 * cap: rank by invocation count (ties keep first-seen order) so a sprayed tail
 * of one-off names is what gets dropped. The dropped count is exact.
 */
function capToolsUsed(
  toolsUsed: string[],
  events: SessionEvent[],
): { kept: string[]; omitted: number } {
  if (toolsUsed.length <= TOOLS_USED_LIMIT) return { kept: toolsUsed, omitted: 0 };
  const calls = new Map<string, number>();
  for (const ev of events) {
    const invoked = ev.type === "tool_call" || ev.type === "verify" || ev.type === "finalize";
    if (invoked && ev.toolName) calls.set(ev.toolName, (calls.get(ev.toolName) ?? 0) + 1);
  }
  const ranked = [...toolsUsed].sort((a, b) => (calls.get(b) ?? 0) - (calls.get(a) ?? 0));
  return { kept: ranked.slice(0, TOOLS_USED_LIMIT), omitted: toolsUsed.length - TOOLS_USED_LIMIT };
}

/**
 * Render a session path inside SESSION_PATH_LIMIT chars. A longer path keeps
 * its longest whole-segment suffix (the file name and the directories nearest
 * it) behind an `…<separator>` marker; a single segment longer than the
 * window falls back to a raw character tail.
 */
function renderSessionPath(sessionPath: string): string {
  if (sessionPath.length <= SESSION_PATH_LIMIT) return sessionPath;
  const budget = SESSION_PATH_LIMIT - 2;
  const tail = sessionPath.slice(sessionPath.length - budget);
  const sep = tail.search(/[/\\]/);
  return sep >= 0 ? `…${tail[sep]}${tail.slice(sep + 1)}` : `…${tail}`;
}

/**
 * Compress a session's events into a ~1-2K token structured summary.
 */
function buildCompressedSummary(
  sessionPath: string,
  project: string,
  date: string,
  events: SessionEvent[],
  toolsUsed: string[],
  errorCount: number,
  messageCount: number,
  turnCount: number,
): string {
  const lines: string[] = [];

  lines.push(`Session: ${renderSessionPath(sessionPath)}`);
  lines.push(`Date: ${date}, Project: ${project}`);
  lines.push(`Messages: ${messageCount}, Turns: ${turnCount}`);
  const { kept: keptTools, omitted: omittedTools } = capToolsUsed(toolsUsed, events);
  const renderedTools = keptTools.map((name) => truncate(name, TOOLS_NAME_LIMIT)).join(", ");
  lines.push(
    omittedTools > 0
      ? `Tools used: ${renderedTools}, ... (${omittedTools} more tools)`
      : `Tools used: ${renderedTools || "(none)"}`,
  );
  if (errorCount > 0) lines.push(`Errors: ${errorCount}`);
  lines.push("");

  const keyEvents = events.filter(
    (e) => e.type === "tool_call" || e.type === "verify" || e.type === "finalize" || e.isError,
  );

  if (keyEvents.length > 0) {
    const { kept, omitted } = capKeyEvents(keyEvents);
    lines.push("Key events:");
    for (const ev of kept) {
      const prefix = ev.isError ? "  [ERROR]" : `  [${ev.type}]`;
      const detail = ev.detail ? ` — ${ev.detail}` : "";
      lines.push(truncate(`${prefix} ${ev.summary}${detail}`, KEY_EVENT_LINE_LIMIT));
    }
    if (omitted > 0) {
      lines.push(`  ... (${omitted} more events)`);
    }
    lines.push("");
  }

  // Injected instructions (whispers) are frequent (p99 of sessions with any
  // whisper carries ~250, the corpus max ~2900), so count them by source and
  // sample one per source instead of dumping a transcript that would dwarf
  // this digest.
  const whisperEvents = events.filter((e) => e.type === "whisper");
  if (whisperEvents.length > 0) {
    lines.push(`Injected instructions (whispers): ${whisperEvents.length}`);
    const bySource = new Map<string, number>();
    for (const ev of whisperEvents) {
      const source = ev.whisperSource ?? "(unspecified)";
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }
    const bySourceSorted = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
    const namedSources = bySourceSorted.slice(0, WHISPER_SOURCE_LIMIT);
    const omittedSources = bySourceSorted.length - namedSources.length;
    const breakdown = namedSources
      .map(([source, count]) => `${truncate(source, WHISPER_SOURCE_NAME_LIMIT)} ${count}`)
      .join(", ");
    lines.push(
      omittedSources > 0
        ? `  By source: ${breakdown}, ... (${omittedSources} more sources)`
        : `  By source: ${breakdown}`,
    );

    const sampledSources = new Set<string>();
    const sample: SessionEvent[] = [];
    for (const ev of whisperEvents) {
      const source = ev.whisperSource ?? "(unspecified)";
      if (sampledSources.has(source)) continue;
      sampledSources.add(source);
      sample.push(ev);
      if (sample.length >= WHISPER_SAMPLE_LIMIT) break;
    }
    for (const ev of sample) {
      const source = ev.whisperSource
        ? `[${truncate(ev.whisperSource, WHISPER_SOURCE_NAME_LIMIT)}] `
        : "";
      lines.push(`  ${source}${ev.summary}`);
    }
    if (whisperEvents.length > sample.length) {
      lines.push(`  ... (${whisperEvents.length - sample.length} more whispers)`);
    }
    lines.push("");
  }

  // Show a sample of thinking/message events (up to 5)
  const thinkingEvents = events.filter((e) => e.type === "thinking" || e.type === "message");
  if (thinkingEvents.length > 0) {
    const sample = thinkingEvents.slice(0, 5);
    lines.push("Key decisions/messages:");
    for (const ev of sample) {
      lines.push(`  ${ev.summary}`);
    }
    if (thinkingEvents.length > 5) {
      lines.push(`  ... (${thinkingEvents.length - 5} more messages)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Analysis prompt

export const ANALYZE_SYSTEM_PROMPT = `You are analyzing pi coding assistant sessions. You will receive compressed summaries of multiple sessions and a question about them.

For each session, provide:
1. What the session accomplished
2. Key patterns in tool usage or behavior
3. Any notable failures or errors
4. How the session outcome relates to the question

Then synthesize across sessions to answer the question. Be specific and reference session dates and paths.`;

// Batch analysis

/**
 * Build a single text block from multiple session summaries, sized to fit
 * within a token budget. Returns the combined text and whether it was windowed.
 */
export function buildAnalysisInput(
  summaries: SessionSummary[],
  question: string,
  tokenBudget: number,
): { text: string; windowed: boolean } {
  const parts: string[] = [];

  parts.push("# Session Analysis\n");
  parts.push(`## Question\n\n${question}\n`);
  parts.push(`## Sessions (${summaries.length})\n`);

  for (const s of summaries) {
    parts.push(s.compressed);
    parts.push("---\n");
  }

  const fullText = parts.join("\n");
  const fullTokens = estimateTokens(fullText);

  if (fullTokens <= tokenBudget) {
    return { text: fullText, windowed: false };
  }

  // Need to window: include as many full summaries as fit, then note the rest
  const windowedParts: string[] = [];
  windowedParts.push("# Session Analysis (windowed)\n");
  windowedParts.push(`## Question\n\n${question}\n`);
  windowedParts.push(`## Sessions (${summaries.length} total, showing partial)\n`);

  let currentTokens = estimateTokens(windowedParts.join("\n"));
  let includedCount = 0;

  for (const s of summaries) {
    const summaryTokens = estimateTokens(s.compressed + "\n---\n");
    if (currentTokens + summaryTokens > tokenBudget) break;
    windowedParts.push(s.compressed);
    windowedParts.push("---\n");
    currentTokens += summaryTokens;
    includedCount++;
  }

  if (includedCount < summaries.length) {
    windowedParts.push(
      `\n[... ${summaries.length - includedCount} session(s) omitted due to length ...]\n`,
    );
  }

  return { text: windowedParts.join("\n"), windowed: true };
}
