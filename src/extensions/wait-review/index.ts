/**
 * Wait for researcher review — polls docs/ until new .md appears.
 * Use: /wait-review [interval_seconds]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const SCRIPT = join(process.cwd(), "scripts/wait-for-review.sh");
const DOCS = join(process.cwd(), "docs");
const DEFAULT_INTERVAL = 30;

export function registerWaitReview(pi: any) {
	pi.registerTool(
		{
			name: "wait_review",
			description:
				"Wait for researcher review to appear in docs/. Polls every N seconds. Returns path when new file detected. Use /wait-review [seconds] (default: 30).",
			params: Type.Object({
				interval: Type.Optional(Type.Number()),
			}),
		},
		async (params: any, signal: any, onUpdate: any, ctx: ExtensionContext) => {
			const interval = params.interval ?? DEFAULT_INTERVAL;
			const docsDir = DOCS;

			// Run the bash poll script
			const result = spawnSync("bash", [SCRIPT, docsDir, String(interval)], {
				timeout: 0, // No timeout — wait indefinitely
				encoding: "utf-8",
			});

			const output = result.stdout.trim();
			if (!output) {
				return { success: false, error: "No output from poll script" };
			}

			// Parse PATH: prefix
			const filePath = output.split("\n").find((l: string) => l.startsWith("PATH:"))?.slice(5)?.trim()
				|| join(docsDir, output.trim().replace(/^\[wait\] /, ""));

			try {
				const content = readFileSync(filePath, "utf-8");
				const lines = content.split("\n").length;
				return {
					success: true,
					path: filePath,
					filename: output.split("\n")[0],
					preview: content.slice(0, 500),
					lines,
				};
			} catch {
				return { success: true, path: filePath, filename: output.split("\n")[0] };
			}
		},
	);

	pi.registerCommand("wait-review", async (args: string) => {
		const interval = parseInt(args.trim(), 10) || DEFAULT_INTERVAL;
		return `Waiting for review in docs/... (${interval}s polling)`;
	});
}

// Needed for TypeScript
import { Type } from "@sinclair/typebox";

export default function waitReviewExtension(pi: any) {
	registerWaitReview(pi);
}