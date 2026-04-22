import { createLogger } from "../../lib/logger.js";

const log = createLogger("wait-review");
/**
 * Wait for researcher review — polls docs/ until new .md appears.
 * Use: /wait-review [interval_seconds]
 */
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/wait-for-review.sh");
const DOCS = join(process.cwd(), "docs");
const DEFAULT_INTERVAL = 30;

export function registerWaitReview(pi: any) {
	pi.registerTool({
		name: "wait_review",
		label: "Wait for Review",
		description:
			"Wait for researcher review to appear in docs/. Polls every N seconds. Returns path when new file detected. Use /wait-review [seconds] (default: 30).",
		parameters: {
			interval: Type.Optional(Type.Number()),
		},
		execute: async (params: any, signal: any, onUpdate: any) => {
			const interval = params.interval ?? DEFAULT_INTERVAL;

			const result = spawnSync("bash", [SCRIPT, DOCS, String(interval)], {
				encoding: "utf-8",
			});

			const output = result.stdout.trim();
			if (!output) return { success: false, error: "No output from poll script" };

			const filePath =
				output.split("\n").find((l: string) => l.startsWith("PATH:"))?.slice(5)?.trim()
				|| join(DOCS, output.trim().replace(/^\[wait\] /, ""));

			try {
				const content = readFileSync(filePath, "utf-8");
				return {
					success: true,
					path: filePath,
					filename: output.split("\n")[0],
					preview: content.slice(0, 500),
					lines: content.split("\n").length,
				};
			} catch {
				return { success: true, path: filePath, filename: output.split("\n")[0] };
			}
		},
	});

	pi.registerCommand("wait-review", async (args: string) => {
		const interval = parseInt(args.trim(), 10) || DEFAULT_INTERVAL;
		return `Waiting for review in docs/... (${interval}s polling)`;
	});
}

export default function waitReviewExtension(pi: any) {
	registerWaitReview(pi);
}