/**
 * Text similarity utilities for redundancy detection.
 *
 * Tokenizes text into lines and computes Jaccard similarity.
 * Tracks known file contents across turns for detectRedundancySignal.
 */

import * as fs from "node:fs/promises";
import * as path from "path";

// ── Simple Text Similarity ────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function computeSimilarity(text1: string, text2: string): number {
  const set1 = tokenize(text1);
  const set2 = tokenize(text2);
  return jaccardSimilarity(set1, set2);
}

// ── File Content Tracking ────────────────────────────────────────────────────

export interface KnownFileEntry {
  content: string;
  turn: number;
}

/** Map of file path -> { content, turn } */
export const knownFiles = new Map<string, KnownFileEntry>();

export async function loadFileContent(filePath: string): Promise<string | null> {
  try {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) return null;
    } catch {
      return null;
    }
    return await fs.readFile(resolvedPath, "utf-8");
  } catch {
    return null;
  }
}

export async function detectRedundancy(newContent: string, newPath: string): Promise<string | null> {
  const SIMILARITY_THRESHOLD = 0.7;

  for (const [existingPath, { content: existingContent }] of knownFiles) {
    if (existingPath === newPath) continue;
    const similarity = computeSimilarity(newContent, existingContent);
    if (similarity >= SIMILARITY_THRESHOLD) {
      return existingPath;
    }
  }
  return null;
}
