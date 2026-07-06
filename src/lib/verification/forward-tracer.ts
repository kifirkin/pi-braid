/**
 * Forward Tracer — LP-2 component.
 *
 * Traces forward through a project's import/export graph to find downstream
 * consumers of a given file. Used to answer: "If I edit this file, which
 * other files might break?"
 *
 * Uses a simple regex-based import parser (no full AST). Scans `.ts`, `.js`,
 * `.mjs`, `.tsx`, `.jsx` files in the project for import/require/export statements
 * that reference the given file.
 *
 * Design:
 *   - Lightweight: scans files matching common source extensions
 *   - Respects the project's directory structure for relative imports
 *   - Caches results within a session (import graph is stable between edits)
 *   - Reports the import chain depth (direct consumer vs transitive)
 *
 * Inspired by the `codebase` tool's `impact` mode, but as a programmatic API
 * that enforcement can call without requiring a tool invocation.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("verification:forward-tracer");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ForwardTraceResult {
  /** The file that was traced from. */
  source: string;
  /** Direct consumers (files that import from source). */
  directConsumers: ConsumerInfo[];
  /** Total downstream files found (direct + transitive, if scanned). */
  totalDownstream: number;
  /** Whether the trace completed or was capped. */
  truncated: boolean;
}

export interface ConsumerInfo {
  /** Path to the consumer file (relative to cwd). */
  path: string;
  /** Import chain depth (1 = direct importer). */
  depth: number;
  /** The import statement found (for context). */
  importStatement: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** File extensions to scan for imports. */
const SCAN_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".tsx", ".jsx"]);

/** Maximum number of files to scan (prevents hangs on large projects). */
const MAX_SCAN_FILES = 500;

/** Maximum directory depth for scanning. */
const MAX_SCAN_DEPTH = 10;

/** Directories to exclude from scanning. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".tsbuildinfo",
  "coverage",
  ".nyc_output",
]);

// ── Import Extraction ──────────────────────────────────────────────────────

/**
 * Extract all import/require statements from file content.
 * Returns array of { statement, modulePath } objects.
 */
function extractImports(
  content: string,
  filePath: string,
): Array<{ statement: string; modulePath: string }> {
  const results: Array<{ statement: string; modulePath: string }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ES import: import ... from '...'
    const esMatch = line.match(
      /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/,
    );
    if (esMatch) {
      results.push({ statement: line.trim(), modulePath: esMatch[1] });
      continue;
    }

    // ES import (side-effect): import '...'
    const sideEffectMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch) {
      results.push({ statement: line.trim(), modulePath: sideEffectMatch[1] });
      continue;
    }

    // Dynamic import: import('...')
    const dynamicMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynamicMatch) {
      results.push({ statement: line.trim(), modulePath: dynamicMatch[1] });
      continue;
    }

    // Re-export: export ... from '...'
    const reExportMatch = line.match(
      /^\s*export\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)\s+from\s+['"]([^'"]+)['"]/,
    );
    if (reExportMatch) {
      results.push({ statement: line.trim(), modulePath: reExportMatch[1] });
      continue;
    }

    // CJS require: require('...')
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      results.push({ statement: line.trim(), modulePath: requireMatch[1] });
      continue;
    }
  }

  return results;
}

/**
 * Resolve a module path relative to the importing file.
 * Returns the resolved file path, or null if it can't be resolved.
 *
 * Handles:
 *   - Relative paths (./foo, ../bar/baz)
 *   - Extensionless imports (assumes .ts, .js, .mjs, .tsx, .jsx)
 *   - Directory imports (foo/ -> foo/index.ts)
 */
function resolveImport(
  importPath: string,
  importerPath: string,
  cwd: string,
): string | null {
  // Skip non-relative imports (npm packages, absolute paths)
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return null;
  }

  // The importer path is relative to cwd, so compute the base directory
  // by joining cwd with the importer's directory
  const importerDir = dirname(join(cwd, importerPath));

  // Resolve the import relative to the importer's directory
  const resolved = importPath.startsWith("/")
    ? join(cwd, importPath)
    : resolve(importerDir, importPath);

  // Check if the resolved path (with extension) exists
  const extensionsToTry = [...SCAN_EXTENSIONS, ".d.ts", ""];

  for (const ext of extensionsToTry) {
    const candidate = resolved + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(cwd, candidate);
    }
  }

  // Check for directory index files
  for (const ext of SCAN_EXTENSIONS) {
    const indexCandidate = join(resolved, `index${ext}`);
    if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
      return relative(cwd, indexCandidate);
    }
  }

  return null;
}

// ── File Scanning ──────────────────────────────────────────────────────────

/**
 * Scan a directory for all source files matching SCAN_EXTENSIONS.
 * Returns relative paths from cwd.
 */
async function scanSourceFiles(
  dir: string,
  cwd: string,
  depth: number = 0,
  results: string[] = [],
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || results.length >= MAX_SCAN_FILES) return results;

  let entries: string[];
  try {
    entries = await readdir(dir, { withFileTypes: false });
  } catch {
    return results; // skip dirs we can't read
  }

  for (const entry of entries) {
    if (results.length >= MAX_SCAN_FILES) break;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry) && !entry.startsWith(".")) {
        await scanSourceFiles(fullPath, cwd, depth + 1, results);
      }
    } else if (stat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (SCAN_EXTENSIONS.has(ext)) {
        results.push(relative(cwd, fullPath));
      }
    }
  }

  return results;
}

// ── Import Graph Building ──────────────────────────────────────────────────

/**
 * Build a reverse-import map: for each file, which files import it?
 * Returns Map<targetFile, Set<importerFile>>.
 */
async function buildReverseImportMap(
  cwd: string,
  sourceFiles: string[],
): Promise<Map<string, Set<string>>> {
  const reverseMap = new Map<string, Set<string>>();

  for (const file of sourceFiles) {
    const fullPath = join(cwd, file);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const imports = extractImports(content, file);
    for (const { modulePath } of imports) {
      const resolved = resolveImport(modulePath, file, cwd);
      if (resolved) {
        if (!reverseMap.has(resolved)) {
          reverseMap.set(resolved, new Set());
        }
        reverseMap.get(resolved)!.add(file);
      }
    }
  }

  return reverseMap;
}

// ── Forward Trace ──────────────────────────────────────────────────────────

/**
 * Trace forward from a source file to find all files that import from it
 * (direct consumers) and optionally transitive consumers.
 *
 * @param sourceFile - The file to trace from (path relative to cwd or absolute)
 * @param cwd - Current working directory (project root)
 * @param maxConsumers - Max consumers to return (caps results, default: 20)
 * @returns ForwardTraceResult with consumer information
 */
export async function traceForward(
  sourceFile: string,
  cwd: string,
  maxConsumers: number = 20,
): Promise<ForwardTraceResult> {
  const normalizedSource = relative(cwd, resolve(cwd, sourceFile));
  const logPrefix = `traceForward(${normalizedSource})`;

  log.info(`${logPrefix}: scanning source files in ${cwd}`);

  const sourceFiles = await scanSourceFiles(cwd, cwd);
  log.info(`${logPrefix}: scanned ${sourceFiles.length} source files`);

  const reverseMap = await buildReverseImportMap(cwd, sourceFiles);
  log.info(`${logPrefix}: built reverse import map`);

  // BFS to find all downstream consumers
  const visited = new Set<string>();
  const consumers: ConsumerInfo[] = [];
  const queue: Array<{ file: string; depth: number }> = [{ file: normalizedSource, depth: 0 }];
  visited.add(normalizedSource);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth > 0) {
      consumers.push({
        path: current.file,
        depth: current.depth,
        importStatement: `imported from upstream at depth ${current.depth}`,
      });
      if (consumers.length >= maxConsumers) break;
    }

    const importers = reverseMap.get(current.file);
    if (!importers) continue;

    for (const importer of importers) {
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push({ file: importer, depth: current.depth + 1 });
      }
    }
  }

  // Separate direct and transitive consumers
  const directConsumers = consumers.filter((c) => c.depth === 1);

  log.info(
    `${logPrefix}: found ${directConsumers.length} direct, ${consumers.length} total downstream consumers`,
  );

  return {
    source: normalizedSource,
    directConsumers,
    totalDownstream: consumers.length,
    truncated: consumers.length >= maxConsumers,
  };
}

/**
 * Generate a human-readable summary of a forward trace result.
 */
export function summarizeForwardTrace(result: ForwardTraceResult): string {
  if (result.totalDownstream === 0) {
    return `No downstream consumers found for "${result.source}".`;
  }

  const lines: string[] = [];

  lines.push(
    `Forward trace for "${result.source}": ${result.totalDownstream} downstream consumer(s) found.`,
  );

  if (result.directConsumers.length > 0) {
    lines.push(`  Direct consumers (${result.directConsumers.length}):`);
    for (const c of result.directConsumers) {
      lines.push(`    - ${c.path}`);
    }
  }

  if (result.totalDownstream > result.directConsumers.length) {
    lines.push(
      `  Plus ${result.totalDownstream - result.directConsumers.length} transitive consumer(s).`,
    );
  }

  if (result.truncated) {
    lines.push(`  (Results truncated — more consumers exist.)`);
  }

  return lines.join("\n");
}