/**
 * Session Recall - query functions
 *
 * LLM-driven analysis of a specific session file.
 */

import { readFile } from "node:fs/promises";
import * as import_textUtils from "./text-utils.js";

const extractLineMessages = import_textUtils.extractLineMessages;

export async function loadSessionMessages(
  sessionPath: string,
): Promise<Array<{ role: string; content: string }>> {
  const messages: Array<{ role: string; content: string }> = [];

  try {
    const content = await readFile(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      // A live line is one message; an archives/*.jsonl line is a compaction
      // envelope holding the pre-compaction batch inside `originals` — without
      // this parse the query path reads 0 messages for an archived session.
      const parsed = extractLineMessages(line);
      for (const msg of parsed.messages) {
        messages.push({ role: msg.role, content: msg.text });
      }
    }
  } catch {
    // Unreadable/partial session file — return the messages parsed so far
    // instead of failing the whole recall.
  }

  return messages;
}

export function serializeSession(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

export const QUERY_SYSTEM_PROMPT = `You are analyzing a past pi coding assistant conversation.
Answer the user's question based on the conversation transcript.
Be specific and reference relevant parts of the conversation.
If the conversation doesn't contain enough information, say so.`;
