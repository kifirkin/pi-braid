#!/usr/bin/env node
/**
 * Poll docs/ for new .md files (researcher review).
 * Stop when a new file appears (modified more recently than when this script started).
 * Prints path when found, then exits 0.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const docsDir = process.argv[2] || "docs";
const intervalMs = parseInt(process.argv[3] || "30000", 10);
const startTime = Date.now();

console.error(`[poll-docs] Watching ${docsDir}/ every ${intervalMs}ms...`);

while (true) {
	const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
	for (const file of files) {
		const path = join(docsDir, file);
		const mtime = statSync(path).mtimeMs;
		// Only trigger on files modified AFTER script start (new or updated)
		if (mtime > startTime) {
			console.log(path);
			process.exit(0);
		}
	}
	// Sleep
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	await sleep(intervalMs);
}