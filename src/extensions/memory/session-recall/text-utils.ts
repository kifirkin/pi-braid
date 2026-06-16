/**
 * Text extraction helpers for session-recall.
 *
 * Extracted from index.ts. Pure functions - no dependencies on
 * session-recall's internal state. Safe to test in isolation.
 *
 * Used by the session query action to:
 *   - extractMessageText: parse a single .jsonl line into {role, text}
 *   - snippetAround: extract a keyword-anchored window from a long text
 *   - estimateTokens: rough token count (1 token ~= 4 chars)
 */

/**
 * Parse a single .jsonl line and extract the message text.
 *
 * Returns null for non-message entries (e.g., tool calls, metadata)
 * or for lines that don't have extractable text content. The `role`
 * is returned so callers can distinguish user vs assistant messages.
 */
export function extractMessageText(
  jsonLine: string,
): { role: string; text: string } | null {
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
