/**
 * Text extraction helpers for session-recall.
 *
 * Pure functions - no dependencies on session-recall's internal state.
 *
 * Used by the session search and query actions to:
 *   - extractMessageText: parse a single live .jsonl entry into {role, text}
 *   - extractLineMessages: parse any .jsonl line — a live entry OR a
 *     compaction-archive envelope — into every message it carries
 *   - snippetAround: extract a keyword-anchored window from a long text
 *   - estimateTokens: rough token count (1 token ~= 4 chars)
 */

/**
 * Cap on messages parsed from one archive line. A single compaction envelope
 * holds the entire pre-compaction batch as one JSON string and is one physical
 * line regardless of size; measured archives carry up to 1188 messages (139
 * archives, p99=1005, max line 3.4 MB). The cap bounds a pathological envelope
 * without truncating the measured corpus, and callers surface `truncated`
 * rather than presenting a partial read as complete.
 */
export const MAX_ARCHIVE_MESSAGES = 2000;

export interface ExtractedMessage {
  role: string;
  text: string;
}

export interface LineMessages {
  messages: ExtractedMessage[];
  /** True when the line was a compaction-archive envelope, not a live entry. */
  isArchive: boolean;
  /** True when the envelope held more messages than MAX_ARCHIVE_MESSAGES. */
  truncated: boolean;
  /** Messages the line carries (envelope: originals length; live: 0 or 1). */
  totalMessages: number;
  /** Envelope provenance counters; present only on archive lines. */
  compactedMessages?: number;
  keptMessages?: number;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type?: string; text?: string } => !!c && typeof c === "object")
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
}

/** Extract {role, text} from a raw message object ({role, content: [...]}). */
function messageFromObject(msg: unknown): ExtractedMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { role?: unknown; content?: unknown };
  const text = textFromContent(m.content);
  if (!text) return null;
  return { role: typeof m.role === "string" ? m.role : "unknown", text };
}

/**
 * pi's role for extension-injected `custom_message` entries ("CustomMessage"
 * in message-types.md). Their content is a string or a text/image block
 * array, not the `message.content` array ordinary entries carry.
 */
const CUSTOM_MESSAGE_ROLE = "custom";

function messageFromCustomMessage(entry: { content?: unknown }): ExtractedMessage | null {
  const content = entry.content;
  const text =
    typeof content === "string" ? content : Array.isArray(content) ? textFromContent(content) : "";
  if (!text) return null;
  return { role: CUSTOM_MESSAGE_ROLE, text };
}

// Compaction and branch summaries are deliberately not indexed: both are
// model-generated condensations of entries that remain in the file (or in the
// archive), and neither carries a message role, so indexing them would
// duplicate recall and invent a role the transcript does not have.
function messageFromEntry(entry: unknown): ExtractedMessage | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { type?: unknown; message?: unknown; content?: unknown };
  if (e.type === "message") return messageFromObject(e.message);
  if (e.type === "custom_message") return messageFromCustomMessage(e);
  return null;
}

/**
 * Parse a single .jsonl line and extract the message text.
 *
 * Returns null for entries that carry no message text (tool calls, metadata,
 * durable `custom` entries), for archive envelopes (use extractLineMessages
 * for those), or for lines without extractable text content. Ordinary
 * `message` entries and extension-injected `custom_message` entries both
 * yield a message; the `role` is returned so callers can distinguish them.
 */
export function extractMessageText(jsonLine: string): { role: string; text: string } | null {
  try {
    return messageFromEntry(JSON.parse(jsonLine));
  } catch {
    return null;
  }
}

/**
 * Parse one .jsonl line into every message it carries.
 *
 * A live line is one entry (`{type:"message", message:{role,content}}` or
 * `{type:"custom_message", content}`) → 0 or 1 message. An archives/*.jsonl line is a compaction envelope whose
 * `originals` field is a JSON string holding the pre-compaction message array
 * (written by context-manager's writeOriginalsArchive) → 0..N messages. The
 * envelope is ONE physical line however many messages it holds, so callers
 * that snippet per line must iterate the returned array; a search line that
 * matches only inside a large archive would otherwise render nothing.
 */
export function extractLineMessages(jsonLine: string): LineMessages {
  let entry: unknown;
  try {
    entry = JSON.parse(jsonLine);
  } catch {
    return { messages: [], isArchive: false, truncated: false, totalMessages: 0 };
  }
  if (
    entry &&
    typeof entry === "object" &&
    typeof (entry as { originals?: unknown }).originals === "string"
  ) {
    return extractArchiveEnvelope(
      entry as { originals: string; compactedMessages?: unknown; keptMessages?: unknown },
    );
  }
  const msg = messageFromEntry(entry);
  return {
    messages: msg ? [msg] : [],
    isArchive: false,
    truncated: false,
    totalMessages: msg ? 1 : 0,
  };
}

function extractArchiveEnvelope(entry: {
  originals: string;
  compactedMessages?: unknown;
  keptMessages?: unknown;
}): LineMessages {
  const base = {
    isArchive: true,
    truncated: false,
    totalMessages: 0,
    compactedMessages:
      typeof entry.compactedMessages === "number" ? entry.compactedMessages : undefined,
    keptMessages: typeof entry.keptMessages === "number" ? entry.keptMessages : undefined,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.originals);
  } catch {
    return { ...base, messages: [] };
  }
  if (!Array.isArray(parsed)) return { ...base, messages: [] };
  const total = parsed.length;
  const truncated = total > MAX_ARCHIVE_MESSAGES;
  const scan = truncated ? parsed.slice(0, MAX_ARCHIVE_MESSAGES) : parsed;
  const messages = scan
    .map((m) => messageFromObject(m))
    .filter((m): m is ExtractedMessage => m !== null);
  return { ...base, messages, truncated, totalMessages: total };
}

/**
 * Messages a compaction-archive envelope carries, counting the stored payload
 * only. `extractLineMessages` materialises every archived message's text, which
 * a count does not need: the envelope's `originals` array length is the count.
 * Returns 0 for live lines and for envelopes that cannot be parsed.
 */
export function countArchivedMessages(jsonLine: string): number {
  try {
    const entry = JSON.parse(jsonLine) as { originals?: unknown };
    if (typeof entry.originals !== "string") return 0;
    const parsed: unknown = JSON.parse(entry.originals);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Extract a window of `radius` characters around the first occurrence
 * of `keyword` (case-insensitive). If the keyword isn't found,
 * returns the first `radius * 2` characters of the text.
 */
export function snippetAround(text: string, keyword: string, radius = 100): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end) + suffix;
}

/**
 * Rough token count. 1 token ~= 4 chars (English text average).
 * This is intentionally crude - we use it to decide whether a
 * session transcript is too long to include in full.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
