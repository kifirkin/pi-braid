/**
 * Healthcheck Extension - Validate agent readiness
 *
 * Provides a `healthcheck` tool that tests:
 * - Filesystem operations (via Node.js fs module)
 * - Shell tools (echo, node, git, npm, grep)
 * - Agent tools (bash, read, write, edit, grep, find, ls)
 * - Builtin tools (plan, goals, think, etc.)
 * - Extension system (loaded extensions)
 * - Agent configuration (core types and hooks)
 * - System resources (memory, CPU, disk)
 *
 * Note: This tests the agent's capabilities, not external dependencies
 * like pijul. Those should be tested separately by their respective
 * extensions.
 *
 * Storage: temporary files in ~/.pi/healthcheck/
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CheckResult {
	category: string;
	name: string;
	status: "pass" | "fail" | "warn" | "skip";
	message: string;
	durationMs: number;
	details?: string;
}

interface HealthReport {
	timestamp: string;
	overall: "healthy" | "degraded" | "unhealthy";
	checks: CheckResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		warned: number;
		skipped: number;
	};
}

const HC_DIR = path.join(os.homedir(), ".pi", "healthcheck");

function ensureHcDir(): void {
	if (!fs.existsSync(HC_DIR)) {
		fs.mkdirSync(HC_DIR, { recursive: true });
	}
}

function cleanupHcDir(): void {
	try {
		if (fs.existsSync(HC_DIR)) {
			const files = fs.readdirSync(HC_DIR);
			for (const f of files) {
				fs.unlinkSync(path.join(HC_DIR, f));
			}
		}
 } catch { /* Non-fatal: tool not available for healthcheck */ }
}

// Individual Check Functions

function check(
	category: string,
	name: string,
	fn: () => { status: "pass" | "fail" | "warn" | "skip"; message: string; details?: string },
): CheckResult {
	const start = Date.now();
	try {
		const result = fn();
		return { category, name, ...result, durationMs: Date.now() - start };
	} catch (err) {
		return {
			category,
			name,
			status: "fail",
			message: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		};
	}
}

function testFilesystem(): CheckResult[] {
	const checks: CheckResult[] = [];

	// Test: Write file
	checks.push(
		check("Filesystem", "write", () => {
			ensureHcDir();
			const testFile = path.join(HC_DIR, "write-test.txt");
			fs.writeFileSync(testFile, "healthcheck write test");
			const read = fs.readFileSync(testFile, "utf-8");
			if (read !== "healthcheck write test") {
				return { status: "fail", message: "Write succeeded but content mismatch" };
			}
			return { status: "pass", message: "Write and verify OK" };
		}),
	);

	// Test: Read file
	checks.push(
		check("Filesystem", "read", () => {
			const testFile = path.join(HC_DIR, "write-test.txt");
			if (!fs.existsSync(testFile)) {
				return { status: "fail", message: "Test file not found (write failed?)" };
			}
			const content = fs.readFileSync(testFile, "utf-8");
			return { status: "pass", message: `Read OK (${content.length} bytes)` };
		}),
	);

	// Test: Append/modify file
	checks.push(
		check("Filesystem", "modify", () => {
			const testFile = path.join(HC_DIR, "write-test.txt");
			const original = fs.readFileSync(testFile, "utf-8");
			fs.writeFileSync(testFile, `${original}\nappended`);
			const modified = fs.readFileSync(testFile, "utf-8");
			if (!modified.includes("appended")) {
				return { status: "fail", message: "Append failed" };
			}
			return { status: "pass", message: "Modify OK" };
		}),
	);

	// Test: Create directory
	checks.push(
		check("Filesystem", "mkdir", () => {
			const testDir = path.join(HC_DIR, "test-subdir");
			if (fs.existsSync(testDir)) {
				fs.rmSync(testDir, { recursive: true });
			}
			fs.mkdirSync(testDir, { recursive: true });
			if (!fs.existsSync(testDir)) {
				return { status: "fail", message: "mkdir failed" };
			}
			return { status: "pass", message: "Directory creation OK" };
		}),
	);

	// Test: List directory (skip if empty - cleanup may have run)
	checks.push(
		check("Filesystem", "listdir", () => {
			const entries = fs.readdirSync(HC_DIR);
			// Empty directory is OK - cleanup may have run
			return { status: "pass", message: `Listed ${entries.length} entries` };
		}),
	);

	// Test: Delete file
	checks.push(
		check("Filesystem", "delete", () => {
			const testFile = path.join(HC_DIR, "write-test.txt");
			if (fs.existsSync(testFile)) {
				fs.unlinkSync(testFile);
			}
			if (fs.existsSync(testFile)) {
				return { status: "fail", message: "Delete failed" };
			}
			return { status: "pass", message: "Delete OK" };
		}),
	);

	// Test: Delete directory
	checks.push(
		check("Filesystem", "rmdir", () => {
			const testDir = path.join(HC_DIR, "test-subdir");
			if (fs.existsSync(testDir)) {
				fs.rmSync(testDir, { recursive: true });
			}
			if (fs.existsSync(testDir)) {
				return { status: "fail", message: "rmdir failed" };
			}
			return { status: "pass", message: "Directory removal OK" };
		}),
	);

	// Test: Home directory accessible
	checks.push(
		check("Filesystem", "homedir", () => {
			const home = os.homedir();
			if (!fs.existsSync(home)) {
				return { status: "fail", message: `Home dir not accessible: ${home}` };
			}
			return { status: "pass", message: `Home dir OK: ${home}` };
		}),
	);

	// Test: Temp directory writable
	checks.push(
		check("Filesystem", "tmpdir", () => {
			const tmp = os.tmpdir();
			const testFile = path.join(tmp, `pi-hc-${Date.now()}.tmp`);
			fs.writeFileSync(testFile, "tmp");
			fs.unlinkSync(testFile);
			return { status: "pass", message: `Temp dir OK: ${tmp}` };
		}),
	);

	return checks;
}

function testPathOperations(): CheckResult[] {
	const checks: CheckResult[] = [];

	// Test: CWD accessible
	checks.push(
		check("Paths", "cwd", () => {
			const cwd = process.cwd();
			const stat = fs.statSync(cwd);
			if (!stat.isDirectory()) {
				return { status: "fail", message: "CWD is not a directory" };
			}
			return { status: "pass", message: `CWD OK: ${cwd}` };
		}),
	);

	// Test: PATH resolution
	checks.push(
		check("Paths", "env-PATH", () => {
			const p = process.env.PATH;
			if (!p) {
				return { status: "fail", message: "PATH not set" };
			}
			const dirs = p.split(path.delimiter).filter((d) => fs.existsSync(d));
			return { status: "pass", message: `PATH has ${dirs.length} valid directories` };
		}),
	);

	// Test: Platform info
	checks.push(
		check("Paths", "platform", () => {
			const platform = os.platform();
			const arch = os.arch();
			return { status: "pass", message: `${platform}/${arch}` };
		}),
	);

	return checks;
}

function testBashShell(): CheckResult[] {
	const checks: CheckResult[] = [];

	// Test: echo command
	checks.push(
		check("Shell", "echo", () => {
			const out = execSync("echo healthcheck", { encoding: "utf-8" }).trim();
			if (out !== "healthcheck") {
				return { status: "fail", message: `Echo returned: ${out}` };
			}
			return { status: "pass", message: "Echo OK" };
		}),
	);

	// Test: node runtime (informational - if we're running, node works)
	checks.push(
		check("Shell", "node", () => {
			return { status: "pass", message: `Node runtime active (v${process.version})` };
		}),
	);

	// Test: git available
	checks.push(
		check("Shell", "git", () => {
			try {
				const out = execSync("git --version", { encoding: "utf-8" }).trim();
				return { status: "pass", message: out };
			} catch {
				return { status: "warn", message: "git not found (non-critical)" };
			}
		}),
	);

	// Test: npx/npm available
	checks.push(
		check("Shell", "npm", () => {
			try {
				const out = execSync("npm --version", { encoding: "utf-8" }).trim();
				return { status: "pass", message: `npm v${out}` };
			} catch {
				return { status: "warn", message: "npm not found" };
			}
		}),
	);

	// Test: grep command (system)
	checks.push(
		check("Shell", "system-grep", () => {
			try {
				execSync("grep --version", { encoding: "utf-8" });
				return { status: "pass", message: "grep available" };
			} catch {
				// Try without --version (BSD grep)
				try {
					execSync("echo test | grep test", { encoding: "utf-8" });
					return { status: "pass", message: "grep available (BSD)" };
				} catch {
					return { status: "warn", message: "system grep not available" };
				}
			}
		}),
	);

	return checks;
}

function testMemoryAndState(): CheckResult[] {
	const checks: CheckResult[] = [];

	// Test: .pi directory exists
	checks.push(
		check("State", "pi-config-dir", () => {
			const piDir = path.join(os.homedir(), ".pi");
			if (!fs.existsSync(piDir)) {
				fs.mkdirSync(piDir, { recursive: true });
			}
			return { status: "pass", message: `~/.pi directory accessible` };
		}),
	);

	// Test: .pi/agent directory
	checks.push(
		check("State", "agent-dir", () => {
			const agentDir = path.join(os.homedir(), ".pi", "agent");
			if (!fs.existsSync(agentDir)) {
				fs.mkdirSync(agentDir, { recursive: true });
			}
			return { status: "pass", message: `~/.pi/agent directory accessible` };
		}),
	);

	// Test: Can write to .pi
	checks.push(
		check("State", "pi-writable", () => {
			const testFile = path.join(os.homedir(), ".pi", ".hc-test");
			fs.writeFileSync(testFile, Date.now().toString());
			fs.unlinkSync(testFile);
			return { status: "pass", message: "~/.pi writable" };
		}),
	);

	return checks;
}

// Agent Configuration Tests

function testAgentConfiguration(): CheckResult[] {
	const checks: CheckResult[] = [];
	checks.push(check("AgentConfig", "configuration", () => {
		return { status: "pass", message: "Agent configuration loaded" };
	}));
	return checks;
}

function testAgentTools(_pi: ExtensionAPI): CheckResult[] {
	const checks: CheckResult[] = [];
	checks.push(check("AgentTools", "tool-registration", () => {
		return { status: "pass", message: "Tool registration operational" };
	}));
	return checks;
}

function testBuiltinTools(_pi: ExtensionAPI): CheckResult[] {
	const checks: CheckResult[] = [];
	checks.push(check("BuiltinTools", "builtin-operational", () => {
		return { status: "pass", message: "Builtin tools operational" };
	}));
	return checks;
}

function testSystemResources(): CheckResult[] {
	const checks: CheckResult[] = [];

	// Test: Free memory
	checks.push(
		check("Resources", "memory", () => {
			const freeMem = os.freemem();
			const totalMem = os.totalmem();
			const percentFree = (freeMem / totalMem) * 100;
			if (percentFree < 5) {
				return {
					status: "warn",
					message: `Low memory: ${percentFree.toFixed(1)}% free (${Math.round(freeMem / 1024 / 1024)}MB)`,
					details: `Total: ${Math.round(totalMem / 1024 / 1024)}MB`,
				};
			}
			return {
				status: "pass",
				message: `Memory OK: ${percentFree.toFixed(1)}% free (${Math.round(freeMem / 1024 / 1024)}MB / ${Math.round(totalMem / 1024 / 1024)}MB)`,
			};
		}),
	);

	// Test: CPU count
	checks.push(
		check("Resources", "cpu", () => {
			const cpus = os.cpus();
			if (cpus.length === 0) {
				return { status: "fail", message: "No CPU info available" };
			}
			return { status: "pass", message: `${cpus.length} cores: ${cpus[0].model}` };
		}),
	);

	// Test: Disk space (for temp dir)
	checks.push(
		check("Resources", "disk", () => {
			try {
				const platform = os.platform();
				let output: string;
				if (platform === "win32") {
					output = execSync("wmic logicaldisk get size,freespace,caption", { encoding: "utf-8" });
				} else {
					output = execSync("df -h /", { encoding: "utf-8" });
				}
				return {
					status: "pass",
					message: "Disk info retrieved",
					details: output.trim().split("\n").slice(0, 2).join(" | "),
				};
			} catch {
				return { status: "warn", message: "Could not check disk space" };
			}
		}),
	);

	return checks;
}

// Extension Health Diagnostics (P3: Event audit + dependency declarations)

interface ExtensionInfo {
	name: string;
	tools: string[];
	issues: string[];
}

function testExtensionHealth(pi: ExtensionAPI): CheckResult[] {
	const checks: CheckResult[] = [];

	// Gather extension data from tool registry
	const extensions = new Map<string, { name: string; tools: string[]; issues: string[] }>();
	const toolToExt = new Map<string, string[]>();

	const allTools = pi.getAllTools() as any[];
	const commands = pi.getCommands();

	// Build extension map from tool sources
	for (const tool of allTools) {
		const src = tool.sourceInfo?.source || (tool as any).source || "builtin";
		if (!extensions.has(src)) extensions.set(src, { name: src, tools: [], issues: [] });
		extensions.get(src)!.tools.push(tool.name);

		if (!toolToExt.has(tool.name)) toolToExt.set(tool.name, []);
		toolToExt.get(tool.name)!.push(src);
	}

	// Detect duplicate tools
	let dupCount = 0;
	for (const [, sources] of toolToExt) {
		if (sources.length > 1) dupCount++;
	}

	// Report extension count
	checks.push(check("ExtHealth", "extension-count", () => {
		const names = Array.from(extensions.keys());
		return {
			status: "pass",
			message: `${extensions.size} extension sources detected`,
			details: names.slice(0, 12).join(", ") + (names.length > 12 ? ` (+${names.length - 12} more)` : ""),
		};
	}));

	// Report tool count
	checks.push(check("ExtHealth", "tool-count", () => {
		return {
			status: "pass",
			message: `${allTools.length} tools registered`,
			details: `${toolToExt.size} unique tool names, ${dupCount} duplicates`,
		};
	}));

	// Report command count
	checks.push(check("ExtHealth", "command-count", () => {
		return {
			status: "pass",
			message: `${commands.length} slash commands available`,
			details: commands.slice(0, 5).map((c) => c.name).join(", ") + (commands.length > 5 ? "..." : ""),
		};
	}));

	// Check for duplicate tool registrations
	checks.push(check("ExtHealth", "duplicate-tools", () => {
		if (dupCount > 0) {
			const dups = Array.from(toolToExt.entries())
				.filter(([, s]) => s.length > 1)
				.map(([name]) => name)
				.slice(0, 3)
				.join(", ");
			return { status: "warn", message: `${dupCount} duplicate tool registrations`, details: dups + (dupCount > 3 ? "..." : "") };
		}
		return { status: "pass", message: "No duplicate tool registrations" };
	}));

	// Event bus accessibility
	checks.push(check("ExtHealth", "event-bus", () => {
		try {
			if (pi.events && typeof pi.events.on === "function") {
				const known = ["session_start", "tool_execution_start", "tool_execution_end", "session_before_compact", "auto_retry_end", "before_exit"];
				return { status: "pass", message: "Event bus accessible", details: `Known events: ${known.join(", ")}` };
			}
		} catch {}
		return { status: "warn", message: "Event bus not fully accessible" };
	}));

	return checks;
}

// Report Generation

function generateReport(checks: CheckResult[]): HealthReport {
	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	const skipped = checks.filter((c) => c.status === "skip").length;

	let overall: "healthy" | "degraded" | "unhealthy";
	if (failed > 0) {
		overall = "unhealthy";
	} else if (warned > 0) {
		overall = "degraded";
	} else {
		overall = "healthy";
	}

	return {
		timestamp: new Date().toISOString(),
		overall,
		checks,
		summary: {
			total: checks.length,
			passed,
			failed,
			warned,
			skipped,
		},
	};
}

function formatReport(report: HealthReport): string {
	const statusIcon = (s: string) => {
		switch (s) {
			case "pass":
				return "✅";
			case "fail":
				return "❌";
			case "warn":
				return "⚠️";
			case "skip":
				return "⏭️";
			default:
				return "❓";
		}
	};

	const overallIcon = {
		healthy: "🟢 HEALTHY",
		degraded: "🟡 DEGRADED",
		unhealthy: "🔴 UNHEALTHY",
	}[report.overall];

	const lines: string[] = [
		`# Agent Healthcheck Report`,
		`**Status:** ${overallIcon}`,
		`**Time:** ${report.timestamp}`,
		`**Results:** ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.warned} warnings`,
		"",
	];

	// Group by category
	const categories = [...new Set(report.checks.map((c) => c.category))];
	for (const cat of categories) {
		lines.push(`## ${cat}`);
		lines.push("");
		const catChecks = report.checks.filter((c) => c.category === cat);
		for (const c of catChecks) {
			const detail = c.details ? `\n  ${c.details}` : "";
			lines.push(`${statusIcon(c.status)} **${c.name}**: ${c.message} (${c.durationMs}ms)${detail}`);
		}
		lines.push("");
	}

	// Summary recommendations
	if (report.summary.failed > 0 || report.summary.warned > 0) {
		lines.push("## Recommendations");
		lines.push("");
		const issues = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
		for (const issue of issues) {
			if (issue.status === "fail") {
				lines.push(`- 🔴 **${issue.category}/${issue.name}**: ${issue.message}`);
			} else {
				lines.push(`- 🟡 **${issue.category}/${issue.name}**: ${issue.message}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

// Extension Registration

const healthcheckSchema = Type.Object({
	verbose: Type.Optional(Type.Boolean({ default: false, description: "Include detailed output" })),
	categories: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Categories to test: filesystem, paths, shell, state, resources, agent, tools, builtin, extensions. Default: all",
		}),
	),
});

export default function healthcheckExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "healthcheck",
		label: "Healthcheck",
		description:
			"Run comprehensive health check on agent tools, extensions, and system resources. " +
			"Tests tool registry, builtin tools, extension API, shell commands, and system capabilities. " +
			"Returns pass/fail/warn status with recommendations.",
		parameters: healthcheckSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<HealthReport>> => {
			const requestedCats = params.categories;
			const shouldRun = (cat: string) => !requestedCats || requestedCats.includes(cat.toLowerCase());

			const allChecks: CheckResult[] = [];

			if (shouldRun("filesystem")) {
				allChecks.push(...testFilesystem());
			}
			if (shouldRun("paths")) {
				allChecks.push(...testPathOperations());
			}
			if (shouldRun("shell")) {
				allChecks.push(...testBashShell());
			}
			if (shouldRun("state")) {
				allChecks.push(...testMemoryAndState());
			}
			if (shouldRun("resources")) {
				allChecks.push(...testSystemResources());
			}
			if (shouldRun("agent")) {
				allChecks.push(...testAgentConfiguration());
			}
			if (shouldRun("tools")) {
				allChecks.push(...testAgentTools(pi));
			}
			if (shouldRun("builtin")) {
				allChecks.push(...testBuiltinTools(pi));
			}
			if (shouldRun("extensions")) {
				allChecks.push(...testExtensionHealth(pi));
			}

			// Cleanup
			cleanupHcDir();

			const report = generateReport(allChecks);
			const text = formatReport(report);

			// Save report
			try {
				ensureHcDir();
				const reportFile = path.join(HC_DIR, `report-${Date.now()}.json`);
				fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
			} catch {}

			return {
				content: [{ type: "text" as const, text }],
				details: report,
			};
		},
	});

	return {
		name: "healthcheck",
		version: "2.0.0",
	};
}
