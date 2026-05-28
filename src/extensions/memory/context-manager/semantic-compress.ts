/**
 * Semantic Compression Prototype (2604.15877)
 * Compress at the semantic level — not just syntactic. Different content
 * types need different compression strategies.
 *
 * Input: raw `AgentMessage[]` from the pi context event.
 * Output: compressed `AgentMessage[]` for the next pipeline stage.
 *
 * Unit Types:
 *   problem    — What we're solving. PRESERVE fully.
 *   reasoning  — How we're thinking. PRESERVE key decisions, trim intermediate.
 *   tool       — What we're doing. COLLAPSE repetitions, keep last result+count.
 *   result     — What worked. PRESERVE key outcomes.
 *   summary    — What we concluded. PRESERVE entirely.
 *   boilerplate — Noise. DROP.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createLogger } from "../../../lib/core/logger.js";
import type { CompressionLevel } from "../../../lib/detection/compression-strategy.js";
const log = createLogger("semantic-compress");

export type SemanticUnitType =
  | "problem"
  | "reasoning"
  | "tool"
  | "result"
  | "summary"
  | "boilerplate";

export interface SemanticUnit {
  type: SemanticUnitType;
  startIndex: number;
  endIndex: number;
  messages: AgentMessage[];
  preserve: boolean;
  collapse: boolean;
  priority: number; // 0=drop, 1=collapsible, 2=preservable, 3=essential
}

export interface CompressionStats {
  messagesIn: number;
  messagesOut: number;
  unitsPreserved: number;
  unitsCollapsed: number;
  unitsDropped: number;
  /** Which compression level was used (if adaptive). */
  level?: CompressionLevel;
}

const UNIT_PATTERNS: Array<{ type: SemanticUnitType; patterns: RegExp[]; priority: number }> = [
  {
    type: "problem",
    patterns: [
      /\bI need to\b.*\bimplement\b/i,
      /\bCan you\b/i,
      /\bPlease\b.*\bcreate\b/i,
      /\bHelp me\b/i,
      /\brequirement\b/i,
    ],
    priority: 3,
  },
  {
    type: "reasoning",
    patterns: [
      /\bI think\b/i,
      /\bLet me\b/i,
      /\bPerhaps\b/i,
      /\bTherefore\b/i,
      /\bMy reasoning\b/i,
      /\bBased on\b/i,
    ],
    priority: 2,
  },
  {
    type: "result",
    patterns: [
      /\bSuccess\b/i,
      /\bCompleted\b/i,
      /\bAll tests pass\b/i,
      /\bBuild complete\b/i,
      /\bNo errors\b/i,
    ],
    priority: 2,
  },
  {
    type: "summary",
    patterns: [/\bIn summary\b/i, /\bTo summarize\b/i, /\bKey takeaways\b/i, /\bNext steps\b/i],
    priority: 3,
  },
  {
    type: "boilerplate",
    patterns: [
      /^\s{0,10}$/,
      /\bSure,?\b/i,
      /\bOf course\b/i,
      /\bHere is\b.*for you\b/i,
      /\bLet me show you\b/i,
    ],
    priority: 0,
  },
];

/**
 * Classify a message's semantic type.
 * Handles both raw AgentMessage (from context event) and wrapped format.
 */
export function classifyMessage(msg: {
  role?: string;
  content?: unknown[] | string | null;
  isError?: boolean;
}): { type: SemanticUnitType; priority: number } {
  const role = msg.role;
  if (!role) return { type: "tool", priority: 1 };

  if (role === "toolResult") {
    return { type: "result", priority: 2 };
  }
  if (role === "assistant") {
    const text = extractText(msg);
    for (const { type, patterns, priority } of UNIT_PATTERNS) {
      if (patterns.some((p) => p.test(text))) return { type, priority };
    }
  }
  if (role === "user") return { type: "problem", priority: 3 };
  return { type: "tool", priority: 1 };
}

function extractText(msg: any): string {
  if (!msg?.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((c: any) => c.text ?? "").join(" ");
  return "";
}

/**
 * Group consecutive messages of the same semantic type into units.
 */
export function identifySemanticUnits(messages: AgentMessage[]): SemanticUnit[] {
  if (messages.length === 0) return [];
  const units: SemanticUnit[] = [];
  let current: SemanticUnit | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const { type, priority } = classifyMessage(msg);

    if (!current || current.type !== type) {
      if (current) {
        current.endIndex = i - 1;
        units.push(current);
      }
      current = {
        type,
        startIndex: i,
        endIndex: i,
        messages: [msg],
        preserve: priority >= 3,
        collapse: priority >= 1 && priority < 3,
        priority,
      };
    } else {
      current.endIndex = i;
      current.messages.push(msg);
    }
  }
  if (current) {
    current.endIndex = messages.length - 1;
    units.push(current);
  }
  return units;
}

/**
 * Collapse consecutive tool calls of the same name into one with a count annotation.
 */
function compressToolUnit(unit: SemanticUnit): AgentMessage[] {
  if (unit.messages.length <= 1) return unit.messages;
  const byTool = new Map<string, AgentMessage[]>();
  for (const msg of unit.messages) {
    const toolName = (msg as { toolName?: string }).toolName ?? "unknown";
    if (!byTool.has(toolName)) byTool.set(toolName, []);
    byTool.get(toolName)!.push(msg);
  }
  const result: AgentMessage[] = [];
  for (const [, toolMsgs] of byTool) {
    if (toolMsgs.length === 1) {
      result.push(toolMsgs[0]);
    } else {
      const last = toolMsgs[toolMsgs.length - 1];
      (last as unknown as Record<string, unknown>)._bcrCount = toolMsgs.length;
      result.push(last);
    }
  }
  return result;
}

/**
 * Semantically compress a message array.
 * Preserves: problem statements, key decisions, critical failures, summaries.
 * Collapses: repeated patterns, verbose outputs, boilerplate.
 *
 * @param messages - Messages to compress
 * @param compressionLevel - Optional adaptive compression level:
 *   "short-term": conservative, preserve most content
 *   "medium-term": moderate, collapse reasoning + tool chains
 *   "long-term": aggressive, drop low-priority content heavily
 *   Default (undefined): standard compression (behaves like medium-term)
 */
export function semanticCompress(
  messages: AgentMessage[],
  compressionLevel?: CompressionLevel,
): {
  compressed: AgentMessage[];
  units: SemanticUnit[];
  stats: CompressionStats;
} {
  if (messages.length === 0) {
    return {
      compressed: [],
      units: [],
      stats: {
        messagesIn: 0,
        messagesOut: 0,
        unitsPreserved: 0,
        unitsCollapsed: 0,
        unitsDropped: 0,
      },
    };
  }

  const units = identifySemanticUnits(messages);
  const compressed: AgentMessage[] = [];
  let unitsPreserved = 0;
  let unitsCollapsed = 0;
  let unitsDropped = 0;

  // Determine minimum priority to keep and collapse thresholds based on level
  const minKeepPriority = compressionLevel === "long-term" ? 2 : 0;
  const reasoningCollapseLen =
    compressionLevel === "short-term" ? 5 : compressionLevel === "long-term" ? 2 : 3;
  const toolCollapseThreshold =
    compressionLevel === "short-term" ? 5 : compressionLevel === "long-term" ? 2 : 3;

  for (const unit of units) {
    // Stage 1: Filter by minimum priority
    if (unit.priority < minKeepPriority) {
      unitsDropped++;
      continue;
    }

    if (!unit.preserve && !unit.collapse) {
      unitsDropped++;
      continue;
    }

    let processed: AgentMessage[];
    if (unit.preserve) {
      processed = unit.messages;
    } else if (unit.type === "tool") {
      // Tool unit: compressToolUnit then check threshold
      processed = compressToolUnit(unit);
      // If the result is still long and we're being aggressive, keep only the last
      if (compressionLevel === "long-term" && processed.length > 3) {
        processed = [processed[processed.length - 1]];
      } else if (compressionLevel === "medium-term" && processed.length > toolCollapseThreshold) {
        processed = [processed[processed.length - 1]];
      }
    } else if (unit.type === "reasoning" && unit.messages.length > reasoningCollapseLen) {
      // Reasoning unit: keep first + last (problem → solution)
      // For long-term: also trim if the first+last alone are long
      const kept = [unit.messages[0], unit.messages[unit.messages.length - 1]];
      if (compressionLevel === "long-term" && kept.length > 1) {
        // Also trim kept to single message if both are verbose
        processed = [kept[kept.length - 1]];
      } else {
        processed = kept;
      }
    } else if (unit.type === "boilerplate") {
      const text = extractText(unit.messages[0]);
      if (compressionLevel === "long-term") {
        // Drop all boilerplate in long-term mode
        processed = text.length > 100 ? [unit.messages[0]] : [];
      } else {
        processed = text.length > 50 ? [unit.messages[0]] : [];
      }
    } else {
      processed = unit.messages;
    }

    if (processed.length === 0) {
      unitsDropped++;
    } else if (processed.length < unit.messages.length) {
      unitsCollapsed++;
      compressed.push(...processed);
    } else {
      unitsPreserved++;
      compressed.push(...processed);
    }
  }

  log.debug(
    `semantic-compress[${compressionLevel ?? "standard"}]: ` +
      `${messages.length} msgs → ${compressed.length} msgs ` +
      `(${unitsPreserved} preserved, ${unitsCollapsed} collapsed, ${unitsDropped} dropped)`,
  );

  return {
    compressed,
    units,
    stats: {
      messagesIn: messages.length,
      messagesOut: compressed.length,
      unitsPreserved,
      unitsCollapsed,
      unitsDropped,
      level: compressionLevel,
    },
  };
}
