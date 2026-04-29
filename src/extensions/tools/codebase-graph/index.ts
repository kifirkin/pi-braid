import { createLogger } from "../../../lib/logger.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const log = createLogger("codebase-graph");

// ── Types ─────────────────────────────────────────────────────────────────────

interface Node {
  path: string;
  name: string;
  exports: string[];
  imports: string[];
  importedBy: string[];
  isEntry: boolean;
}

interface Edge {
  source: string;
  target: string;
  raw: string;
  isExternal: boolean;
}

// ── Graph Engine ───────────────────────────────────────────────────────────────

class CodebaseGraph {
  private root: string;
  private nodes: Map<string, Node> = new Map();
  private edges: Edge[] = [];
  private externalImports: Set<string> = new Set();
  private parseErrors: string[] = [];

  constructor(root: string) {
    this.root = root;
  }

  async parse(includePatterns?: string[], excludePatterns?: string[]): Promise<void> {
    const include = includePatterns ?? ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
    const exclude = excludePatterns ?? [
      "**/*.d.ts",
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
    ];

    const tsFiles = await this.glob(this.root, include, exclude);

    for (const file of tsFiles) {
      await this.parseFile(file);
    }

    // Second pass: resolve importedBy
    for (const [pathStr, node] of this.nodes) {
      for (const imp of node.imports) {
        const target = this.nodes.get(imp);
        if (target && !target.importedBy.includes(pathStr)) {
          target.importedBy.push(pathStr);
        }
      }
    }
  }

  private async glob(root: string, include: string[], exclude: string[]): Promise<string[]> {
    const results: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 20) return; // safety limit
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const rel = path.relative(root, full).replace(/\\/g, "/");
            if (exclude.some((p) => matchGlob(rel, p))) continue;
            await walk(full, depth + 1);
          } else {
            const rel = path.relative(root, full).replace(/\\/g, "/");
            if (exclude.some((p) => matchGlob(rel, p))) continue;
            if (include.some((p) => matchGlob(rel, p))) {
              results.push(full);
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    await walk(root, 0);
    return results;
  }

  private async parseFile(filePath: string): Promise<void> {
    const rel = path.relative(this.root, filePath).replace(/\\/g, "/");
    const name = path.basename(filePath, path.extname(filePath));

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (e: unknown) {
      this.parseErrors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const imports = this.extractImports(content, path.dirname(rel));
    const exports = this.extractExports(content);
    const isEntry = name === "index" || name.startsWith("index.");

    const node: Node = {
      path: rel,
      name,
      exports,
      imports: imports
        .filter((i) => !i.isExternal)
        .map((i) => this.resolveImport(i.specifier, path.dirname(rel))),
      importedBy: [],
      isEntry,
    };

    this.nodes.set(rel, node);

    for (const imp of imports) {
      if (imp.isExternal) {
        this.externalImports.add(imp.specifier);
      } else {
        const resolved = this.resolveImport(imp.specifier, path.dirname(rel));
        this.edges.push({ source: rel, target: resolved, raw: imp.raw, isExternal: false });
      }
    }
  }

  private extractImports(
    content: string,
    _fromDir: string,
  ): Array<{ specifier: string; isExternal: boolean; raw: string }> {
    const imports: Array<{ specifier: string; isExternal: boolean; raw: string }> = [];
    const importRe = /^import\s+(?:type\s+)?(?:.+?\s+from\s+)?['"]([^'"]+)['"]/gm;
    // eslint-disable-next-line no-empty-pattern
    for (const m of content.matchAll(importRe)) {
      const specifier = m[1];
      const isExternal = !specifier.startsWith(".");
      imports.push({ specifier, isExternal, raw: m[0] });
    }
    return imports;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const re =
      /^export\s+(?:type\s+|interface\s+)?(?:const|function|class|interface|type|enum)\s+(\w+)/gm;
    for (const m of content.matchAll(re)) {
      exports.push(m[1]);
    }
    const namedRe = /^export\s+\{([^}]+)\}/gm;
    for (const m of content.matchAll(namedRe)) {
      for (const name of m[1].split(",")) {
        exports.push(name.trim());
      }
    }
    return [...new Set(exports)];
  }

  private resolveImport(specifier: string, fromDir: string): string {
    // Strip extensions
    let base = specifier;
    for (const ext of [".js", ".jsx", ".ts", ".tsx"]) {
      if (base.endsWith(ext)) base = base.slice(0, -ext.length);
    }

    const basePath = path.posix.join(this.root, fromDir, base);
    const candidates = [
      path.posix.relative(this.root, basePath),
      path.posix.relative(this.root, basePath + ".ts"),
      path.posix.relative(this.root, basePath + ".tsx"),
      path.posix.relative(this.root, path.posix.join(path.dirname(basePath), "index.ts")),
      path.posix.relative(this.root, path.posix.join(path.dirname(basePath), "index.tsx")),
    ].map((p) => p.replace(/\\/g, "/"));

    for (const c of candidates) {
      if (this.nodes.has(c)) return c;
    }
    return candidates[0]; // best guess
  }

  // ── Analysis ────────────────────────────────────────────────────────────────

  findDeadEnds(): Node[] {
    return [...this.nodes.values()].filter((n) => n.importedBy.length === 0 && !n.isEntry);
  }

  findOrphans(): Node[] {
    return [...this.nodes.values()].filter(
      (n) => n.imports.length === 0 && n.importedBy.length === 0 && !n.isEntry,
    );
  }

  findHubs(topN = 10): Node[] {
    return [...this.nodes.values()]
      .filter((n) => n.importedBy.length >= 3)
      .sort((a, b) => b.importedBy.length - a.importedBy.length)
      .slice(0, topN);
  }

  findCircularDeps(): string[][] {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[][] = [];
    const path: string[] = [];

    const dfs = (node: string): void => {
      if (!this.nodes.has(node)) return;
      if (visited.has(node)) return;

      visited.add(node);
      recStack.add(node);
      path.push(node);

      const imports = this.nodes.get(node)?.imports ?? [];
      for (const imp of imports) {
        if (!this.nodes.has(imp)) continue;
        if (!visited.has(imp)) {
          dfs(imp);
        } else if (recStack.has(imp)) {
          const idx = path.indexOf(imp);
          cycles.push([...path.slice(idx), imp]);
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of this.nodes.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    return cycles;
  }

  impactAnalysis(targetFile: string): {
    target: string;
    directDependents: string[];
    directCount: number;
    totalImpact: string[];
    totalCount: number;
    risk: string;
  } {
    const rel = targetFile.startsWith(this.root)
      ? path.relative(this.root, targetFile).replace(/\\/g, "/")
      : targetFile;

    const direct = [...(this.nodes.get(rel)?.importedBy ?? [])];

    const transitive = new Set(direct);
    const queue = [...direct];
    while (queue.length) {
      const current = queue.shift()!;
      const importers = this.nodes.get(current)?.importedBy ?? [];
      for (const dep of importers) {
        if (!transitive.has(dep)) {
          transitive.add(dep);
          queue.push(dep);
        }
      }
    }

    transitive.delete(rel);

    return {
      target: rel,
      directDependents: direct,
      directCount: direct.length,
      totalImpact: [...transitive],
      totalCount: transitive.size,
      risk: transitive.size > 20 ? "high" : transitive.size > 5 ? "medium" : "low",
    };
  }

  summary(): {
    totalFiles: number;
    totalEdges: number;
    totalExternalDeps: number;
    deadEnds: string[];
    orphans: string[];
    topHubs: Array<{ path: string; fanIn: number }>;
    circularDeps: string[][];
    circularCount: number;
    parseErrors: string[];
  } {
    const deadEnds = this.findDeadEnds();
    const orphans = this.findOrphans();
    const hubs = this.findHubs();
    const cycles = this.findCircularDeps();

    return {
      totalFiles: this.nodes.size,
      totalEdges: this.edges.length,
      totalExternalDeps: this.externalImports.size,
      deadEnds: deadEnds.map((n) => n.path),
      orphans: orphans.map((n) => n.path),
      topHubs: hubs.map((n) => ({ path: n.path, fanIn: n.importedBy.length })),
      circularDeps: cycles.slice(0, 10),
      circularCount: cycles.length,
      parseErrors: this.parseErrors,
    };
  }
}

function matchGlob(filePath: string, pattern: string): boolean {
  // Simple glob: **/*.ts, *.d.ts, node_modules/**
  const normalized = filePath.replace(/\\/g, "/");
  if (pattern === "**/*") return false; // matches nothing intentionally
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "[^/]*(?:/[^/]*)*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return regex.test(normalized);
}

// ── Tool Schema ───────────────────────────────────────────────────────────────

const codebaseGraphSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Root directory to analyze (default: cwd)" })),
  find: Type.Optional(
    Type.Union(
      [
        Type.Literal("dead-ends", { description: "Files exported but never imported internally" }),
        Type.Literal("orphans", { description: "Isolated files: no imports, no importers" }),
        Type.Literal("hubs", { description: "Files imported by 3+ other files" }),
        Type.Literal("cycles", { description: "Circular dependency chains" }),
        Type.Literal("all", { description: "Full summary report" }),
      ],
      { description: "What to find: dead-ends, orphans, hubs, cycles, or all" },
    ),
  ),
  impact: Type.Optional(
    Type.String({
      description: "File path to run impact analysis on — shows what breaks if this file changes",
    }),
  ),
  include: Type.Optional(
    Type.Array(Type.String(), {
      description: "Include patterns (default: ['**/*.ts', '**/*.tsx'])",
    }),
  ),
  exclude: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude patterns (default: ['**/*.d.ts', '**/*.spec.ts', '**/node_modules/**'])",
    }),
  ),
});

// ── Extension ─────────────────────────────────────────────────────────────────

export default function codebaseGraphExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codebase_graph",
    label: "Codebase Graph",
    description:
      "Analyze TypeScript/JS dependency graph. Find dead code, orphans, hubs, circular deps, and predict change impact. Use when you need to understand import relationships, find integration gaps, or assess risk before refactoring.",
    parameters: codebaseGraphSchema,
    execute: async (
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      let resolvedPath = params.path ?? ".";
      if (resolvedPath.startsWith("~/") || resolvedPath === "~") {
        resolvedPath = resolvedPath.replace(/^~/, os.homedir());
      }
      const isAbsolute = path.isAbsolute(resolvedPath);
      const rootPath = isAbsolute ? resolvedPath : path.join(ctx.cwd, resolvedPath);

      // Validate
      try {
        const stat = await fs.stat(rootPath);
        if (!stat.isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `Not a directory: ${rootPath}` }],
            details: {},
          };
        }
      } catch {
        return {
          content: [{ type: "text" as const, text: `Path not found: ${rootPath}` }],
          details: {},
        };
      }

      const graph = new CodebaseGraph(rootPath);

      try {
        await graph.parse(params.include, params.exclude);
      } catch (e: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      const output: string[] = [];

      // Impact analysis
      if (params.impact) {
        const impact = graph.impactAnalysis(params.impact);
        const riskColor = impact.risk === "high" ? "🔴" : impact.risk === "medium" ? "🟡" : "🟢";

        output.push(`# Impact Analysis: \`${impact.target}\``);
        output.push("");
        output.push(`**Risk:** ${riskColor} ${impact.risk.toUpperCase()}`);
        output.push(`**Direct dependents:** ${impact.directCount}`);
        output.push(`**Total transitive impact:** ${impact.totalCount}`);
        output.push("");

        if (impact.directDependents.length) {
          output.push("### Direct Dependents");
          for (const f of impact.directDependents) {
            output.push(`- \`${f}\``);
          }
          output.push("");
        }

        if (impact.totalImpact.length) {
          output.push(`### All Affected (${impact.totalImpact.length})`);
          for (const f of impact.totalImpact.slice(0, 20)) {
            output.push(`- \`${f}\``);
          }
          if (impact.totalImpact.length > 20) {
            output.push(`- ... and ${impact.totalImpact.length - 20} more`);
          }
        }

        return {
          content: [{ type: "text" as const, text: output.join("\n") }],
          details: impact,
        };
      }

      // Find specific patterns
      if (params.find && params.find !== "all") {
        output.push(`# ${params.find.replace("-", " ").toUpperCase()}: ${path.basename(rootPath)}`);
        output.push("");

        if (params.find === "dead-ends") {
          const items = graph.findDeadEnds();
          if (!items.length) {
            output.push("✅ No dead ends found.");
          } else {
            output.push(`Found **${items.length}** dead ends (exported but never imported):\n`);
            for (const n of items) {
              output.push(`- \`${n.path}\` (fan_in=${n.importedBy.length})`);
            }
          }
        } else if (params.find === "orphans") {
          const items = graph.findOrphans();
          if (!items.length) {
            output.push("✅ No orphans found.");
          } else {
            output.push(`Found **${items.length}** orphans:\n`);
            for (const n of items) {
              output.push(`- \`${n.path}\``);
            }
          }
        } else if (params.find === "hubs") {
          const items = graph.findHubs();
          if (!items.length) {
            output.push("No high-fan-in hubs found.");
          } else {
            output.push(`Top **${items.length}** hubs by fan-in:\n`);
            for (const n of items) {
              output.push(`- \`${n.path}\` ← ${n.importedBy.length} files`);
            }
          }
        } else if (params.find === "cycles") {
          const cycles = graph.findCircularDeps();
          if (!cycles.length) {
            output.push("✅ No circular dependencies found.");
          } else {
            output.push(`Found **${cycles.length}** circular dependencies:\n`);
            for (const c of cycles.slice(0, 10)) {
              output.push(`↻ ${c.map((p) => `\`${path.basename(p)}\``).join(" → ")}`);
            }
          }
        }

        return {
          content: [{ type: "text" as const, text: output.join("\n") }],
          details: {},
        };
      }

      // Full summary
      const s = graph.summary();
      output.push(`# Codebase Graph: ${path.basename(rootPath)}`);
      output.push(`\`\`\`${rootPath}\`\`\``);
      output.push("");
      output.push("## Summary");
      output.push(`- **Files:** ${s.totalFiles}`);
      output.push(`- **Edges:** ${s.totalEdges}`);
      output.push(`- **External deps:** ${s.totalExternalDeps}`);
      output.push("");

      if (s.deadEnds.length) {
        output.push(`## 🔴 Dead Ends (${s.deadEnds.length}): exported but never imported`);
        for (const p of s.deadEnds.slice(0, 10)) {
          output.push(`- \`${p}\``);
        }
        if (s.deadEnds.length > 10) output.push(`- ... and ${s.deadEnds.length - 10} more`);
        output.push("");
      }

      if (s.orphans.length) {
        output.push(`## ⚪ Orphans (${s.orphans.length}): isolated files`);
        for (const p of s.orphans.slice(0, 10)) {
          output.push(`- \`${p}\``);
        }
        if (s.orphans.length > 10) output.push(`- ... and ${s.orphans.length - 10} more`);
        output.push("");
      }

      if (s.topHubs.length) {
        output.push("## ⭐ Top Hubs (most imported)");
        for (const h of s.topHubs.slice(0, 5)) {
          output.push(`- \`${h.path}\` ← ${h.fanIn} files`);
        }
        output.push("");
      }

      if (s.circularDeps.length) {
        output.push(`## ↻ Circular Dependencies (${s.circularCount})`);
        for (const c of s.circularDeps.slice(0, 5)) {
          output.push(`\`${c.map((p) => path.basename(p)).join(" → ")}\``);
        }
        output.push("");
      }

      if (s.parseErrors.length) {
        output.push(`## ⚠️ Parse Errors (${s.parseErrors.length})`);
        for (const e of s.parseErrors.slice(0, 5)) {
          output.push(`- ${e}`);
        }
      }

      output.push("");
      output.push(
        "> Use `codebase_graph(impact='src/foo.ts')` to see what breaks if you change a file.",
      );
      output.push("> Use `codebase_graph(find='cycles')` to find circular dependencies.");

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        details: s,
      };
    },
  });
}
