/**
 * Codebase Tree Explorer — Standalone pi extension
 *
 * Provides a `codebase_tree` tool for directory structure visualization.
 * Extracted from pi-braid to ~/.pi/agent/extensions/ for modularity.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("codebase-tree");

const DEFAULT_EXCLUDE = [".DS_Store", "Thumbs.db", "*.log", ".env.local", ".env.*.local"];
const TRUNCATED_DIRS = [".git", ".svn", ".hg", "node_modules"];

// deduped stat cache per call
const statCache = new Map<string, fsSync.Stats>();

interface TreeNode {
  name: string;
  type: "file" | "dir";
  size: number;
  lines?: number;
  children?: TreeNode[];
}

interface CodebaseTreeResult {
  path: string;
  tree: TreeNode[];
  maxDepth: number;
  totalFiles: number;
  totalDirs: number;
  totalSize: number;
  totalLines: number;
  typeBreakdown: Record<string, number>;
}

// ── Core function ──────────────────────────────────────────────────────────

async function buildTree(
  dirPath: string,
  depth: number,
  maxDepth: number,
  patterns: string[],
  minSize?: number,
  maxSize?: number,
  typeFilter?: string,
  visited?: Set<string>,
): Promise<{ tree: TreeNode[]; files: number; dirs: number; size: number; lines: number; breakdown: Record<string, number> }> {
  let files = 0;
  let dirs = 0;
  let size = 0;
  let lines = 0;
  const breakdown: Record<string, number> = {};
  const tree: TreeNode[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();

      // Exclusion patterns
      if (matchesExclude(entry.name, patterns)) continue;

      // Truncated directories: show as placeholder, don't recurse
      if (isDir && TRUNCATED_DIRS.includes(entry.name)) {
        const ctx: TreeNode = { name: entry.name + "/", type: "dir", size: 0, children: [] };
        tree.push(ctx);
        dirs++;
        continue;
      }

      if (isDir) {
        if (depth >= maxDepth) {
          tree.push({ name: entry.name + "/", type: "dir", size: 0 });
          dirs++;
          continue;
        }

        // Symlink cycle detection: track resolved real paths
        if (isSymlink) {
          try {
            const realPath = await fs.realpath(fullPath);
            if (visited?.has(realPath)) {
              tree.push({ name: entry.name + "/", type: "dir", size: 0, children: [] });
              dirs++;
              continue;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(realPath);
            const result = await buildTree(fullPath, depth + 1, maxDepth, patterns, minSize, maxSize, typeFilter, nextVisited);
            if (result.tree.length > 0 || patterns.length > 0) {
              tree.push({ name: entry.name + "/", type: "dir", size: result.size, children: result.tree, lines: result.lines });
              files += result.files;
              dirs += result.dirs + 1;
              size += result.size;
              lines += result.lines;
              for (const [k, v] of Object.entries(result.breakdown)) {
                breakdown[k] = (breakdown[k] || 0) + v;
              }
            }
            continue;
          } catch {
            continue;
          }
        }

        const result = await buildTree(fullPath, depth + 1, maxDepth, patterns, minSize, maxSize, typeFilter, visited);
        if (result.tree.length > 0 || patterns.length > 0) {
          tree.push({ name: entry.name + "/", type: "dir", size: result.size, children: result.tree, lines: result.lines });
          files += result.files;
          dirs += result.dirs + 1;
          size += result.size;
          lines += result.lines;
          for (const [k, v] of Object.entries(result.breakdown)) {
            breakdown[k] = (breakdown[k] || 0) + v;
          }
        }
      } else {
        try {
          const s = await fastStat(fullPath);
          const fileSize = s.size;

          if (minSize && fileSize < minSize) continue;
          if (maxSize && fileSize > maxSize) continue;

          const ext = path.extname(entry.name).toLowerCase() || "(no ext)";
          const type = typeFilter && typeFilter !== ext ? null : ext;
          if (typeFilter && !type) continue;

          const fileLines = await countLines(fullPath, ext);
          tree.push({ name: entry.name, type: "file", size: fileSize, lines: fileLines });
          files++;
          size += fileSize;
          lines += fileLines;
          breakdown[ext] = (breakdown[ext] || 0) + 1;
        } catch {
          // Permission denied or other error
        }
      }
    }
  } catch {
    // Permission denied on root
  }

  return { tree, files, dirs, size, lines, breakdown };
}

async function fastStat(fullPath: string): Promise<fsSync.Stats> {
  if (statCache.has(fullPath)) return statCache.get(fullPath)!;
  const s = await fs.stat(fullPath);
  statCache.set(fullPath, s);
  return s;
}

async function countLines(fullPath: string, ext: string): Promise<number> {
  const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".o", ".so", ".dylib", ".zip", ".tar", ".gz"];
  if (binaryExts.includes(ext)) return 0;
  try {
    const content = await fs.readFile(fullPath, { encoding: "utf8", flag: "r" });
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function matchesExclude(name: string, patterns: string[]): boolean {
  for (const p of [...DEFAULT_EXCLUDE, ...patterns]) {
    if (p.startsWith("*.") && name.endsWith(p.slice(1))) return true;
    if (name === p) return true;
  }
  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Schema ─────────────────────────────────────────────────────────────────

const codebaseTreeSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Root directory to explore (default: cwd)" })),
  maxDepth: Type.Optional(Type.Integer({ description: "Maximum depth (default: 3, max: 10)", default: 3 })),
  exclude: Type.Optional(Type.Array(Type.String(), { description: "Patterns to exclude" })),
  include: Type.Optional(Type.Array(Type.String(), { description: "Include patterns" })),
  showStats: Type.Optional(Type.Boolean({ description: "Show file sizes and line counts (default: true)", default: true })),
  compact: Type.Optional(Type.Boolean({ description: "Use compact single-line output (default: false)", default: false })),
});

// ── Extension factory ──────────────────────────────────────────────────────

export default function codebaseTreeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codebase_tree",
    label: "Codebase Tree",
    description:
      "Explore codebase directory structure with stats and filtering. Use when you need to understand the layout of a codebase, find files, or get an overview of a project structure.",
    parameters: codebaseTreeSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<CodebaseTreeResult>> => {
      statCache.clear();

      let resolvedPath = (params.path as string) ?? ".";
      if (resolvedPath.startsWith("~/") || resolvedPath === "~") {
        resolvedPath = resolvedPath.replace(/^~/, os.homedir());
      }
      const isAbsolute = path.isAbsolute(resolvedPath);
      const baseDir = isAbsolute ? resolvedPath : path.resolve(ctx.cwd ?? ".", resolvedPath);
      const patterns = (params.exclude as string[]) ?? [];
      const showStats = params.showStats !== false;
      const compact = params.compact === true;
      const maxDepth = Math.min(params.maxDepth as number ?? 3, 10);

      const visited = new Set<string>();
      try { visited.add(await fs.realpath(baseDir)); } catch { /* ignore */ }
      const result = await buildTree(baseDir, 0, maxDepth, patterns, undefined, undefined, undefined, visited);

      // Format output
      const lines: string[] = [];
      if (compact) {
        lines.push(`${baseDir}/ [${result.dirs} dirs, ${result.files} files, ${formatSize(result.size)}, ${result.lines} lines]`);
        for (const node of result.tree) {
          formatCompact(node, lines, "");
        }
      } else {
        lines.push(`${baseDir}/`);
        for (const node of result.tree) {
          formatNode(node, lines, "    ", showStats);
        }
        lines.push("");
        lines.push(`## Statistics`);
        lines.push(`- **Directories:** ${result.dirs}`);
        lines.push(`- **Files:** ${result.files}`);
        lines.push(`- **Total Size:** ${formatSize(result.size)}`);
        lines.push(`- **Total Lines:** ${result.lines}`);
        if (Object.keys(result.breakdown).length > 0) {
          const sortedTypes = Object.entries(result.breakdown).sort((a, b) => b[1] - a[1]);
          lines.push(`- **File Types:** ${sortedTypes.map(([k, v]) => `\`${k}\`: ${v}`).join(", ")}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          path: baseDir,
          tree: result.tree,
          maxDepth,
          totalFiles: result.files,
          totalDirs: result.dirs,
          totalSize: result.size,
          totalLines: result.lines,
          typeBreakdown: result.breakdown,
        },
      };
    },
  } as unknown as ToolDefinition);
}

function formatNode(node: TreeNode, lines: string[], indent: string, showStats: boolean): void {
  if (node.type === "dir") {
    const statStr = showStats ? ` [${node.children?.length || 0} items, ${node.lines || 0} lines]` : "";
    lines.push(`${indent}├── [D] ${node.name}${statStr}`);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const isLast = i === node.children.length - 1;
        formatNode(node.children[i], lines, indent + (isLast ? "    " : "│   "), showStats);
      }
    }
  } else {
    const statStr = showStats ? ` (${formatSize(node.size)}, ${node.lines} lines)` : "";
    lines.push(`${indent}├── ${node.name}${statStr}`);
  }
}

function formatCompact(node: TreeNode, lines: string[], indent: string): void {
  if (node.type === "dir") {
    lines.push(`${indent}[${node.name}]`);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const isLast = i === node.children.length - 1;
        formatCompact(node.children[i], lines, indent + (isLast ? "  " : "│ "));
      }
    }
  } else {
    const size = formatSize(node.size);
    lines.push(`${indent}${node.name} (${size}, ${node.lines}L)`);
  }
}
