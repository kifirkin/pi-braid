import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import * as os from "node:os";
import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const log = {
  info: (msg: string) => console.log(`[codebase-graph] ${msg}`),
  debug: () => {},
  warn: (msg: string) => console.warn(`[codebase-graph] ${msg}`),
  error: (msg: string) => console.error(`[codebase-graph] ${msg}`),
};

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

class GraphAnalyzer {
  private root: string;
  private nodes: Map<string, Node> = new Map();
  private edges: Edge[] = [];
  private externalImports: Set<string> = new Set();
  private parseErrors: string[] = [];

  constructor(root: string) {
    this.root = root;
  }

  async analyze(): Promise<this> {
    const files = await this.findFiles(this.root);
    for (const file of files) {
      await this.parseFile(file);
    }
    this.resolveImportedBy();
    return this;
  }

  private async findFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = pathMod.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
            results.push(...(await this.findFiles(fullPath)));
          }
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission denied
    }
    return results;
  }

  private async parseFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const imports: string[] = [];
      const exports: string[] = [];

      const importRegex = /(?:from\s+['"])([^'"]+)(?:['"])/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const target = match[1];
        if (target.startsWith(".")) {
          imports.push(target);
          this.edges.push({ source: filePath, target, raw: match[0], isExternal: false });
        } else {
          this.externalImports.add(target);
          this.edges.push({ source: filePath, target, raw: match[0], isExternal: true });
        }
      }

      if (content.includes("export default") || content.includes("export function") || content.includes("export const") || content.includes("export class") || content.includes("export interface") || content.includes("export type")) {
        exports.push(filePath);
      }

      const relPath = pathMod.relative(this.root, filePath);
      this.nodes.set(relPath, { path: relPath, name: pathMod.basename(filePath), exports, imports, importedBy: [], isEntry: false });
    } catch (err) {
      this.parseErrors.push(`${filePath}: ${err}`);
    }
  }

  private resolveImportedBy(): void {
    for (const edge of this.edges) {
      if (edge.isExternal) continue;
      const resolved = pathMod.resolve(pathMod.dirname(edge.source), edge.target);
      const rel = pathMod.relative(this.root, resolved) + ".ts";
      const targetNode = this.nodes.get(rel) || this.nodes.get(rel.replace(/\.ts$/, ".tsx"));
      if (targetNode) {
        targetNode.importedBy.push(edge.source);
        const srcRel = pathMod.relative(this.root, edge.source);
        const srcNode = this.nodes.get(srcRel);
        if (srcNode) srcNode.isEntry = srcNode.importedBy.length === 0 && !srcNode.exports.length;
      }
    }
  }

  getDeadEnds(): string[] {
    return [...this.nodes.values()].filter((n) => n.exports.length > 0 && n.importedBy.length === 0).map((n) => n.path);
  }

  getOrphans(): string[] {
    return [...this.nodes.values()].filter((n) => n.imports.length === 0 && n.importedBy.length === 0).map((n) => n.path);
  }

  getHubs(minFanIn = 3): Array<{ path: string; name: string; fanIn: number }> {
    return [...this.nodes.values()]
      .filter((n) => n.importedBy.length >= minFanIn)
      .sort((a, b) => b.importedBy.length - a.importedBy.length)
      .map((n) => ({ path: n.path, name: n.name, fanIn: n.importedBy.length }));
  }

  getCycles(): string[][] {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (nodePath: string, dfsPath: string[]) => {
      if (stack.has(nodePath)) {
        const idx = dfsPath.indexOf(nodePath);
        if (idx >= 0) cycles.push(dfsPath.slice(idx));
        return;
      }
      if (visited.has(nodePath)) return;
      visited.add(nodePath);
      stack.add(nodePath);
      dfsPath.push(nodePath);

      const node = this.nodes.get(nodePath);
      if (node) {
        for (const imp of node.imports) {
          const resolved = pathMod.resolve(pathMod.dirname(pathMod.join(this.root, nodePath)), imp);
          const rel = pathMod.relative(this.root, resolved) + ".ts";
          const target = this.nodes.get(rel) || this.nodes.get(rel.replace(/\.ts$/, ".tsx"));
          if (target) dfs(target.path, [...dfsPath]);
        }
      }

      stack.delete(nodePath);
    };

    for (const nodePath of this.nodes.keys()) dfs(nodePath, []);
    return cycles;
  }

  getImpactAnalysis(rootFile: string): { broken: string[]; total: number } {
    const broken: string[] = [];
    const rootRel = rootFile.replace(/^\.\//, "");
    const visited = new Set<string>();

    const dfs = (filePath: string) => {
      for (const node of this.nodes.values()) {
        if (visited.has(node.path)) continue;
        if (node.imports.some((imp) => {
          const resolved = pathMod.resolve(pathMod.join(this.root, pathMod.dirname(node.path)), imp);
          const rel = pathMod.relative(this.root, resolved);
          return rel === filePath || rel === filePath.replace(/\.ts$/, ".tsx");
        })) {
          visited.add(node.path);
          broken.push(node.path);
          dfs(node.path);
        }
      }
    };

    dfs(rootRel);
    return { broken: [...new Set(broken)], total: broken.length };
  }

  getSummary() {
    return {
      totalFiles: this.nodes.size,
      totalEdges: this.edges.filter((e) => !e.isExternal).length,
      totalExternalDeps: this.externalImports.size,
      deadEnds: this.getDeadEnds(),
      orphans: this.getOrphans(),
      topHubs: this.getHubs(3),
      circularDeps: this.getCycles(),
      parseErrors: this.parseErrors,
    };
  }
}

// ── Schema ─────────────────────────────────────────────────────────────────

const graphSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Root directory (default: cwd)" })),
  find: Type.Optional(Type.Union([
    Type.Literal("dead-ends"),
    Type.Literal("orphans"),
    Type.Literal("hubs"),
    Type.Literal("cycles"),
    Type.Literal("all"),
  ], { description: "What to find" })),
  impact: Type.Optional(Type.String({ description: "File path for impact analysis" })),
});

// ── Extension Factory ──────────────────────────────────────────────────────

export default function codebaseGraphExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codebase_graph",
    label: "Codebase Graph",
    description:
      "Analyze TypeScript/JS dependency graph. Find dead code, orphans, hubs, circular deps, and predict change impact.",
    parameters: graphSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const rootDir = (params.path as string) ?? ctx.cwd ?? ".";
      const resolvedRoot = rootDir.startsWith("~") ? rootDir.replace("~", os.homedir()) : pathMod.resolve(rootDir);
      const findMode = params.find as string | undefined;
      const impactFile = params.impact as string | undefined;

      log.info(`Analyzing ${resolvedRoot}...`);
      const analyzer = new GraphAnalyzer(resolvedRoot);
      await analyzer.analyze();
      const s = analyzer.getSummary();
      const output: string[] = [];

      if (impactFile) {
        const impact = analyzer.getImpactAnalysis(impactFile);
        output.push(`## Impact Analysis: \`${impactFile}\``);
        output.push(`**${impact.broken.length} file(s)** would break if \`${impactFile}\` changes:`);
        for (const b of impact.broken.slice(0, 20)) output.push(`- \`${b}\``);
        if (impact.broken.length > 20) output.push(`- ... and ${impact.broken.length - 20} more`);
        return { content: [{ type: "text" as const, text: output.join("\n") }], details: impact };
      }

      if (findMode && findMode !== "all") {
        switch (findMode) {
          case "dead-ends":
            output.push(`# DEAD ENDS: ${pathMod.basename(resolvedRoot)}`);
            if (s.deadEnds.length) { for (const p of s.deadEnds) output.push(p); }
            else output.push("✅ No dead ends found.");
            break;
          case "orphans":
            output.push(`# ORPHANS: ${pathMod.basename(resolvedRoot)}`);
            if (s.orphans.length) { for (const p of s.orphans) output.push(p); }
            else output.push("✅ No orphans found.");
            break;
          case "hubs":
            output.push(`# HUBS: ${pathMod.basename(resolvedRoot)}`);
            if (s.topHubs.length) { for (const h of s.topHubs) output.push(`${h.path} ← ${h.fanIn} importers`); }
            else output.push("No high-fan-in hubs found.");
            break;
          case "cycles":
            output.push(`# CYCLES: ${pathMod.basename(resolvedRoot)}`);
            if (s.circularDeps.length) { for (const c of s.circularDeps) output.push(c.join(" → ")); }
            else output.push("✅ No circular dependencies found.");
            break;
        }
        return { content: [{ type: "text" as const, text: output.join("\n") }], details: { path: resolvedRoot } };
      }

      output.push(`# Dependency Graph: ${resolvedRoot}`);
      if (s.deadEnds.length) {
        output.push(`## Dead Ends (${s.deadEnds.length})`);
        for (const p of s.deadEnds.slice(0, 10)) output.push(`- \`${p}\``);
        if (s.deadEnds.length > 10) output.push(`- ... and ${s.deadEnds.length - 10} more`);
      }
      if (s.orphans.length) {
        output.push(`## Orphans (${s.orphans.length})`);
        for (const p of s.orphans.slice(0, 10)) output.push(`- \`${p}\``);
        if (s.orphans.length > 10) output.push(`- ... and ${s.orphans.length - 10} more`);
      }
      if (s.topHubs.length) {
        output.push("## Top Hubs");
        for (const h of s.topHubs.slice(0, 5)) output.push(`- \`${h.path}\` ← ${h.fanIn} files`);
      }
      if (s.circularDeps.length) {
        output.push(`## Circular Dependencies (${s.circularDeps.length})`);
        for (const c of s.circularDeps.slice(0, 5)) output.push(c.map((p) => pathMod.basename(p)).join(" → "));
      }
      if (s.parseErrors.length) {
        output.push(`## Parse Errors (${s.parseErrors.length})`);
        for (const e of s.parseErrors.slice(0, 5)) output.push(`- ${e}`);
      }
      output.push(`\n**Summary:** ${s.totalFiles} files, ${s.totalEdges} edges, ${s.totalExternalDeps} external deps`);

      return { content: [{ type: "text" as const, text: output.join("\n") }], details: s };
    },
  });
}
