/**
 * Codebase Extension — consolidated tree + dependency graph analyzer.
 *
 * One tool, three actions:
 *   - "tree"   : directory structure with stats
 *   - "graph"  : dependency analysis (dead-ends, orphans, hubs, cycles)
 *   - "impact" : what breaks if a given file changes
 *
 * The dep parser is a
 * robust multi-pattern regex (not an AST) — see PARSER_NOTE.
 *
 * Large repos are bounded: MAX_FILES caps the walk. Beyond that, analysis
 * still runs on the first N files and the truncation is reported.
 */

// PARSER_NOTE: This extension uses regex-based import detection, not acorn.
//
// acorn (our direct dep) cannot parse TypeScript files without the
// acorn-typescript plugin, which is not installed. Rather than introducing
// a new dep just for graph building, we use a careful multi-pattern regex
// that handles the cases that matter for dependency analysis:
//
//   - `import x, { a, b as c } from 'm'`
//   - `import * as ns from 'm'`
//   - `import 'm'`                                  (side-effect import)
//   - `import type { T } from 'm'`                  (TS type-only — treated as dep)
//   - `import('m')`                                 (dynamic)
//   - `export { a, b } from 'm'`                    (re-export named)
//   - `export * from 'm'`                           (re-export namespace)
//   - `export * as ns from 'm'`                     (TS-named re-export)
//   - `require('m')`                                (CJS / mixed)
//   - TS-style triple-slash references are NOT detected (rare).
//
// False positives are possible but rare (a string literal that happens to
// look like a path inside a docblock comment). We accept this trade-off —
// it's a "structural" pass, not a type-aware analyzer. For type-aware
// graph, run `madge --ts-config` separately.

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
import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";
import {
  DEFAULT_MAX_DEPTH,
  MAX_MAX_DEPTH,
  resolveFind,
  resolveMaxDepth,
} from "./tool-inputs.js";

const log = createLogger("codebase");

// Limits

const MAX_FILES_WALK = 5000; // hard cap to prevent runaway on huge repos

// Constants

const DEFAULT_EXCLUDE = [
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  ".env.local",
  ".env.*.local",
];
const TRUNCATED_DIRS = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  "out",
];

// Extensions we analyze for either walking (tree) or imports (graph)
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_EXTS_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

// Extensions to count in tree.stats
const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".o",
  ".so",
  ".dylib",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
]);

// Types

interface ImportBinding {
  raw: string; // exact source string from the code
  specifiers: string[]; // ['Foo', 'bar as baz']
  isDynamic: boolean; // true for `import('m')`
  isExternal: boolean; // true for bare module specifiers (not starting with .)
  resolvedRel: string | null; // relative path inside repo, null if external/unresolved
}

interface ExportBinding {
  name: string | null; // null for namespace re-exports
  kind: "named" | "default" | "namespace" | "reexport";
  source?: string; // for re-export
}

interface FileAnalysis {
  relPath: string; // relative to repo root, with forward slashes
  absPath: string;
  imports: ImportBinding[];
  exports: ExportBinding[];
  parseError?: string;
}

interface RepoAnalysis {
  root: string; // absolute path to repo root
  files: Map<string, FileAnalysis>; // relPath (forward-slash) -> analysis
  externalImports: Set<string>; // dep names referenced anywhere
  parseErrors: Array<{ file: string; error: string }>;
  truncated: boolean;
}

// Tree types

interface TreeNode {
  name: string;
  type: "file" | "dir";
  size: number;
  lines?: number;
  children?: TreeNode[];
}

// File walker

async function collectFiles(
  root: string,
  patterns: string[] = [],
): Promise<{ files: string[]; truncated: boolean }> {
  const allPatterns = [...DEFAULT_EXCLUDE, ...patterns];
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES_WALK) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / broken symlink / etc.
    }

    // Sort: dirs first (matching `tree` output), then alpha
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (out.length >= MAX_FILES_WALK) return;
      const full = path.join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && TRUNCATED_DIRS.includes(entry.name)) continue;
      // User-supplied excludes
      if (matchesExclude(entry.name, allPatterns)) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        // Skip symlinks to avoid cycles; the tree extension shows them as placeholders
        continue;
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(root);
  return { files: out, truncated: out.length >= MAX_FILES_WALK };
}

function matchesExclude(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.startsWith("*.") && name.endsWith(p.slice(1))) return true;
    if (name === p) return true;
  }
  return false;
}

// Import parser (regex, but careful)

/** Parse imports/exports from a source file. Returns null on parse failure. */
function analyzeSource(
  relPath: string,
  absPath: string,
  src: string,
): FileAnalysis {
  const imports: ImportBinding[] = [];
  const exports: ExportBinding[] = [];

  // Static imports
  //   import x from 'm'
  //   import { a, b as c } from 'm'
  //   import * as ns from 'm'
  //   import 'm'
  //   import type { T } from 'm'
  const importRe =
    /\bimport\s+(?:type\s+)?(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const source = m[1];
    const specifiers = extractImportSpecifiers(m[0]);
    addImport(
      imports,
      source,
      specifiers,
      false,
      relPath,
      path.dirname(absPath),
    );
  }

  // Dynamic imports
  //   import('m')
  //   const x = await import('m')
  const dynImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynImportRe.exec(src)) !== null) {
    addImport(
      imports,
      m[1],
      ["*dynamic*"],
      true,
      relPath,
      path.dirname(absPath),
    );
  }

  // Re-exports
  //   export { a, b } from 'm'
  //   export * from 'm'
  //   export * as ns from 'm'
  const reexportRe =
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
  while ((m = reexportRe.exec(src)) !== null) {
    addImport(imports, m[1], ["*"], false, relPath, path.dirname(absPath));
    exports.push({ name: null, kind: "reexport", source: m[1] });
  }

  // CJS require
  //   require('m')
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(src)) !== null) {
    addImport(
      imports,
      m[1],
      ["*require*"],
      false,
      relPath,
      path.dirname(absPath),
    );
  }

  // local exports (no from clause) — separate from re-exports
  //   export const x = ...
  //   export function foo() {}
  //   export class Bar {}
  //   export default ...
  if (
    /\bexport\s+(?:const|let|var|function|class|interface|type|enum)\b/.test(
      src,
    )
  ) {
    const declRe = /\bexport\s+(?:const|let|var|function|class)\s+(\w+)/g;
    while ((m = declRe.exec(src)) !== null) {
      exports.push({ name: m[1], kind: "named" });
    }
  }
  if (/\bexport\s+default\b/.test(src)) {
    exports.push({ name: "default", kind: "default" });
  }
  if (/\bexport\s+\*\s+as\s+\w+/.test(src) && !reexportRe.test(src)) {
    // bare `export * as ns` (without `from`) — unusual; record as namespace
    exports.push({ name: "*", kind: "namespace" });
  }

  return { relPath, absPath, imports, exports };
}

function extractImportSpecifiers(raw: string): string[] {
  // raw looks like:  import { foo, bar as baz } from '...'
  // or:              import x from '...'
  // or:              import * as ns from '...'
  // or:              import '...'
  const out: string[] = [];
  const fromIdx = raw.indexOf(" from");
  const specBlock = fromIdx >= 0 ? raw.slice(0, fromIdx) : raw;
  const m = specBlock.match(/\bimport\s+(?:type\s+)?(.*)/);
  if (!m) return out;
  const body = m[1].trim();
  if (!body) return out;
  if (body.startsWith("*")) {
    const m2 = body.match(/\*\s+as\s+(\w+)/);
    if (m2) out.push(`* as ${m2[1]}`);
    return out;
  }
  // Default + named:  X, { a, b as c }
  const defaultM = body.match(/^(\w+)\s*,?\s*/);
  if (defaultM && !body.startsWith("{")) {
    out.push(`default: ${defaultM[1]}`);
  }
  const braceM = body.match(/\{([^}]*)\}/);
  if (braceM) {
    for (const spec of braceM[1].split(",")) {
      const t = spec.trim();
      if (!t) continue;
      const asM = t.match(/^(\w+)\s+as\s+(\w+)$/);
      out.push(asM ? `${asM[1]} as ${asM[2]}` : t);
    }
  }
  return out;
}

function addImport(
  imports: ImportBinding[],
  source: string,
  specifiers: string[],
  isDynamic: boolean,
  _relPath: string,
  absDir: string,
): void {
  const isExternal = !source.startsWith(".") && !source.startsWith("/");
  let resolvedRel: string | null = null;
  if (!isExternal) {
    // Relative import: try to resolve to a source file we know about.
    // Resolution happens later in resolveImports() once we've walked all files.
    // Here we just record the raw source — see resolveImports().
    resolvedRel = null;
  }
  imports.push({
    raw: source,
    specifiers,
    isDynamic,
    isExternal,
    resolvedRel,
  });
  // Stash absDir for later resolution
  (
    imports[imports.length - 1] as ImportBinding & { _absDir?: string }
  )._absDir = absDir;
}

// Resolution pass

/**
 * Try to resolve a relative import to an actual file in the analysis.
 * Uses sync fs.existsSync (intentional — small, fast I/O, called once per
 * import during the post-walk resolution pass).
 */
function resolveImportTarget(
  source: string,
  fromAbsDir: string,
  rootAbs: string,
): string | null {
  if (!source.startsWith(".") && !source.startsWith("/")) return null;

  let target: string;
  if (source.startsWith("/")) {
    target = path.join(rootAbs, source);
  } else {
    target = path.resolve(fromAbsDir, source);
  }

  // Try with these extensions and as a directory with index.*
  const candidates: string[] = [];
  // exact
  candidates.push(target);
  // +ext
  for (const ext of SOURCE_EXTS) candidates.push(target + ext);
  // /index.ext
  for (const ext of SOURCE_EXTS)
    candidates.push(path.join(target, `index${ext}`));

  for (const c of candidates) {
    try {
      fsSync.accessSync(c, fsSync.constants.R_OK);
      return path.relative(rootAbs, c).split(path.sep).join("/");
    } catch {
      // not this one
    }
  }
  return null;
}

function resolveAllImports(repo: RepoAnalysis): void {
  for (const file of repo.files.values()) {
    for (const imp of file.imports) {
      const fromAbsDir = path.dirname(file.absPath);
      const resolved = resolveImportTarget(imp.raw, fromAbsDir, repo.root);
      if (resolved) {
        imp.resolvedRel = resolved;
      }
      if (imp.isExternal) {
        repo.externalImports.add(imp.raw);
      }
    }
  }
}

// Repo analyzer

async function analyzeRepo(root: string): Promise<RepoAnalysis> {
  const { files, truncated } = await collectFiles(root);
  const sourceFiles = files.filter((f) => SOURCE_EXTS_RE.test(f));

  const repo: RepoAnalysis = {
    root,
    files: new Map(),
    externalImports: new Set(),
    parseErrors: [],
    truncated,
  };

  await Promise.all(
    sourceFiles.map(async (abs) => {
      let src: string;
      try {
        src = await fs.readFile(abs, "utf-8");
      } catch (e) {
        repo.parseErrors.push({
          file: abs,
          error: `read: ${(e as Error).message}`,
        });
        return;
      }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const analysis = analyzeSource(rel, abs, src);
      if (analysis.parseError) {
        repo.parseErrors.push({ file: rel, error: analysis.parseError });
      }
      repo.files.set(rel, analysis);
    }),
  );

  resolveAllImports(repo);
  return repo;
}

// Graph queries

interface GraphSummary {
  totalFiles: number;
  totalInternalEdges: number;
  externalDeps: string[];
  deadEnds: string[]; // exports but nothing imports
  orphans: string[]; // no imports, no importers
  topHubs: Array<{ path: string; fanIn: number }>;
  cycles: string[][];
  parseErrors: Array<{ file: string; error: string }>;
}

function summarizeRepo(repo: RepoAnalysis): GraphSummary {
  const importers = new Map<string, string[]>();
  for (const file of repo.files.values()) {
    importers.set(file.relPath, []);
  }
  let internalEdges = 0;
  for (const file of repo.files.values()) {
    for (const imp of file.imports) {
      if (
        !imp.isExternal &&
        imp.resolvedRel &&
        imp.resolvedRel !== file.relPath
      ) {
        internalEdges++;
        const list = importers.get(imp.resolvedRel);
        if (list) list.push(file.relPath);
      }
    }
  }

  const deadEnds: string[] = [];
  const orphans: string[] = [];
  for (const file of repo.files.values()) {
    const fanIn = importers.get(file.relPath)?.length ?? 0;
    const hasImports = file.imports.some(
      (i) => !i.isExternal && i.resolvedRel && i.resolvedRel !== file.relPath,
    );
    const hasExports = file.exports.length > 0;
    if (hasExports && fanIn === 0) deadEnds.push(file.relPath);
    if (!hasImports && fanIn === 0) orphans.push(file.relPath);
  }

  const hubs: Array<{ path: string; fanIn: number }> = [];
  for (const [p, list] of importers) {
    if (list.length >= 3) hubs.push({ path: p, fanIn: list.length });
  }
  hubs.sort((a, b) => b.fanIn - a.fanIn);

  return {
    totalFiles: repo.files.size,
    totalInternalEdges: internalEdges,
    externalDeps: [...repo.externalImports].sort(),
    deadEnds: deadEnds.sort(),
    orphans: orphans.sort(),
    topHubs: hubs.slice(0, 10),
    cycles: findCycles(repo, importers),
    parseErrors: repo.parseErrors,
  };
}

/**
 * Cycle detection: DFS from each node, recording the current stack.
 * If we revisit a stack node we have a cycle.
 * O(V+E) worst case; bounded by MAX_FILES_WALK * edges so it's OK.
 */
function findCycles(
  repo: RepoAnalysis,
  importers: Map<string, string[]>,
): string[][] {
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();

  const edges = new Map<string, string[]>();
  for (const file of repo.files.values()) {
    const out: string[] = [];
    for (const imp of file.imports) {
      if (
        !imp.isExternal &&
        imp.resolvedRel &&
        imp.resolvedRel !== file.relPath
      ) {
        out.push(imp.resolvedRel);
      }
    }
    edges.set(file.relPath, out);
  }

  for (const start of repo.files.keys()) {
    const stack: string[] = [];
    const inStack = new Set<string>();

    const dfs = (node: string): void => {
      if (seenCycle.has(node)) return;
      if (inStack.has(node)) {
        const idx = stack.indexOf(node);
        if (idx >= 0) {
          const cycle = stack.slice(idx);
          // Normalize: rotate so smallest path comes first for dedup
          const minIdx = cycle.indexOf([...cycle].sort()[0]);
          const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
          const key = rotated.join("→");
          if (!seenCycle.has(key)) {
            seenCycle.add(key);
            cycles.push(rotated);
          }
        }
        return;
      }
      inStack.add(node);
      stack.push(node);
      for (const next of edges.get(node) ?? []) {
        dfs(next);
      }
      stack.pop();
      inStack.delete(node);
    };

    dfs(start);
    // also stop on large cycle counts
    if (cycles.length > 50) break;
  }

  // touch importers to silence unused-var lint when this is simplified later
  void importers;
  return cycles;
}

function getImpact(
  repo: RepoAnalysis,
  target: string,
): { broken: string[]; total: number } {
  const targetRel = target.replace(/^\.\//, "").split(path.sep).join("/");
  const broken = new Set<string>();
  const stack = [targetRel];
  while (stack.length) {
    const cur = stack.pop()!;
    if (broken.has(cur)) continue;
    broken.add(cur);
    // Files that import `cur`
    for (const file of repo.files.values()) {
      if (broken.has(file.relPath)) continue;
      const usesCur = file.imports.some(
        (i) => !i.isExternal && i.resolvedRel === cur,
      );
      if (usesCur) stack.push(file.relPath);
    }
  }
  broken.delete(targetRel);
  return { broken: [...broken].sort(), total: broken.size };
}

// Tree builder

async function buildTree(
  root: string,
  maxDepth: number,
  patterns: string[],
  _showStats: boolean,
): Promise<{
  tree: TreeNode[];
  files: number;
  dirs: number;
  size: number;
  lines: number;
  breakdown: Record<string, number>;
}> {
  let files = 0;
  let dirs = 0;
  let size = 0;
  let lines = 0;
  const breakdown: Record<string, number> = {};
  const allPatterns = [...DEFAULT_EXCLUDE, ...patterns];

  async function walk(dir: string, depth: number): Promise<TreeNode[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (matchesExclude(entry.name, allPatterns)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TRUNCATED_DIRS.includes(entry.name)) {
          nodes.push({ name: `${entry.name}/`, type: "dir", size: 0 });
          dirs++;
          continue;
        }
        if (depth >= maxDepth) {
          nodes.push({ name: `${entry.name}/`, type: "dir", size: 0 });
          dirs++;
          continue;
        }
        const children = await walk(full, depth + 1);
        const dirSize = children.reduce((s, n) => s + n.size, 0);
        const dirLines = children.reduce((s, n) => s + (n.lines ?? 0), 0);
        if (children.length === 0 && patterns.length === 0) {
          // don't show empty dirs unless user has exclude patterns (intentional filtering)
          continue;
        }
        nodes.push({
          name: `${entry.name}/`,
          type: "dir",
          size: dirSize,
          lines: dirLines,
          children,
        });
        dirs++;
        size += dirSize;
        lines += dirLines;
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(full);
          const ext = path.extname(entry.name).toLowerCase() || "(no ext)";
          const fileLines = BINARY_EXTS.has(ext)
            ? 0
            : await countLines(full, ext);
          nodes.push({
            name: entry.name,
            type: "file",
            size: s.size,
            lines: fileLines,
          });
          files++;
          size += s.size;
          lines += fileLines;
          breakdown[ext] = (breakdown[ext] ?? 0) + 1;
        } catch {
          // unreadable file — skip
        }
      }
    }
    return nodes;
  }

  const tree = await walk(root, 0);
  return { tree, files, dirs, size, lines, breakdown };
}

async function countLines(filePath: string, _ext: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Schema

const codebaseSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("tree"), Type.Literal("graph"), Type.Literal("impact")],
    {
      default: "tree",
      description:
        "tree = directory structure with stats; " +
        "graph = dependency analysis (dead-ends, orphans, hubs, cycles); " +
        "impact = what breaks if a given file changes (requires file).",
    },
  ),
  path: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
  file: Type.Optional(
    Type.String({
      description:
        "File path for `impact` action (relative to repo root, default: cwd)",
    }),
  ),

  // tree-only
  maxDepth: Type.Optional(
    Type.Integer({
      description: `Maximum depth (default ${DEFAULT_MAX_DEPTH}, max ${MAX_MAX_DEPTH})`,
    }),
  ),
  exclude: Type.Optional(
    Type.Array(Type.String(), { description: "Patterns to exclude" }),
  ),
  showStats: Type.Optional(
    Type.Boolean({
      description: "Show file sizes and line counts (default: true)",
    }),
  ),
  compact: Type.Optional(
    Type.Boolean({
      description:
        "Compact single-line output (tree action only, default: false)",
    }),
  ),

  // graph-only
  find: Type.Optional(
    Type.Union(
      [
        Type.Literal("dead-ends"),
        Type.Literal("orphans"),
        Type.Literal("hubs"),
        Type.Literal("cycles"),
        Type.Literal("all"),
      ],
      { description: "What to find (graph action only, default: all)" },
    ),
  ),
});

// Extension factory

export default function codebaseExtension(pi: ExtensionAPI): void {
  const toggle = readToggleVerdict(["codebase"]);
  if (toggle.disabled) {
    log.info(
      `[codebase] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  const tool: ToolDefinition = {
    name: "codebase",
    exposure: "deferred",
    label: "Codebase",
    promptSnippet: "Explore codebase structure or analyze module dependencies",
    description:
      "Analyze a codebase's structure or module dependencies. " +
      "Action 'tree': directory layout with stats. " +
      "Action 'graph': import/export analysis (dead-ends, orphans, hubs, cycles). " +
      "Action 'impact': what breaks if a given file changes. " +
      "Uses a fast structural pass — for type-aware analysis, use madge or dependency-cruiser.",
    parameters: codebaseSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      let resolvedRoot = (params.path as string) ?? ".";
      if (resolvedRoot.startsWith("~")) {
        resolvedRoot = resolvedRoot.replace(/^~/, os.homedir());
      }
      const rootAbs = path.resolve(ctx.cwd ?? ".", resolvedRoot);
      const action = (params.action as string) ?? "tree";

      try {
        fsSync.accessSync(rootAbs, fsSync.constants.R_OK);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `❌ Path not found: ${rootAbs}` },
          ],
          details: { root: rootAbs },
        };
      }

      if (action === "tree") {
        // A blank depth arrives as 0 (see tool-inputs.ts), which walked no
        // further than the root entry.
        const maxDepth = resolveMaxDepth(params.maxDepth);
        const patterns = (params.exclude as string[] | undefined) ?? [];
        const showStats = (params.showStats as boolean | undefined) ?? true;
        const compact = (params.compact as boolean | undefined) ?? false;
        onUpdate?.({
          content: [{ type: "text" as const, text: `Walking ${rootAbs}...` }],
          details: {},
        });
        const result = await buildTree(rootAbs, maxDepth, patterns, showStats);

        let text: string;
        if (compact) {
          text = formatTreeCompact(rootAbs, result);
        } else {
          text = formatTree(rootAbs, result, showStats);
        }
        return {
          content: [{ type: "text" as const, text }],
          details: {
            root: rootAbs,
            tree: result.tree,
            totalFiles: result.files,
            totalDirs: result.dirs,
            totalSize: result.size,
            totalLines: result.lines,
            typeBreakdown: result.breakdown,
          },
        };
      }

      if (action === "graph" || action === "impact") {
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: `Analyzing dependencies in ${rootAbs}...`,
            },
          ],
          details: {},
        });
        const repo = await analyzeRepo(rootAbs);
        const summary = summarizeRepo(repo);

        if (action === "impact") {
          const target = (params.file as string) ?? "";
          if (!target) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "❌ `file` parameter required for impact action.",
                },
              ],
              details: {},
            };
          }
          const impact = getImpact(repo, target);
          return {
            content: [
              { type: "text" as const, text: formatImpact(target, impact) },
            ],
            details: { target, ...impact, repo: rootAbs },
          };
        }

        // graph
        // A blank filter selects no section (see tool-inputs.ts), which left
        // a header-only graph.
        const find = resolveFind(params.find);
        return {
          content: [
            {
              type: "text" as const,
              text: formatGraph(rootAbs, summary, repo, find),
            },
          ],
          details: {
            root: rootAbs,
            ...summary,
            truncated: repo.truncated,
          },
        };
      }

      return {
        content: [
          { type: "text" as const, text: `❌ Unknown action: ${action}` },
        ],
        details: {},
      };
    },
  };

  pi.registerTool(
    tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0],
  );
  log.info("Codebase extension registered (consolidated tree+graph+impact).");
}

// Output formatters

function formatTree(
  root: string,
  result: {
    tree: TreeNode[];
    files: number;
    dirs: number;
    size: number;
    lines: number;
    breakdown: Record<string, number>;
  },
  showStats: boolean,
): string {
  const lines: string[] = [`${root}/`];
  for (const node of result.tree) renderNode(node, lines, "    ", showStats);
  lines.push("");
  lines.push("## Statistics");
  lines.push(`- **Directories:** ${result.dirs}`);
  lines.push(`- **Files:** ${result.files}`);
  lines.push(`- **Total Size:** ${formatSize(result.size)}`);
  lines.push(`- **Total Lines:** ${result.lines}`);
  if (Object.keys(result.breakdown).length > 0) {
    const sorted = Object.entries(result.breakdown).sort((a, b) => b[1] - a[1]);
    const head = sorted
      .slice(0, 8)
      .map(([k, v]) => `\`${k}\`: ${v}`)
      .join(", ");
    const rest =
      sorted.length > 8 ? ` (and ${sorted.length - 8} more types)` : "";
    lines.push(`- **Top File Types:** ${head}${rest}`);
  }
  return lines.join("\n");
}

function formatTreeCompact(
  root: string,
  result: {
    tree: TreeNode[];
    files: number;
    dirs: number;
    size: number;
    lines: number;
  },
): string {
  const lines: string[] = [];
  lines.push(
    `${root}/ [${result.dirs} dirs, ${result.files} files, ${formatSize(result.size)}, ${result.lines}L]`,
  );
  for (const node of result.tree) renderCompact(node, lines, "  ");
  return lines.join("\n");
}

function renderNode(
  node: TreeNode,
  out: string[],
  indent: string,
  showStats: boolean,
): void {
  if (node.type === "dir") {
    const count = node.children?.length ?? 0;
    const statStr = showStats
      ? ` [${count} item${count === 1 ? "" : "s"}, ${node.lines ?? 0}L]`
      : "";
    out.push(`${indent}├── [D] ${node.name}${statStr}`);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const isLast = i === node.children.length - 1;
        renderNode(
          node.children[i],
          out,
          indent + (isLast ? "    " : "│   "),
          showStats,
        );
      }
    }
  } else {
    const statStr = showStats
      ? ` (${formatSize(node.size)}, ${node.lines ?? 0}L)`
      : "";
    out.push(`${indent}├── ${node.name}${statStr}`);
  }
}

function renderCompact(node: TreeNode, out: string[], indent: string): void {
  if (node.type === "dir") {
    out.push(`${indent}[${node.name}]`);
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const isLast = i === node.children.length - 1;
        renderCompact(node.children[i], out, indent + (isLast ? "  " : "│ "));
      }
    }
  } else {
    out.push(
      `${indent}${node.name} (${formatSize(node.size)}, ${node.lines ?? 0}L)`,
    );
  }
}

function formatGraph(
  root: string,
  s: GraphSummary,
  repo: RepoAnalysis,
  findMode: string,
): string {
  const lines: string[] = [];
  lines.push(`# Dependency Graph: ${root}`);
  if (repo.truncated) {
    lines.push(`⚠️ Repository walk capped at ${MAX_FILES_WALK} files.`);
  }

  const showAll = findMode === "all";

  if (showAll || findMode === "dead-ends") {
    lines.push(
      "",
      `## Dead Ends (${s.deadEnds.length}) — exported but never imported`,
    );
    if (s.deadEnds.length === 0) lines.push("✅ none");
    for (const p of s.deadEnds.slice(0, 25)) lines.push(`- \`${p}\``);
    if (s.deadEnds.length > 25)
      lines.push(`- ... and ${s.deadEnds.length - 25} more`);
  }

  if (showAll || findMode === "orphans") {
    lines.push(
      "",
      `## Orphans (${s.orphans.length}) — no imports, no importers`,
    );
    if (s.orphans.length === 0) lines.push("✅ none");
    for (const p of s.orphans.slice(0, 25)) lines.push(`- \`${p}\``);
    if (s.orphans.length > 25)
      lines.push(`- ... and ${s.orphans.length - 25} more`);
  }

  if (showAll || findMode === "hubs") {
    lines.push("", `## Top Hubs (${s.topHubs.length})`);
    if (s.topHubs.length === 0) lines.push("No high-fan-in hubs found.");
    for (const h of s.topHubs.slice(0, 10)) {
      lines.push(`- \`${h.path}\` ← ${h.fanIn} importers`);
    }
  }

  if (showAll || findMode === "cycles") {
    lines.push("", `## Circular Dependencies (${s.cycles.length})`);
    if (s.cycles.length === 0) lines.push("✅ none");
    for (const c of s.cycles.slice(0, 10)) {
      lines.push(`- ${c.map((p) => `\`${p}\``).join(" → ")} → \`${c[0]}\``);
    }
    if (s.cycles.length > 10)
      lines.push(`- ... and ${s.cycles.length - 10} more`);
  }

  if (s.externalDeps.length > 0 && showAll) {
    lines.push("", `## External Dependencies (${s.externalDeps.length})`);
    for (const d of s.externalDeps.slice(0, 30)) lines.push(`- \`${d}\``);
    if (s.externalDeps.length > 30)
      lines.push(`- ... and ${s.externalDeps.length - 30} more`);
  }

  if (s.parseErrors.length > 0) {
    lines.push("", `## Parse Errors (${s.parseErrors.length})`);
    for (const e of s.parseErrors.slice(0, 5))
      lines.push(`- \`${e.file}\`: ${e.error}`);
    if (s.parseErrors.length > 5)
      lines.push(`- ... and ${s.parseErrors.length - 5} more`);
  }

  lines.push(
    "",
    `**Summary:** ${s.totalFiles} source files, ${s.totalInternalEdges} internal edges, ${s.externalDeps.length} external deps`,
  );
  return lines.join("\n");
}

function formatImpact(
  target: string,
  impact: { broken: string[]; total: number },
): string {
  const lines: string[] = [];
  lines.push(`## Impact: \`${target}\``);
  if (impact.total === 0) {
    lines.push("✅ Nothing else depends on this file.");
    return lines.join("\n");
  }
  lines.push(
    `**${impact.total} file${impact.total === 1 ? "" : "s"}** transitively depend on \`${target}\`:`,
  );
  for (const p of impact.broken.slice(0, 30)) lines.push(`- \`${p}\``);
  if (impact.broken.length > 30)
    lines.push(`- ... and ${impact.broken.length - 30} more`);
  return lines.join("\n");
}
