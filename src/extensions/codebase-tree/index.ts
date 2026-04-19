/**
 * Codebase Tree Explorer - Fast directory tree visualization for agents
 *
 * Provides a `codebase_tree` tool that:
 * - Traverses directory structure with intelligent filtering
 * - Shows file statistics (size, lines, type)
 * - Highlights important files (README, tests, configs)
 * - Supports depth limiting and pattern matching
 * - Fast traversal for large codebases
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

// Default patterns to exclude (small, non-informative files)
const DEFAULT_EXCLUDE = [".DS_Store", "Thumbs.db", "*.log", ".env.local", ".env.*.local"];

// Directories that are shown in tree but with hidden content
// These are typically large/dot directories that would produce huge listings
// They can be requested as root to see their actual structure
const TRUNCATED_DIRS = [
	// Version control
	".git",
	".svn",
	".hg",

	// Package managers
	"node_modules",
	"bower_components",
	"jspm_packages",

	// Build outputs
	"dist",
	"build",
	".next",
	".nuxt",
	".output",
	".vercel",
	".netlify",

	// Caching
	".cache",
	".parcel-cache",
	".turbo",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".eslintcache",
	".nextcache",

	// Virtual environments
	"venv",
	".venv",
	"env",
	".env",
	"virtualenv",

	// Package registries
	".npm",
	".yarn",
	".pnpm-store",
	".bun-cache",

	// IDE specific
	".idea",
	".vscode",
	".vs",

	// Dot folders that might be large
	".pi",
	".ralph",
	".config",
	".local",
	".cache",
];

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	lines?: number;
	children?: TreeNode[];
	truncated?: boolean;
	truncatedReason?: string;
}

interface TreeStats {
	totalFiles: number;
	totalDirs: number;
	totalSize: number;
	totalLines: number;
	typeBreakdown: Record<string, number>;
}

interface TreeOptions {
	showStats: boolean;
}

// Tool schema
const codebaseTreeSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Root directory to explore (default: cwd)" })),
	maxDepth: Type.Optional(
		Type.Integer({ description: "Maximum depth to traverse (default: 3, max: 10)", default: 3 }),
	),
	exclude: Type.Optional(Type.Array(Type.String(), { description: "Patterns to exclude" })),
	include: Type.Optional(
		Type.Array(Type.String(), {
			description: "Only include files matching these patterns (e.g., ['*.ts', '*.tsx'])",
		}),
	),
	showStats: Type.Optional(
		Type.Boolean({ description: "Show file sizes and line counts (default: true)", default: true }),
	),
	compact: Type.Optional(
		Type.Boolean({ description: "Use compact single-line output (default: false)", default: false }),
	),
});

// Fast file stats with caching
const statCache = new Map<string, fsSync.Stats | null>();
async function fastStat(filePath: string): Promise<fsSync.Stats | null> {
	if (statCache.has(filePath)) {
		return statCache.get(filePath)!;
	}
	try {
		const stat = await fs.stat(filePath);
		statCache.set(filePath, stat);
		return stat;
	} catch {
		statCache.set(filePath, null);
		return null;
	}
}

// Check if path matches any pattern
function matchesPattern(name: string, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			const ext = pattern.slice(1);
			if (name.endsWith(ext)) return true;
		} else if (name === pattern) {
			return true;
		} else if (pattern.includes("*")) {
			const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
			if (regex.test(name)) return true;
		}
	}
	return false;
}

// Check if path should be excluded
function shouldExclude(name: string, exclude: string[]): boolean {
	if (exclude.includes(name)) return true;
	return matchesPattern(name, exclude);
}

// Check if directory should be truncated (shown but with hidden children)
function isTruncatedDir(name: string): boolean {
	if (TRUNCATED_DIRS.includes(name)) return true;
	// Match dot-prefixed directories that aren't explicitly listed
	if (name.startsWith(".") && TRUNCATED_DIRS.some((d) => d.startsWith(".") && name.startsWith(d.slice(0, 2)))) {
		return true;
	}
	return false;
}

// Cache for parsed gitignore patterns per directory (async cache: path → promise of patterns)
const gitignoreCache = new Map<string, Promise<string[] | null> | null>();

// Parse a gitignore file and return directory patterns
async function parseGitignore(filePath: string): Promise<string[] | null> {
	if (gitignoreCache.has(filePath)) {
		return gitignoreCache.get(filePath)!;
	}

	// Cache the pending promise so concurrent calls share it
	const pending = (async () => {
		try {
			const content = await fs.readFile(filePath, "utf-8");
			const patterns: string[] = [];
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				if (trimmed.startsWith("!")) continue;
				const pattern = trimmed.replace(/\/$/, "").replace(/\/\*\*$/, "").replace(/\*\*$/, "");
				if (pattern) patterns.push(pattern);
			}
			return patterns;
		} catch {
			return null;
		}
	})();
	gitignoreCache.set(filePath, pending);
	return pending;
}

// Get gitignore patterns from current directory and all parent directories
async function getGitignorePatterns(dirPath: string): Promise<{ patterns: string[]; baseDir: string }> {
	const patterns: string[] = [];
	let baseDir = dirPath;

	while (baseDir !== path.dirname(baseDir)) {
		const gitignorePath = path.join(baseDir, ".gitignore");
		const filePatterns = await parseGitignore(gitignorePath);
		if (filePatterns) {
			patterns.push(...filePatterns);
		}
		baseDir = path.dirname(baseDir);
	}

	return { patterns, baseDir };
}

// Check if a file or directory matches gitignore patterns
// filePath is the full path, entryName is just the name
function matchesGitignore(filePath: string, entryName: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		// Exact match
		if (pattern === entryName) return true;

		// Simple glob pattern like *.d.ts, *.js.map, etc.
		if (pattern.includes("*") && !pattern.includes("/")) {
			const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
			if (regex.test(entryName)) return true;
		}

		// Pattern with path like "packages/*/dist" should match dist inside any packages/*/
		if (pattern.includes("*") && pattern.includes("/")) {
			const parts = pattern.split("/");
			const pathParts = filePath.split("/");
			if (parts.length >= 2 && parts[parts.length - 1] === entryName) {
				const prefixParts = parts.slice(0, -1);
				if (pathParts.length >= prefixParts.length) {
					const endParts = pathParts.slice(-prefixParts.length - 1);
					const matches = prefixParts.every((p, i) => p === "*" || p === endParts[i]);
					if (matches) return true;
				}
			}
		}

		// Pattern like "foo/bar" should match if entry is inside a matching parent path
		return false;
	});
}

// Count lines in a file
async function countLines(filePath: string): Promise<number> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return content.split("\n").length;
	} catch {
		return 0;
	}
}

// Get file extension category
function getFileCategory(name: string): string {
	const ext = path.extname(name).toLowerCase();
	const categories: Record<string, string[]> = {
		TypeScript: [".ts", ".tsx", ".mts", ".cts"],
		JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
		Python: [".py", ".pyw"],
		JSON: [".json", ".jsonc", ".json5"],
		YAML: [".yaml", ".yml"],
		Markdown: [".md", ".mdx"],
		Config: [".toml", ".ini", ".cfg", ".conf"],
		CSS: [".css", ".scss", ".sass", ".less", ".styl"],
		HTML: [".html", ".htm"],
		Shell: [".sh", ".bash", ".zsh"],
		Binary: [".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".pdf", ".zip", ".tar", ".gz"],
	};

	for (const [category, extensions] of Object.entries(categories)) {
		if (extensions.includes(ext)) return category;
	}
	return ext || "Other";
}

// Build tree recursively
// isRoot indicates this is the explicitly requested root path (should never be truncated)
async function buildTree(
	dirPath: string,
	currentDepth: number,
	maxDepth: number,
	exclude: string[],
	include: string[] | undefined,
	showLines: boolean,
	stats: TreeStats,
	isRoot: boolean = false,
	): Promise<TreeNode | null> {
	const stat = await fastStat(dirPath);
	if (!stat) return null;

	const name = path.basename(dirPath);

	if (stat.isDirectory()) {
		// Check if this directory should be truncated
		// Note: Root path is never truncated - user explicitly requested it
		const truncatedByName = isTruncatedDir(name);
		// Also check gitignore patterns
		const { patterns: gitignorePatterns } = await getGitignorePatterns(dirPath);
		const truncatedByGitignore = matchesGitignore(dirPath, name, gitignorePatterns);
		// Root directory is never truncated - user explicitly requested it
		const truncated = !isRoot && (truncatedByName || truncatedByGitignore);
		const shouldExpand = !truncated && currentDepth < maxDepth;

		if (truncated) {
			// Truncated directory - show it but don't recurse
			stats.totalDirs++;
			const reason = truncatedByGitignore
				? "content hidden - matches .gitignore"
				: "content hidden - large/dot directory";
			return {
				name,
				path: dirPath,
				type: "directory",
				truncated: true,
				truncatedReason: reason,
				children: undefined,
			};
		}

		const children: TreeNode[] = [];

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });

			for (const entry of entries) {
				if (shouldExclude(entry.name, exclude)) continue;

				const childPath = path.join(dirPath, entry.name);

				// Check gitignore patterns - skips files like *.d.ts, *.js.map that are in .gitignore
				const { patterns: gitignorePatterns } = await getGitignorePatterns(dirPath);
				if (matchesGitignore(childPath, entry.name, gitignorePatterns)) continue;

				const childNode = await buildTree(childPath, currentDepth + 1, maxDepth, exclude, include, showLines, stats, false);

				if (childNode) {
					children.push(childNode);
				}
			}
		} catch {
			// Permission denied or other error
		}

		// Sort: directories first, then by name
		children.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		stats.totalDirs++;

		return {
			name,
			path: dirPath,
			type: "directory",
			children: shouldExpand ? children : undefined,
		};
	} else {
		// File
		if (include && include.length > 0) {
			if (!matchesPattern(name, include) && !matchesPattern(name, [".*"])) {
				const parentDir = path.basename(path.dirname(dirPath));
				if (!matchesPattern(parentDir, include)) {
					return null;
				}
			}
		}

		const size = stat.size;
		const lines = showLines ? await countLines(dirPath) : undefined;
		const category = getFileCategory(name);

		stats.totalFiles++;
		stats.totalSize += size;
		if (lines) stats.totalLines += lines;
		stats.typeBreakdown[category] = (stats.typeBreakdown[category] || 0) + 1;

		return {
			name,
			path: dirPath,
			type: "file",
			size,
			lines,
		};
	}
}

// Format file size
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Render tree as ASCII
function renderTree(node: TreeNode, prefix = "", isLast = true, options: TreeOptions): string[] {
	const lines: string[] = [];
	const connector = isLast ? "└── " : "├── ";
	const childPrefix = isLast ? "    " : "│   ";

	if (node.type === "file") {
		let name = node.name;
		if (options.showStats) {
			const size = formatSize(node.size || 0);
			const lines2 = node.lines ? ` (${node.lines} lines)` : "";
			name += ` ${size}${lines2}`;
		}
		// Highlight important files
		const important = ["README.md", "package.json", "tsconfig.json", ".gitignore", "CHANGELOG.md"];
		if (important.includes(node.name)) {
			name = `[F] ${name}`;
		} else if (node.name.endsWith(".test.ts") || node.name.endsWith(".spec.ts")) {
			name = `[T] ${name}`;
		} else if (node.name.endsWith(".test.py") || node.name.endsWith("_test.py")) {
			name = `[T] ${name}`;
		}
		lines.push(prefix + connector + name);
	} else {
		let name = node.name;

		// Handle truncated directories
		if (node.truncated) {
			lines.push(`${prefix + connector}[D] ${name} \u001b[2m(${node.truncatedReason})\u001b[0m`);
			return lines;
		}

		if (options.showStats && node.children) {
			const fileCount = node.children.filter((c) => c.type === "file").length;
			const dirCount = node.children.filter((c) => c.type === "directory").length;
			name += ` [${dirCount} dirs, ${fileCount} files]`;
		}
		lines.push(`${prefix + connector}[D] ${name}`);

		if (node.children) {
			for (let i = 0; i < node.children.length; i++) {
				const child = node.children[i];
				const childLines = renderTree(child, prefix + childPrefix, i === node.children.length - 1, options);
				lines.push(...childLines);
			}
		}
	}

	return lines;
}

// Render compact tree
function renderCompact(node: TreeNode, prefix = "", isLast = true): string[] {
	const lines: string[] = [];
	const connector = isLast ? "└─" : "├─";

	if (node.type === "file") {
		lines.push(`${prefix}${connector}${node.name}`);
	} else {
		// Handle truncated directories
		if (node.truncated) {
			lines.push(`${prefix}${connector}[${node.name}] \u001b[2m(${node.truncatedReason})\u001b[0m`);
			return lines;
		}
		lines.push(`${prefix}${connector}[${node.name}]`);
		if (node.children) {
			const childPrefix = prefix + (isLast ? "  " : "│ ");
			for (let i = 0; i < node.children.length; i++) {
				const child = node.children[i];
				const childLines = renderCompact(child, childPrefix, i === node.children.length - 1);
				lines.push(...childLines);
			}
		}
	}

	return lines;
}

// Tool result type
interface CodebaseTreeResult {
	rootPath: string;
	maxDepth: number;
	totalFiles: number;
	totalDirs: number;
	totalSize: number;
	totalLines: number;
	typeBreakdown: Record<string, number>;
}

export default function codebaseTreeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codebase_tree",
		label: "Codebase Tree",
		description:
			"Explore codebase directory structure with stats and filtering. Use when you need to understand the layout of a codebase, find files, or get an overview of a project structure.",
		parameters: codebaseTreeSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<CodebaseTreeResult>> => {
			statCache.clear();

			const isAbsolute = path.isAbsolute(params.path ?? "");
			const rootPath = isAbsolute ? params.path! : path.join(ctx.cwd, params.path ?? ".");
			const maxDepth = Math.min(params.maxDepth || 3, 10);
			const exclude = [...DEFAULT_EXCLUDE, ...(params.exclude || [])];
			const showStats = params.showStats !== false;
			const compact = params.compact === true;

			const result: CodebaseTreeResult = {
				rootPath,
				maxDepth,
				totalFiles: 0,
				totalDirs: 0,
				totalSize: 0,
				totalLines: 0,
				typeBreakdown: {},
			};

			// Validate path
			const rootStat = await fastStat(rootPath);
			if (!rootStat) {
				return {
					content: [{ type: "text" as const, text: `Path not found: ${rootPath}` }],
					details: result,
				};
			}

			const stats: TreeStats = {
				totalFiles: 0,
				totalDirs: 0,
				totalSize: 0,
				totalLines: 0,
				typeBreakdown: {},
			};

			const tree = await buildTree(rootPath, 0, maxDepth, exclude, params.include, showStats, stats, true);

			if (!tree) {
				return {
					content: [{ type: "text" as const, text: `Could not read directory: ${rootPath}` }],
					details: result,
				};
			}

			const output: string[] = [];

			// Header
			output.push(`# Codebase Tree: ${path.basename(rootPath)}`);
			output.push(`\`\`\`${path.resolve(rootPath)}\`\`\``);
			output.push("");

			// Render tree
			if (compact) {
				output.push("```");
				output.push(...renderCompact(tree));
				output.push("```");
			} else {
				output.push("```");
				output.push(...renderTree(tree, "", true, { showStats }));
				output.push("```");
			}

			// Stats summary
			if (showStats) {
				output.push("");
				output.push("## Statistics");
				output.push(`- **Files:** ${stats.totalFiles}`);
				output.push(`- **Directories:** ${stats.totalDirs}`);
				output.push(`- **Total Size:** ${formatSize(stats.totalSize)}`);
				if (stats.totalLines > 0) {
					output.push(`- **Total Lines:** ${stats.totalLines.toLocaleString()}`);
				}
				output.push("");

				// Type breakdown
				const sortedTypes = Object.entries(stats.typeBreakdown)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 10);

				output.push("### File Types");
				for (const [type, count] of sortedTypes) {
					const bar = "=".repeat(Math.min(Math.floor((count / stats.totalFiles) * 30), 20));
					output.push(`\`${type}\`: ${count} ${bar}`);
				}
			}

			// Fill result with stats
			result.totalFiles = stats.totalFiles;
			result.totalDirs = stats.totalDirs;
			result.totalSize = stats.totalSize;
			result.totalLines = stats.totalLines;
			result.typeBreakdown = stats.typeBreakdown;

			// Tips
			output.push("");
			output.push(
				"> Use `codebase_tree` with `maxDepth=1` for top-level only, or `include=['*.ts']` to filter file types.",
			);
			output.push(
				'> Large directories (.git, node_modules, etc.) show "(content hidden - request as root to see actual structure)" - pass their path as `path` to explore.',
			);

			return {
				content: [{ type: "text" as const, text: output.join("\n") }],
				details: result,
			};
		},
	});
}
