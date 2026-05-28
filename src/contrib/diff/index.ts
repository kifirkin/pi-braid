/**
 * File Diff Tool — compare files or git revisions with structured output.
 *
 * Reduces bash `diff` usage by providing a first-class tool that returns
 * structured diff hunks with line numbers, change types, and context.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("diff");

// ── Types ───────────────────────────────────────────────────────────────────

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
  changes: DiffChange[];
}

export interface DiffChange {
  type: "add" | "del" | "ctx";
  line: number;
  content: string;
}

export interface DiffResult {
  hunks: DiffHunk[];
  files: string[];
  added: number;
  removed: number;
  changed: number;
  hasChanges: boolean;
  format: "unified" | "summary" | "stat";
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = raw.split("\n");
  let current: DiffHunk | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkMatch[1]),
        oldLines: parseInt(hunkMatch[2] || "1"),
        newStart: parseInt(hunkMatch[3]),
        newLines: parseInt(hunkMatch[4] || "1"),
        content: "",
        changes: [],
      };
      continue;
    }

    if (current) {
      current.content += line + "\n";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.changes.push({ type: "add", line: current.changes.length, content: line.slice(1) });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.changes.push({ type: "del", line: current.changes.length, content: line.slice(1) });
      } else {
        current.changes.push({
          type: "ctx",
          line: current.changes.length,
          content: line.startsWith(" ") ? line.slice(1) : line,
        });
      }
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

// ── Diff Engine ─────────────────────────────────────────────────────────────

function diffFiles(fileA: string, fileB: string, contextLines: number): DiffResult {
  const cmd = `diff -u -U ${contextLines} ${escapePath(fileA)} ${escapePath(fileB)}`;
  try {
    const stdout = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    const hunks = parseUnifiedDiff(stdout);
    const added = hunks.reduce((s, h) => s + h.changes.filter((c) => c.type === "add").length, 0);
    const removed = hunks.reduce((s, h) => s + h.changes.filter((c) => c.type === "del").length, 0);
    return {
      hunks,
      files: [fileA, fileB],
      added,
      removed,
      changed: added + removed,
      hasChanges: hunks.length > 0,
      format: "unified",
    };
  } catch (e: any) {
    // diff exits with code 1 when files differ — that's not an error
    if (e.status === 1 && e.stdout) {
      const hunks = parseUnifiedDiff(e.stdout);
      const added = hunks.reduce((s, h) => s + h.changes.filter((c) => c.type === "add").length, 0);
      const removed = hunks.reduce(
        (s, h) => s + h.changes.filter((c) => c.type === "del").length,
        0,
      );
      return {
        hunks,
        files: [fileA, fileB],
        added,
        removed,
        changed: added + removed,
        hasChanges: true,
        format: "unified",
      };
    }
    return {
      hunks: [],
      files: [fileA, fileB],
      added: 0,
      removed: 0,
      changed: 0,
      hasChanges: false,
      format: "unified",
    };
  }
}

function diffGit(refA: string, refB: string, path: string, contextLines: number): DiffResult {
  const repoPath = path ? `-- ${escapePath(path)}` : "";
  const cmd = `git diff -U ${contextLines} ${refA} ${refB} ${repoPath}`;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: process.cwd(),
    });
    const hunks = parseUnifiedDiff(stdout);
    const added = hunks.reduce((s, h) => s + h.changes.filter((c) => c.type === "add").length, 0);
    const removed = hunks.reduce((s, h) => s + h.changes.filter((c) => c.type === "del").length, 0);
    return {
      hunks,
      files: [`${refA}..${refB}`],
      added,
      removed,
      changed: added + removed,
      hasChanges: hunks.length > 0,
      format: "unified",
    };
  } catch {
    return {
      hunks: [],
      files: [],
      added: 0,
      removed: 0,
      changed: 0,
      hasChanges: false,
      format: "unified",
    };
  }
}

function diffSummary(fileA: string, fileB: string): DiffResult {
  try {
    const stdout = execSync(`diff -q ${escapePath(fileA)} ${escapePath(fileB)}`, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return {
      hunks: [],
      files: [fileA, fileB],
      added: 0,
      removed: 0,
      changed: 0,
      hasChanges: stdout.length > 0,
      format: "summary",
    };
  } catch {
    return {
      hunks: [],
      files: [fileA, fileB],
      added: 0,
      removed: 0,
      changed: 0,
      hasChanges: true,
      format: "summary",
    };
  }
}

function escapePath(p: string): string {
  return p.replace(/(["\s'$`\\])/g, "\\$1");
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function diffExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "file_diff",
    label: "File Diff",
    promptSnippet: "Compare two files or git revisions",
    description:
      "Compare two files or git revisions to see what changed between versions — use for code review and debugging. " +
      "Returns hunks with line numbers, change types (add/del/ctx), and stats. " +
      "Use fileA and fileB for file comparison, or gitRefA/gitRefB for git diff. " +
      "Set format='summary' for quick check or format='stat' for line counts only.",
    parameters: Type.Object({
      fileA: Type.Optional(Type.String({ description: "First file path" })),
      fileB: Type.Optional(Type.String({ description: "Second file path" })),
      gitRefA: Type.Optional(Type.String({ description: "Git reference A (e.g. HEAD~1)" })),
      gitRefB: Type.Optional(
        Type.String({ description: "Git reference B (e.g. HEAD)", default: "HEAD" }),
      ),
      path: Type.Optional(Type.String({ description: "Path filter for git diff" })),
      context: Type.Optional(
        Type.Number({ default: 3, description: "Context lines (default: 3)" }),
      ),
      format: Type.Optional(
        Type.String({ default: "unified", description: "Output format: unified, summary, stat" }),
      ),
    }),
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const format = params.format || "unified";

      // Git diff mode
      if (params.gitRefA) {
        const result = diffGit(
          params.gitRefA,
          params.gitRefB || "HEAD",
          params.path || "",
          params.context || 3,
        );
        return formatResult(result, format);
      }

      // File diff mode
      if (!params.fileA || !params.fileB) {
        return {
          content: [{ type: "text" as const, text: "❌ Provide fileA and fileB, or gitRefA." }],
        };
      }

      // Validate files exist
      if (!fs.existsSync(params.fileA)) {
        return {
          content: [{ type: "text" as const, text: `❌ File not found: ${params.fileA}` }],
        };
      }
      if (!fs.existsSync(params.fileB)) {
        return {
          content: [{ type: "text" as const, text: `❌ File not found: ${params.fileB}` }],
        };
      }

      if (format === "summary") {
        const result = diffSummary(params.fileA, params.fileB);
        return formatResult(result, "summary");
      }

      const result = diffFiles(params.fileA, params.fileB, params.context || 3);
      return formatResult(result, format);
    },
  });

  log.info("Diff extension registered.");
}

// ── Result formatting ───────────────────────────────────────────────────────

function formatResult(result: DiffResult, format: string): any {
  if (format === "stat") {
    return {
      content: [
        {
          type: "text" as const,
          text: `📊 ${result.files.join(" ↔ ")}: ${result.added} additions, ${result.removed} deletions, ${result.changed} total changes.`,
        },
      ],
      details: {
        files: result.files,
        added: result.added,
        removed: result.removed,
        changed: result.changed,
        hasChanges: result.hasChanges,
      },
    };
  }

  if (format === "summary") {
    const text = result.hasChanges
      ? `📋 Files differ: ${result.files.join(", ")}`
      : `✅ Files identical: ${result.files.join(", ")}`;
    return {
      content: [{ type: "text" as const, text }],
      details: { files: result.files, hasChanges: result.hasChanges },
    };
  }

  // Unified format
  if (!result.hasChanges) {
    return {
      content: [
        { type: "text" as const, text: `✅ Files are identical: ${result.files.join(", ")}` },
      ],
      details: result,
    };
  }

  const summary = `📊 ${result.added} additions, ${result.removed} deletions in ${result.hunks.length} hunks`;
  const hunkText = result.hunks
    .map(
      (h, i) =>
        `Hunk ${i + 1}: @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
        h.changes
          .map((c) => {
            const prefix = c.type === "add" ? "+" : c.type === "del" ? "-" : " ";
            return `${prefix}${c.content}`;
          })
          .join("\n"),
    )
    .join("\n\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `${summary}\n\n${hunkText}`,
      },
    ],
    details: {
      hunks: result.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        changes: h.changes.length,
      })),
      files: result.files,
      added: result.added,
      removed: result.removed,
      changed: result.changed,
      hasChanges: result.hasChanges,
    },
  };
}
