/**
 * Standard tool result types — shared result metadata for all tools.
 *
 * Every tool returns `{ content, details }`. The `details` field is ad-hoc
 * per tool. This module defines a standard envelope that metacognition tools
 * should include, providing self-awareness and enable downstream consumers
 * to make decisions based on the agent's own output.
 */

/**
 * Standard metadata that reasoning tools should include in their `details`.
 * Not all fields apply to every tool; omitted fields are undefined.
 */
export interface ToolResultMeta {
  /** How confident the agent is in this result (0-1). */
  confidence?: number;
  /** Number of alternatives considered during reasoning. */
  alternativesConsidered?: number;
  /** Tool name the agent might want to call next. */
  suggestedNextTool?: string;
  /** IDs of related memories that informed this result. */
  relatedMemoryIds?: string[];
}

/**
 * Wrap a tool's return value with standard metadata.
 * The `content` array is passed through verbatim.
 */
export function withMeta<T extends { content: unknown[] }>(
  result: T,
  meta: ToolResultMeta,
): T & { details: ToolResultMeta & Record<string, unknown> } {
  return {
    ...result,
    details: {
      ...(result as any).details,
      ...meta,
    },
  } as any;
}
