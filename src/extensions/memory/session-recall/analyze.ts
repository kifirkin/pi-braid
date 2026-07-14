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

const extractMessageText = import_textUtils.extractMessageText;
const estimateTokens = import_textUtils.estimateTokens;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionEvent {
  type: "tool_call" | "tool_result" | "verify" | "finalize" | "error" | "whisper" | "thinking" | "message";
  /** Human-readable description of the event. */
  summary: string;
  /** Tool name (for tool_call / tool_result). */
  toolName?: string;
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
  /** Date extracted from the path. */
  date: string;
  /** Project extracted from the path. */
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

// ── Event extraction ──────────────────────────────────────────────────────────

/**
 * Parse a single JSONL line and extract structured event data.
 * Returns null for lines that don't contain actionable events.
 */
function extractEvent(jsonLine: string): SessionEvent | null {
  try {
    const entry = JSON.parse(jsonLine);
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

          // Try to extract verify criteria from arguments
          if (isVerify) {
            let verdict: "pass" | "warn" | "fail" | undefined;
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
              // use default
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
          // Extract key intent from thinking
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

// ── Session summary builder ───────────────────────────────────────────────────

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

      // Track turns: user → assistant exchange
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message") {
          const role = entry.message?.role;
          if (role === "user" && lastRole !== "user") turnCount++;
          lastRole = role;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // File read error — return what we have
  }

  // Build compressed text summary
  const compressed = buildCompressedSummary(sessionPath, project, date, events, [...toolsUsed], errorCount, messageCount, turnCount);

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

  lines.push(`Session: ${sessionPath}`);
  lines.push(`Date: ${date}, Project: ${project}`);
  lines.push(`Messages: ${messageCount}, Turns: ${turnCount}`);
  lines.push(`Tools used: ${toolsUsed.join(", ") || "(none)"}`);
  if (errorCount > 0) lines.push(`Errors: ${errorCount}`);
  lines.push("");

  // Extract key events: tool calls, verifications, finalize, errors
  const keyEvents = events.filter(
    (e) => e.type === "tool_call" || e.type === "verify" || e.type === "finalize" || e.isError,
  );

  if (keyEvents.length > 0) {
    lines.push("Key events:");
    for (const ev of keyEvents) {
      const prefix = ev.isError ? "  [ERROR]" : `  [${ev.type}]`;
      const detail = ev.detail ? ` — ${ev.detail}` : "";
      lines.push(`${prefix} ${ev.summary}${detail}`);
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

// ── Analysis prompt ───────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM_PROMPT = `You are analyzing pi coding assistant sessions. You will receive compressed summaries of multiple sessions and a question about them.

For each session, provide:
1. What the session accomplished
2. Key patterns in tool usage or behavior
3. Any notable failures or errors
4. How the session outcome relates to the question

Then synthesize across sessions to answer the question. Be specific and reference session dates and paths.`;

// ── Batch analysis ────────────────────────────────────────────────────────────

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
    windowedParts.push(`\n[... ${summaries.length - includedCount} session(s) omitted due to length ...]\n`);
  }

  return { text: windowedParts.join("\n"), windowed: true };
}