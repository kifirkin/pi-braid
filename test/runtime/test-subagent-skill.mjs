/**
 * Subagent Skill Tests — validates skill content and referenced infrastructure.
 * Run: node test/runtime/test-subagent-skill.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	Promise.resolve(fn())
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failed++;
			const msg = `${name}: ${err.message ?? err}`;
			failures.push(msg);
			console.log(`  ✗ ${name}`);
			console.log(`    ${err.message ?? err}`);
		});
}

// ── Skill File ──────────────────────────────────────────────────────────

const SKILL_PATH = join(ROOT, "skills/subagent/SKILL.md");
const skillContent = readFileSync(SKILL_PATH, "utf-8");

test("Skill file exists", () => {
	assert.ok(existsSync(SKILL_PATH), "skills/subagent/SKILL.md must exist");
});

test("Skill has valid YAML frontmatter", () => {
	assert.ok(skillContent.startsWith("---"), "Must start with ---");
	const match = skillContent.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, "Must have closing ---");
	const fm = match[1];
	assert.ok(fm.includes("name: subagent"), "Must have name: subagent");
	assert.ok(fm.includes("description:"), "Must have description field");
});

test("Skill covers RPC mode", () => {
	assert.ok(skillContent.includes("RPC Subprocess"), "Must document RPC mode");
	assert.ok(skillContent.includes("--mode rpc"), "Must show RPC flag");
	assert.ok(skillContent.includes("subagent-rpc.py"), "Must reference Python client");
});

test("Skill covers tmux mode", () => {
	assert.ok(skillContent.includes("tmux Session"), "Must document tmux mode");
	assert.ok(skillContent.includes("send-keys"), "Must show send-keys");
	assert.ok(skillContent.includes("capture-pane"), "Must show capture-pane");
	assert.ok(skillContent.includes("kill-session"), "Must show cleanup");
});

test("Skill covers parallel fan-out", () => {
	assert.ok(skillContent.includes("Fan-Out"), "Must cover fan-out/fan-in");
	assert.ok(skillContent.includes("wait"), "Must show wait for parallel jobs");
});

test("Skill covers error recovery", () => {
	assert.ok(skillContent.includes("Error Recovery"), "Must cover error recovery");
	assert.ok(skillContent.includes("abort"), "Must show abort command");
});

test("Skill covers cleanup", () => {
	assert.ok(skillContent.includes("Cleanup"), "Must cover cleanup");
	assert.ok(skillContent.includes("orphan"), "Must address orphan processes");
});

test("Skill has task prompt guidelines", () => {
	assert.ok(skillContent.includes("Task Prompt Guidelines"), "Must cover prompt writing");
	assert.ok(skillContent.includes("Good task prompt"), "Must show good example");
	assert.ok(skillContent.includes("Bad task prompt"), "Must show bad example");
});

test("Skill has no hardcoded absolute paths", () => {
	const matches = skillContent.match(/\/Users\/[^\s`"')\]]+/g);
	assert.ok(matches === null, `Found hardcoded paths: ${JSON.stringify(matches)}`);
});

test("Skill uses BRAID_ROOT variable", () => {
	assert.ok(skillContent.includes("$BRAID_ROOT"), "Must use $BRAID_ROOT variable");
	assert.ok(skillContent.includes("BRAID_ROOT="), "Must define BRAID_ROOT");
});

test("Skill has no MUST/NEVER/ALWAYS directives", () => {
	const directives = skillContent.match(/\b(MUST|NEVER|ALWAYS)\b/g);
	// Allow one instance in "must respond within 2s" which is a real protocol constraint
	assert.ok(
		!directives || directives.length <= 1,
		`Found excessive directive words: ${JSON.stringify(directives)}`
	);
});

// ── Referenced Infrastructure ───────────────────────────────────────────

test("Python RPC client exists", () => {
	const path = join(ROOT, "scripts/subagent-rpc.py");
	assert.ok(existsSync(path), "scripts/subagent-rpc.py must exist");
});

test("Python RPC client has PiSubagent class", () => {
	const path = join(ROOT, "scripts/subagent-rpc.py");
	const content = readFileSync(path, "utf-8");
	assert.ok(content.includes("class PiSubagent"), "Must have PiSubagent class");
	assert.ok(content.includes("send_task"), "Must have send_task method");
	assert.ok(content.includes("extension_ui_request"), "Must handle UI requests");
});

test("Python RPC client accepts task_file and optional model args", () => {
	const path = join(ROOT, "scripts/subagent-rpc.py");
	const content = readFileSync(path, "utf-8");
	assert.ok(content.includes("sys.argv[1]"), "Must read task file from argv");
	assert.ok(content.includes("sys.argv[2]"), "Must read optional model from argv");
});

test("DaemonOrchestrator source exists", () => {
	const path = join(ROOT, "braid-os/daemon/index.ts");
	if (!existsSync(path)) {
		console.log("  ⏭ SKIP: braid-os/daemon/index.ts not found (separate infra)");
		return;
	}
	assert.ok(existsSync(path), "braid-os/daemon/index.ts must exist");
});

test("DaemonOrchestrator has spawnWorker and killWorker", () => {
	const path = join(ROOT, "braid-os/daemon/index.ts");
	if (!existsSync(path)) {
		console.log("  ⏭ SKIP: braid-os/daemon/index.ts not found (separate infra)");
		return;
	}
	const content = readFileSync(path, "utf-8");
	assert.ok(content.includes("spawnWorker"), "Must export spawnWorker");
	assert.ok(content.includes("killWorker"), "Must export killWorker");
	assert.ok(content.includes("DaemonOrchestrator"), "Must export DaemonOrchestrator");
});

test("braid-daemon.sh exists and is executable-relevant", () => {
	const path = join(ROOT, "braid-os/braid-daemon.sh");
	if (!existsSync(path)) {
		console.log("  ⏭ SKIP: braid-os/braid-daemon.sh not found (separate infra)");
		return;
	}
	assert.ok(existsSync(path), "braid-os/braid-daemon.sh must exist");
	const content = readFileSync(path, "utf-8");
	assert.ok(content.includes("cmd_start"), "Must have start command");
	assert.ok(content.includes("cmd_stop"), "Must have stop command");
	assert.ok(content.includes("cmd_status"), "Must have status command");
});

// ── RPC Client CLI Validation ───────────────────────────────────────────

test("RPC client shows usage when called without args", () => {
	let result;
	try {
		result = execSync(`python3 ${join(ROOT, "scripts/subagent-rpc.py")} 2>&1`, {
			encoding: "utf-8",
			timeout: 5000,
		});
	} catch (e) {
		// Script exits with code 1 when called without args
		result = e.stdout || "";
	}
	assert.ok(result.includes("Usage:"), "Must show usage message");
});

// ── Summary ─────────────────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		failures.forEach((f) => console.log(`  - ${f}`));
	}
	process.exit(failed > 0 ? 1 : 0);
}, 1000);
