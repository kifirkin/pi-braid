/**
 * REPL Tool - Interactive Code Execution
 *
 * Provides a persistent REPL environment for the agent:
 * - Run Python/Node.js/Shell code snippets
 * - Maintain state between calls (variables, imports)
 * - Useful for testing hypotheses, exploring data, verifying logic
 *
 * Inspired by: Fractals executor pattern
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

interface ReplState {
	pythonVars: Map<string, string>;
	nodeVars: Map<string, string>;
	executionCount: number;
}

const replSchema = Type.Object({
	language: Type.Union([Type.Literal("python"), Type.Literal("node"), Type.Literal("shell")], {
		description: "Language to execute code in",
	}),
	code: Type.String({ description: "Code to execute. Can be multi-line." }),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

export function createReplTool(cwd: string): AgentTool<typeof replSchema> {
	const state: ReplState = {
		pythonVars: new Map(),
		nodeVars: new Map(),
		executionCount: 0,
	};

	return {
		name: "repl",
		label: "REPL",
		description:
			"Run code in a REPL environment. Supports Python, Node.js, and Shell. State persists between calls (variables, imports). Use to test hypotheses, explore data, verify logic before fixing.",
		parameters: replSchema,
		execute: async (_toolCallId: string, params: { language: string; code: string; timeout_ms?: number }) => {
			const timeout = params.timeout_ms || 30000;
			state.executionCount++;

			try {
				let result: { stdout: string; stderr: string; exitCode: number };

				switch (params.language) {
					case "python":
						result = executePython(params.code, cwd, timeout, state);
						break;
					case "node":
						result = executeNode(params.code, cwd, timeout, state);
						break;
					case "shell":
						result = executeShell(params.code, cwd, timeout);
						break;
					default:
						return {
							content: [{ type: "text" as const, text: `Unknown language: ${params.language}` }],
							details: { error: `Unknown language: ${params.language}` },
						};
				}

				const output = result.stdout || "(no output)";
				const text = result.stderr ? `${output}\n\nstderr:\n${result.stderr}` : output;

				return {
					content: [{ type: "text" as const, text }],
					details: { ...result, execution: state.executionCount },
				};
			} catch (error: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${error.message}` }],
					details: {
						error: error.message,
						stderr: error.stderr?.toString() || "",
						exitCode: error.status || 1,
					},
				};
			}
		},
	};
}

function executePython(
	code: string,
	cwd: string,
	timeout: number,
	state: ReplState,
): { stdout: string; stderr: string; exitCode: number } {
	const preamble = Array.from(state.pythonVars.entries())
		.map(([k, v]) => `${k} = ${v}`)
		.join("\n");

	const fullCode = `${preamble}\n${code}`;
	const tmpFile = join(tmpdir(), `repl_${Date.now()}.py`);
	writeFileSync(tmpFile, fullCode);

	try {
		const result = execSync(`python3 ${tmpFile}`, {
			cwd,
			timeout,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
		});

		const varMatches = code.match(/^(\w+)\s*=\s*(.+)$/gm);
		if (varMatches) {
			for (const match of varMatches) {
				const [, name, value] = match.match(/^(\w+)\s*=\s*(.+)$/) || [];
				if (name && value) {
					state.pythonVars.set(name, value);
				}
			}
		}

		return { stdout: result.trim(), stderr: "", exitCode: 0 };
	} finally {
		try {
			require("node:fs").unlinkSync(tmpFile);
		} catch {}
	}
}

function executeNode(
	code: string,
	cwd: string,
	timeout: number,
	state: ReplState,
): { stdout: string; stderr: string; exitCode: number } {
	const preamble = Array.from(state.nodeVars.entries())
		.map(([k, v]) => `const ${k} = ${v};`)
		.join("\n");

	const fullCode = `${preamble}\n${code}`;
	const tmpFile = join(tmpdir(), `repl_${Date.now()}.js`);
	writeFileSync(tmpFile, fullCode);

	try {
		const result = execSync(`node ${tmpFile}`, {
			cwd,
			timeout,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
		});

		const varMatches = code.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(.+);?$/gm);
		if (varMatches) {
			for (const match of varMatches) {
				const [, name, value] = match.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(.+);?$/) || [];
				if (name && value) {
					state.nodeVars.set(name, value);
				}
			}
		}

		return { stdout: result.trim(), stderr: "", exitCode: 0 };
	} finally {
		try {
			require("node:fs").unlinkSync(tmpFile);
		} catch {}
	}
}

function executeShell(
	code: string,
	cwd: string,
	timeout: number,
): { stdout: string; stderr: string; exitCode: number } {
	const result = execSync(code, {
		cwd,
		timeout,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
	});

	return { stdout: result.trim(), stderr: "", exitCode: 0 };
}
