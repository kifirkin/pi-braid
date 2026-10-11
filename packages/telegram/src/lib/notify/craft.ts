/**
 * turn-complete notify — pure crafting logic.
 *
 * Pure, unit-testable without pi-core runtime or any LLM:
 *  - shouldNotifyTurnEnd  — decide whether a turn_end event warrants a notify
 *  - extractFinalText     — pull the assistant's final text out of the event
 *  - buildNotifyPrompts   — the distilling prompt (system + user)
 *  - truncateGuard        — the ≤ notifyMaxChars guard-fallback: the crafting
 *                           model PRODUCES the message; this stays only as a
 *                           safety net (default: braid.telegram.notifyMaxChars,
 *                           1200 when unset).
 *
 * Turn-end payload (VERIFIED against pi-core dist/core/extensions/types.d.ts):
 *   TurnEndEvent { type: "turn_end", turnIndex, message, toolResults }
 *   — NO separate toolCalls flag. A "trailing tool call" turn is detected by
 *     message.stopReason === "toolUse" (the model's last action was emitting a
 *     tool call, so work continues next turn). A completed answer turn has
 *     stopReason "stop" (or length/error) with text content.
 *
 * The notify model call reuses "our systems" (not the bot token): it goes
 * through ctx.modelRegistry (which pi-braid-providers wires to the key-ring
 * via auth.apiKey.resolve), mirroring the extension→LLM path that core's
 * llm-call.ts wraps (completeSimple from @earendil-works/pi-ai/compat).
 */

import { DEFAULT_NOTIFY_MAX_CHARS } from "../telegram-settings.js";

/** Which turns notify: only completed-answer turns (plain text, no trailing
 *  tool call). Never notify while the agent is mid-work. */
export function shouldNotifyTurnEnd(event: unknown): boolean {
  const message = (
    event as {
      message?: { role?: unknown; stopReason?: unknown; content?: unknown };
    }
  )?.message;
  if (!message || typeof message !== "object") return false;
  if (message.role !== "assistant") return false;
  // "toolUse" stopReason = the model's last action was a tool call → the turn
  // did NOT complete with an answer (work continues next turn). Skip notify.
  if (message.stopReason === "toolUse") return false;
  return extractFinalTextFromContent(message.content).trim().length > 0;
}

/** Inspect an assistant message's content for its final text. */
function extractFinalTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | undefined;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * Is this a terminal turn WITH NO REPORT — i.e. the task is over without an
 * answer? Canonical terminal-non-completed detection (context-manager
 * handlers/events.ts: lastAssistant.stopReason is neither "error" nor
 * "aborted") — do NOT re-derive it here. Concretely:
 *  - last assistant stopReason "error" or "aborted" → terminal, no report;
 *  - no assistant message at all → terminal, no report;
 *  - stopReason "toolUse" (or anything else non-terminal) → work continues
 *    next turn — the live-update indicator must STAY active.
 */
export function isTerminalNoReportTurn(event: unknown): boolean {
  const message = (
    event as { message?: { role?: unknown; stopReason?: unknown } }
  )?.message;
  if (!message || typeof message !== "object") return true; // no assistant message → no report
  if (message.role !== "assistant") return true; // turn ended without an assistant report
  if (message.stopReason === "toolUse") return false; // work continues next turn
  return message.stopReason === "error" || message.stopReason === "aborted";
}

/** The final assistant text of a turn ("" when absent). */
export function extractFinalText(event: unknown): string {
  const message = (event as { message?: { content?: unknown } })?.message;
  if (!message || typeof message !== "object") return "";
  return extractFinalTextFromContent(message.content);
}

/**
 * Build the distilling prompt for the crafting model.
 *
 * The model receives the agent's final answer and must produce an owner-ready
 * update, at most `maxLength` chars (the configured notifyMaxChars — default
 * 1200). No greetings, no filler, no markdown noise.
 */
export function buildNotifyPrompts(
  finalText: string,
  maxLength: number = DEFAULT_NOTIFY_MAX_CHARS,
): {
  system: string;
  user: string;
} {
  const system =
    "You distill an AI assistant's finished response into ONE concise, " +
    `plain-text update for its human operator. Rules:\n` +
    `- At most ${maxLength} characters — complete and readable, never a clipped fragment.\n` +
    `- State what was done / the key result. No greetings, no sign-off, no filler.\n` +
    `- Plain text only: no markdown formatting, no bullet lists.\n` +
    `- If the response has no actionable content, reply with the single word: DONE.`;
  const user = `Agent's finished response:\n\n${finalText.slice(0, 4000)}`;
  return { system, user };
}

/** Delivered-format choice threaded into the rich-summary craft prompt. */
export type NotifyFormat = "HTML" | "Markdown";

/**
 * Build the rich summary prompt for the live-update final report.
 * Unlike the concise notify prompt, this one FLAGS the model to produce
 * structured formatting (`mode`) and to make the report as long as needed —
 * split-to-fit handles the 4096-char cap downstream. `mode` is threaded into
 * the prompt (not just the transport) so the model emits the right markup
 * from the start instead of the delivery layer guessing. Defaults to
 * "Markdown".
 */
export function buildRichSummaryPrompts(
  finalText: string,
  mode: NotifyFormat = "Markdown",
): { system: string; user: string } {
  const formatting =
    mode === "HTML"
      ? "- Use Telegram HTML: <b>bold</b> headings, <i>italic</i>, <code>code</code>, short sections.\n" +
        "- Telegram HTML only: NO raw Markdown (no **, _, `, [#](url)) — HTML tags only.\n"
      : "- Use Telegram Markdown: **bold** headings, bullet lists, short sections.\n" +
        "- Telegram Markdown only: **bold**, _italic_, `code` — no raw HTML, no fences.\n";
  const system =
    "You turn an AI assistant's finished response into a beautiful, structured " +
    "Telegram report for its human operator. Rules:\n" +
    formatting +
    "- Keep it readable on mobile: short paragraphs; lists over prose walls.\n" +
    "- Lead with what was done, then key results, then any follow-ups.\n" +
    "- No title banner, no sign-off, no filler — length as needed (split-to-fit handles the 4096 cap).";
  const user = `Agent's finished response:\n\n${finalText.slice(0, RICH_SUMMARY_INPUT_MAX)}`;
  return { system, user };
}

/** Max response chars fed to the rich-summary crafting model. */
export const RICH_SUMMARY_INPUT_MAX = 12_000;

/**
 * Guard-fallback: hard-truncate to `maxLen` with an ellipsis. Used when the
 * crafting model is unavailable or returns something malformed — the cap is a
 * safety net, never the primary shortening path.
 */
export function truncateGuard(
  text: string,
  maxLen: number = DEFAULT_NOTIFY_MAX_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const head = trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd();
  return head + "…";
}
