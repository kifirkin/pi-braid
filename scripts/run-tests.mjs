/**
 * pi-braid unified test runner.
 * Run: npm test
 *
 * Uses spawnSync with exit codes (no stdout parsing) for robustness.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const testDir = resolve(root, "test/runtime");

/** Recursively find all .mjs test files in subdirectories too. */
function findTests(dir) {
	const results = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...findTests(full));
			} else if (entry.name.endsWith(".mjs") && !SKIP.has(entry.name)) {
				results.push(relative(testDir, full));
			}
		}
	} catch { /* */ }
	return results;
}

const SKIP = new Set([
	"test-all.mjs",           // aggregator, duplicates individual
	"test-async.mjs",         // file does not exist
	"test-br1-trap-tasks.mjs",  // SLOW — requires API calls, run separately with 300s timeout
]);

const tests = findTests(testDir).sort();

let passed = 0;
let failed = 0;
const failures = [];

console.log(`Running ${tests.length} tests from ${testDir}\n`);

for (const t of tests) {
	const label = `[${String(passed + failed + 1)}/${tests.length}]`;
	const result = spawnSync("node", [`test/runtime/${t}`], {
		cwd: root,
		timeout: 30_000,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Use exit code for pass/fail determination
	if (result.status === 0) {
		// Extract summary line from stdout for display
		const lines = (result.stdout ?? "").split("\n");
		const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("Results"))?.trim();
		console.log(`  \u2705 ${label} ${t}${summary ? " \u2014 " + summary : ""}`);
		passed++;
	} else {
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const lines = (stdout + "\n" + stderr).split("\n");
		const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("passed"))?.trim();
		if (summary) {
			console.log(`  \u274C ${label} ${t} \u2014 ${summary}`);
		} else {
			console.log(`  \u274C ${label} ${t} \u2014 exit code ${result.status}`);
		}
		failed++;
		failures.push(t);
	}
}

console.log(
	`\n\uD83D\uDCCA ${passed} passed, ${failed} failed` +
		(failures.length > 0 ? "\n  Failed: " + failures.join(", ") : ""),
);
process.exit(failed > 0 ? 1 : 0);
