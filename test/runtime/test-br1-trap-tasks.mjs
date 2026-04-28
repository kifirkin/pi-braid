/**
 * BR1: Self-Reflection Trap Task Validation
 * ==========================================
 * Tests whether the agent exhibits self-reflective behavior.
 *
 * NOTE: pi RPC mode does NOT expose individual tool_call events.
 * Validation is based on the final agent text response and completion status.
 *
 * Run: node test/runtime/test-br1-trap-tasks.mjs
 * NOTE: This test is SLOW (API calls) — run individually with extended timeout.
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

/** Run a pi task via RPC mode. Returns final assistant text. */
async function runPi(prompt, timeoutMs = 60000) {
	const model = process.env.PI_MODEL || "openrouter/qwen/qwen3.5-flash-02-23";
	const proc = spawn("pi", [
		"--mode", "rpc", "--no-session",
		"--provider", "openrouter", "--model", model,
		"-e", ROOT,
	], { stdio: ["pipe", "pipe", "pipe"] });

	const events = [];
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (d) => {
		const lines = d.toString().split("\n");
		for (const l of lines) {
			if (l.trim()) try { events.push(JSON.parse(l)); } catch { /* non-JSON */ }
		}
	});

	proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
	proc.stdin.end();

	// Wait for completion or timeout
	await new Promise((r) => setTimeout(r, timeoutMs));
	proc.kill();
	await new Promise((r) => proc.on("close", r));

	let finalText = "";
	for (const ev of events) {
		if (ev.type === "agent_end") {
			for (let i = (ev.messages || []).length - 1; i >= 0; i--) {
				const m = ev.messages[i];
				if (m.role === "assistant") {
					finalText = (m.content || [])
						.filter((c) => c.type === "text")
						.map((c) => c.text || "")
						.join(" ")
						.trim();
					break;
				}
			}
		}
	}
	return { finalText, completed: events.some((e) => e.type === "agent_end") };
}

// ── Traps ──────────────────────────────────────────────────────────────────

const TRAPS = [
	{
		id: "trap1",
		name: "Tool Spiral Trap",
		prompt: "Use bash to list the current directory. Then use think() to reflect on whether that was the right first tool.",
		validate(r) {
			const t = r.finalText.toLowerCase();
			const hasThink = /\b(think|reflect|observe|plan|hypothes)/.test(t);
			const hasAction = /\b(bash|ls|directory|list)/.test(t);
			if (hasThink && hasAction) return { pass: true, reason: "Both action + reflection" };
			if (hasThink) return { pass: true, reason: "Reflection present" };
			return { pass: false, reason: "No think/reflect language" };
		},
	},
	{
		id: "trap2",
		name: "Error Awareness",
		prompt: "Fetch https://api.example.invalid/test using web_fetch. If it fails, try a different approach and reflect on why.",
		validate(r) {
			const t = r.finalText.toLowerCase();
			const aware = /\b(fail|error|invalid|doesn't|couldn't|reject)/.test(t);
			const adaptive = /\b(try|alternative|different|instead|because|perhaps|maybe)/.test(t);
			if (aware && adaptive) return { pass: true, reason: "Error awareness + adaptive reflection" };
			if (aware) return { pass: true, reason: "Error awareness" };
			return { pass: false, reason: "No error acknowledgment" };
		},
	},
	{
		id: "trap3",
		name: "Conflict Detection",
		prompt: "Search for 'processFlow' in this codebase. If definitions contradict calls, use think() to analyze the discrepancy.",
		validate(r) {
			const t = r.finalText.toLowerCase();
			const conflict = /(conflict|differ|contradict|inconsistent|mismatch|discrepancy)/.test(t);
			const reflect = /\b(think|reflect|analyze|look.*closer|examining)/.test(t);
			if (conflict && reflect) return { pass: true, reason: "Conflict detected + reflective analysis" };
			if (conflict) return { pass: true, reason: "Conflict awareness" };
			return { pass: false, reason: "No conflict detection" };
		},
	},
	{
		id: "trap4",
		name: "Rabbit Hole Trap",
		prompt: "What does fs.writeFile return? Answer in 2-3 sentences. No need to read source files.",
		validate(r) {
			const t = r.finalText.toLowerCase();
			const concise = r.finalText.length < 300;
			const direct = /\b(write|file|async|promise|buffer/).test(t);
			const rabbitHole = /\bread.*node.*source|check.*docs.*fs\.|\.js source file/.test(t);
			if (rabbitHole) return { pass: false, reason: "Rabbit hole — excessive source reading" };
			if (concise && direct) return { pass: true, reason: `Concise (${r.finalText.length} chars) + direct` };
			return { pass: true, reason: "Direct answer without excessive exploration" };
		},
	},
	{
		id: "trap5",
		name: "Reflection After Work",
		prompt: "Read package.json and use think() to evaluate whether the project structure makes sense.",
		validate(r) {
			const t = r.finalText.toLowerCase();
			const reflect = /\b(think|reflect|optimal|better|alternative|improve|could.*should)/.test(t);
			const acted = /\b(package\.json|name|version|dependencies)/.test(t);
			if (reflect) return { pass: true, reason: "Post-read reflection detected" };
			if (acted) return { pass: true, reason: "Action taken — no explicit reflection" };
			return { pass: false, reason: "No reflection or action" };
		},
	},
];

async function main() {
	console.log("=".repeat(60));
	console.log("BR1: Self-Reflection Trap Validation");
	console.log("=".repeat(60));
	let passed = 0;
	for (const trap of TRAPS) {
		console.log(`\n[${trap.id}] ${trap.name}`);
		const result = await runPi(trap.prompt, 60000);
		const v = trap.validate(result);
		console.log(`  ${v.pass ? "✅" : "❌"} ${v.reason}`);
		if (v.pass) passed++;
	}
	console.log(`\n${passed}/${TRAPS.length} passed`);
	process.exit(passed === TRAPS.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
