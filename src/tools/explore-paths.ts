/**
 * explore_paths - Spawn sub-agents to explore multiple code paths in parallel.
 *
 * Forces exploration of multiple hypotheses before fixing.
 * Each sub-agent explores a potential root cause location and reports findings.
 *
 * IMPORTANT: All hypotheses should lead to PROPER solutions. Do NOT generate hypotheses
 * that result in monkey patching, workarounds, or technical debt.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

async function findFile(pattern: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("find", [".", "-name", pattern, "-type", "f"], {
			timeout: 5000,
		});
		return stdout.trim();
	} catch {
		return "";
	}
}

async function readFileHead(path: string, lines = 20): Promise<string> {
	try {
		const { stdout } = await execFileAsync("head", [`-${lines}`, path], {
			timeout: 5000,
		});
		return stdout;
	} catch {
		return "(could not read preview)";
	}
}

export function createExplorePathsTool(): AgentTool {
	return {
		name: "explore_paths",
		label: "Explore Paths",
		description:
			"Spawn parallel sub-agents to explore MULTIPLE potential root causes. Use BEFORE fixing bugs to gather evidence. All hypotheses must lead to proper, well-designed solutions - never use monkey patching or workarounds.",
		parameters: Type.Object({
			hypothesis_1: Type.String({
				description: "First potential root cause location: 'The bug might be in FILE because REASON'",
			}),
			hypothesis_2: Type.String({
				description: "Second potential root cause location: 'The bug might be in OTHER_FILE because REASON'",
			}),
			hypothesis_3: Type.Optional(
				Type.String({
					description:
						"Third potential root cause location (optional): 'The bug might be in ANOTHER_FILE because REASON'",
				}),
			),
		}),

		execute: async (_toolCallId: string, params: unknown) => {
			const { hypothesis_1, hypothesis_2, hypothesis_3 } = params as {
				hypothesis_1: string;
				hypothesis_2: string;
				hypothesis_3?: string;
			};

			const results: string[] = [];

			// For each hypothesis, run a quick exploration
			const hypotheses = [hypothesis_1, hypothesis_2];
			if (hypothesis_3) hypotheses.push(hypothesis_3);

			// Run explorations in parallel
			const explorations = hypotheses.map(async (hyp, i) => {
				const localResults: string[] = [];
				// Extract file path from hypothesis
				const fileMatch = hyp.match(/(?:in|file)\s+([^\s]+\.\w+)/i);
				const file = fileMatch ? fileMatch[1] : "unknown";

				localResults.push(`### Hypothesis ${i + 1}: ${hyp.substring(0, 100)}...`);
				localResults.push(`Target file: ${file}`);

				// Check if file exists (async)
				const foundPath = await findFile(file);
				if (foundPath) {
					localResults.push(`✅ Found: ${foundPath}`);
					// Show first 20 lines of the file
					const preview = await readFileHead(foundPath);
					localResults.push(`Preview:\n${preview.substring(0, 500)}`);
				} else {
					localResults.push("❌ File not found");
				}
				localResults.push("");
				return localResults;
			});

			const allResults = await Promise.all(explorations);
			for (const r of allResults) {
				results.push(...r);
			}

			results.push("**Next steps:**");
			results.push("1. Review the evidence above");
			results.push("2. Identify which hypothesis has supporting evidence");
			results.push("3. Trace the code path for the most likely hypothesis");
			results.push("4. Propose a PROPER fix (no shortcuts, no technical debt)");
			results.push("");
			results.push("**Quality requirement:** All solutions must be well-designed and maintainable.");

			return {
				details: {},
				content: [
					{
						type: "text",
						text: results.join("\n"),
					},
				],
			};
		},
	};
}
