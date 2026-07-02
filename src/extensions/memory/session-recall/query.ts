/**
 * Session Recall - query functions
 *
 * LLM-driven analysis of a specific session file.
 */

import { readFile } from "node:fs/promises";
import * as import_textUtils from "./text-utils.js";

const extractMessageText = import_textUtils.extractMessageText;

// ── Session Loading ───────────────────────────────────────────────────────────

export async function loadSessionMessages(
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

export function serializeSession(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

// ── Query Prompt ──────────────────────────────────────────────────────────────

export const QUERY_SYSTEM_PROMPT = `You are analyzing a past pi coding assistant conversation.
Answer the user's question based on the conversation transcript.
Be specific and reference relevant parts of the conversation.
If the conversation doesn't contain enough information, say so.`;