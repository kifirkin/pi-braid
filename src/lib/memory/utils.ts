/**
 * Cognitive Memory - utility functions.
 *
 * Pure functions for formatting, parsing, auto-tagging, and ID generation.
 */

import type { CognitiveMemoryEntry, MemoryContext } from "./types.js";
import { nextId } from "../utils/id.js";

/**
 * Format timestamp for display
 */
export function formatMemoryTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Format memory entry for display.
 */
export function formatMemoryEntry(memory: CognitiveMemoryEntry, full = false): string {
  const time = formatMemoryTimestamp(memory.timestamp);
  const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
  const expired = memory.expiresAt && Date.now() > memory.expiresAt ? " [EXPIRED]" : "";

  if (full) {
    const source = memory.source ? `\n  Source: ${memory.source}` : "";
    const utility = ` (utility: ${memory.utility.toFixed(2)})`;
    let contextStr = "";
    if (memory.context) {
      if (memory.context.files?.length) {
        contextStr += `\n  Files: ${memory.context.files.join(", ")}`;
      }
      if (memory.context.error?.message) {
        contextStr += `\n  Error: ${memory.context.error.message}`;
      }
      if (memory.context.solution) {
        contextStr += `\n  Solution: ${memory.context.solution}`;
      }
    }
    let relatedStr = "";
    if (memory.related?.length) {
      relatedStr = `\n  Related: ${memory.related.map((r) => `${r.type}:${r.id.slice(0, 8)}`).join(", ")}`;
    }
    return (
      `[${memory.type}] ID: ${memory.id} ${time}${tags}${expired}${utility}\n  ${memory.content}` +
      contextStr +
      relatedStr +
      source
    );
  }

  const preview =
    memory.content.length > 300 ? `${memory.content.slice(0, 300)}...` : memory.content;
  return `[${memory.type}] ${memory.id} ${time}${tags}${expired} - ${preview}`;
}

/**
 * Parse structured content from a JSON string.
 */
export function parseStructuredContent(content: string): {
  summary: string;
  context?: MemoryContext;
} {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      return {
        summary: parsed.summary || parsed.description || JSON.stringify(parsed).slice(0, 100),
        context: {
          files: parsed.files || parsed.file ? [parsed.files || parsed.file].flat() : undefined,
          error:
            parsed.error || parsed.stack
              ? {
                  message: parsed.error?.message || parsed.error,
                  stack: parsed.stack,
                  code: parsed.code,
                }
              : undefined,
          solution: parsed.solution || parsed.fix || parsed.resolution,
          ...parsed,
        },
      };
    }
  } catch {
    // Not JSON, return as-is
  }
  return { summary: content };
}

/**
 * Compute Jaccard similarity between two strings (word-level).
 * Returns 0-1 where 1 = identical word sets.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Auto-generate tags from content and context.
 */
export function generateAutoTags(content: string, context?: MemoryContext): string[] {
  const tags: Set<string> = new Set();

  const extMatches = content.match(/\.([a-z]+):/gi);
  if (extMatches) {
    extMatches.forEach((m) => {
      const ext = m.slice(1, -1);
      if (ext.length <= 5) tags.add(ext);
    });
  }

  const nameMatches = content.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+/g);
  if (nameMatches) {
    nameMatches.slice(0, 2).forEach((n) => tags.add(n));
  }

  if (context?.files?.length) {
    context.files.forEach((f) => {
      const ext = f.split(".").pop();
      if (ext && ext.length <= 5) tags.add(ext);
    });
  }

  if (context?.error) {
    tags.add("error");
    if (context.error.code) tags.add(context.error.code);
  }

  return Array.from(tags);
}

/**
 * Generate a unique ID for a memory entry.
 */
export function generateId(): string {
  return nextId('mem');
}
