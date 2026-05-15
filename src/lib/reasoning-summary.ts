/**
 * Reasoning Chain Summarization (2604.15877) — Medium-Term Compression
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";
import { createLogger } from "./logger.js";
const log = createLogger("reasoning-summary");

const REASONING_PATTERNS = [
  /\bI think\b/i,
  /\bLet me\b/i,
  /\bPerhaps\b/i,
  /\bHowever\b/i,
  /\bTherefore\b/i,
  /\bFirst\b.*then\b/i,
  /\bSo\b.*because\b/i,
  /\bLet me analyze\b/i,
  /\bThe approach\b/i,
  /\bI need to\b/i,
  /\bBased on\b.*I\b/i,
  /\bLooking at\b.*we can\b/i,
];

export function isReasoningMessage(msg: { role: string; content?: string | unknown[] }): boolean {
  if (msg.role !== "assistant" || !msg.content) return false;
  const content =
    typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text ?? "").join(" ")
        : "";
  if (content.trim().length < 20) return false;
  if (Array.isArray(msg.content) && msg.content.some((c: any) => c.type === "toolCall")) {
    return REASONING_PATTERNS.filter((p) => p.test(content)).length >= 2;
  }
  return REASONING_PATTERNS.some((p) => p.test(content));
}

export function findReasoningBlocks(
  messages: Array<{ role: string; content?: string | unknown[]; turn?: number }>,
  minBlockSize = 3,
): Array<{
  startIndex: number;
  endIndex: number;
  messages: Array<{ role: string; content: string; turn: number }>;
}> {
  const blocks: any[] = [];
  let current: any = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isReasoningMessage(msg as any)) {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text ?? "").join(" ")
            : "";
      if (!current) current = { startIndex: i, endIndex: i, messages: [] };
      current.endIndex = i;
      current.messages.push({
        role: msg.role,
        content: content.slice(0, 500),
        turn: msg.turn ?? i,
      });
    } else if (current && current.messages.length >= minBlockSize) {
      blocks.push(current);
      current = null;
    } else {
      current = null;
    }
  }
  if (current && current.messages.length >= minBlockSize) blocks.push(current);
  return blocks;
}

export function extractReasoningSummary(block: any): string {
  const last = block.messages[block.messages.length - 1]?.content ?? "";
  const tools = [...new Set([...(last.match(/`([a-z]+)`\(/g) ?? [])])]
    .map((t: string) => t.slice(1, -2))
    .slice(0, 5);
  const summary = `Reasoning chain (${block.messages.length} steps): ${last.slice(0, 500)}${tools.length ? ` [Tools: ${tools.join(", ")}]` : ""}`;
  return summary.length > 600 ? summary.slice(0, 600) + "..." : summary;
}

export function estimateTokensSaved(block: any): number {
  const total = block.messages.reduce(
    (s: number, m: any) => s + m.content.split(/\s+/).length * 1.33,
    0,
  );
  const last = block.messages[block.messages.length - 1];
  const summary = last ? last.content.split(/\s+/).length * 1.33 : 50;
  return Math.max(0, total - summary);
}

export function shouldSummarizeReasoning(ctx: ExtensionContext): boolean {
  const state = getExtensionState(ctx, "reasoning-compression", () => ({
    localTurnCount: 0,
    lastSummaryTurn: 0,
    summarizedCount: 0,
  }));
  state.localTurnCount++;
  return state.localTurnCount - state.lastSummaryTurn > 20 && state.summarizedCount < 10;
}

export function recordSummarization(ctx: ExtensionContext, block: any, tokensSaved: number): void {
  const state = getExtensionState(ctx, "reasoning-compression", () => ({
    localTurnCount: 0,
    lastSummaryTurn: 0,
    summarizedCount: 0,
    totalTokensSaved: 0,
    chainDepth: 0,
  }));
  state.localTurnCount++;
  state.summarizedCount++;
  state.totalTokensSaved += tokensSaved;
  state.lastSummaryTurn = state.localTurnCount;
  state.chainDepth = Math.max(state.chainDepth, block.messages.length);
  log.debug(
    `Reasoning summarized: ${block.messages.length} steps → ${Math.round(tokensSaved)} tokens saved`,
  );
}
