/**
 * pi-braid unified test runner.
 * Run: npm test
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const testDir = resolve(root, "test/runtime");

const SKIP = new Set([
	"test-all.mjs",           // aggregator, duplicates individual
	"test-async.mjs",         // file does not exist
]);

const tests = readdirSync(testDir)
	.filter((f) => f.endsWith(".mjs") && !SKIP.has(f))
	.sort();

let passed = 0;
let failed = 0;
const failures = [];

console.log(`Running ${tests.length} tests from ${testDir}\n`);

for (const t of tests) {
	const label = `[${String(passed + failed + 1)}/${tests.length}]`;
	try {
		const stdout = execSync(`node test/runtime/${t}`, {
			cwd: root,
			timeout: 30_000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const summary = stdout
			.split("\n")
			.find((l) => l.includes("\uD83D\uDCCA") || l.includes("Results"))
			?.trim();
		console.log(`  \u2705 ${label} ${t}${summary ? " \u2014 " + summary : ""}`);
		passed++;
	} catch (e) {
		const stderr = e.stderr?.toString() ?? "";
		const stdout = e.stdout?.toString() ?? "";
		const summary =
			stdout
				.split("\n")
				.find((l) => l.includes("\uD83D\uDCCA") || l.includes("passed"))
				?.trim() ??
			stderr
				.split("\n")
				.find((l) => l.includes("\uD83D\uDCCA") || l.includes("passed"))
				?.trim();
		if (summary) {
			console.log(`  \u274C ${label} ${t} \u2014 ${summary}`);
		} else {
			console.log(`  \u274C ${label} ${t} \u2014 exit code ${e.status}`);
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
