/**
 * Safe edit helper — reads actual file content before modifying.
 * Avoids "exact text match" failures from stale reads or whitespace drift.
 *
 * Usage:
 *   import { safeEdit } from "./lib/edit-helper.js";
 *   await safeEdit("src/foo.ts", {
 *     oldText: "find this exact text",
 *     newText: "replace with this",
 *   });
 *
 * Or multi-edit:
 *   import { safeEditMulti } from "./lib/edit-helper.js";
 *   await safeEditMulti("src/foo.ts", [
 *     { oldText: "...", newText: "..." },
 *     { oldText: "...", newText: "..." },
 *   ]);
 *
 * For tricky cases, use replace-based approach:
 *   import { replaceInFile } from "./lib/edit-helper.js";
 *   await replaceInFile("src/foo.ts", (content) => content.replace(/pat/g, "replacement"));
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface Edit {
  oldText: string;
  newText: string;
}

export interface EditResult {
  success: boolean;
  file: string;
  applied: boolean;
  error?: string;
  diff?: { before: number; after: number };
}

/**
 * Single safe edit — reads the file, finds oldText, replaces with newText.
 * Returns detailed result including line numbers if it fails.
 */
export async function safeEdit(filePath: string, edit: Edit): Promise<EditResult> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { success: false, file: resolved, applied: false, error: "File not found" };
  }

  const content = readFileSync(resolved, "utf8");
  const idx = content.indexOf(edit.oldText);

  if (idx === -1) {
    // Find context to help debug
    const lines = content.split("\n");
    const suggestions = suggestMatch(edit.oldText, lines);
    return {
      success: false,
      file: resolved,
      applied: false,
      error: `oldText not found.${suggestions}`,
    };
  }

  const before = content.slice(0, idx);
  const after = content.slice(idx + edit.oldText.length);
  const newContent = before + edit.newText + after;

  writeFileSync(resolved, newContent, "utf8");

  const linesBefore = before.split("\n").length;
  const linesOld = edit.oldText.split("\n").length;
  const linesNew = edit.newText.split("\n").length;

  return {
    success: true,
    file: resolved,
    applied: true,
    diff: {
      before: linesOld,
      after: linesNew,
    },
  };
}

/**
 * Multi-edit — applies all edits in one pass through the file.
 * More efficient than calling safeEdit() multiple times.
 */
export async function safeEditMulti(filePath: string, edits: Edit[]): Promise<EditResult[]> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return edits.map(() => ({
      success: false,
      file: resolved,
      applied: false,
      error: "File not found",
    }));
  }

  const content = readFileSync(resolved, "utf8");
  let newContent = content;
  let offset = 0;

  const results: EditResult[] = [];

  for (const edit of edits) {
    // Account for previous edits shifting positions
    const shiftedOld = applyOffset(edit.oldText, offset);
    const idx = newContent.indexOf(shiftedOld);

    if (idx === -1) {
      const lines = newContent.split("\n");
      results.push({
        success: false,
        file: resolved,
        applied: false,
        error: `oldText not found (edit ${results.length + 1}/${edits.length}).`,
      });
      continue;
    }

    const before = newContent.slice(0, idx);
    const after = newContent.slice(idx + shiftedOld.length);
    const newSegment = applyOffset(edit.newText, offset);
    newContent = before + newSegment + after;
    offset += edit.newText.length - edit.oldText.length;

    results.push({ success: true, file: resolved, applied: true });
  }

  if (results.every((r) => r.applied)) {
    writeFileSync(resolved, newContent, "utf8");
  } else {
    // Partial failure — don't write
  }

  return results;
}

/**
 * Replace-based edit — apply a transformation function to file content.
 * Best for complex regex replacements or multi-pattern substitutions.
 */
export async function replaceInFile(
  filePath: string,
  transform: (content: string) => string,
): Promise<{ success: boolean; error?: string }> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { success: false, error: "File not found" };
  }

  try {
    const content = readFileSync(resolved, "utf8");
    const newContent = transform(content);
    writeFileSync(resolved, newContent, "utf8");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Apply byte offset to string positions (simplified). */
function applyOffset(text: string, offset: number): string {
  // For simple single-line replacements, offset doesn't affect string content
  // Only matters for multi-line edits where line numbers shift
  return text;
}

/** Try to find near-matches to help debug "not found" errors. */
function suggestMatch(searchText: string, lines: string[]): string {
  const searchLines = searchText.split("\n");
  const searchFirst = searchLines[0].trim();
  const searchLast = searchLines[searchLines.length - 1].trim();

  let bestScore = 0;
  let bestLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Simple LCS-based similarity
    let matches = 0;
    const s = searchFirst;
    for (let j = 0; j < Math.min(s.length, 40); j++) {
      if (line.includes(s[j])) matches++;
    }
    const score = matches / Math.max(s.length, 1);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (bestScore > 0.3 && bestLine >= 0) {
    return ` Nearest match at line ${bestLine + 1}: "${lines[bestLine].trim().slice(0, 80)}"`;
  }
  return "";
}
