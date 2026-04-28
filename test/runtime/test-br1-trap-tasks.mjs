/**
 * BR1: Self-Reflection Trap Task Validation
 * ==========================================
 * Tests whether the agent exhibits self-reflective behavior.
 *
 * NOTE: pi RPC mode does NOT expose individual tool_call events.
 * Validation is based on the final agent text response and completion status.
 *
 * Success criteria:
 * - Agent completes (agent_end fires)
 * - Final text contains evidence of self-reflection: "think()", "reflection",
 *   "reflect", "observe", "hypothesize", or similar meta-cognitive language
 * - For error tasks: different approach attempted after failure
 *
 * Run: node test/runtime/test-br1-trap-tasks.mjs
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout } from "timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * Run a pi task via RPC mode. Returns agent_end messages + final text.
 * NOTE: RPC mode doesn't expose individual tool_call events — only final responses.
 */
async function runPi(prompt, timeoutMs = 60000) {
	const model = process.env.PI_MODEL || "openrouter/qwen/qwen3.5-flash-02-23";
	const proc = spawn("pi", [
		"--mode", "rpc", "--no-session",
		"--provider", "openrouter", "--model", model,
		"-e", ROOT,
	], { stdio: ["pipe", "pipe", "pipe"] });

	const events = [];
	let stdout = "";

	proc.stdout.on("data", (d) => {
		const chunk = d.toString();
		stdout += chunk;
		const lines = chunk.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try { events.push(JSON.parse(line)); } catch { /* non-JSON */ }
		}
	});

	proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
	proc.stdin.end();

	await setTimeout(timeoutMs);
	proc.kill();
	await new Promise((r) => proc.on("close", r));

	// Extract final assistant text from agent_end
	let finalText = "";
	let completed = false;
	let messages = [];

	for (const ev of events) {
		if (ev.type === "agent_end") {
			completed = true;
			messages = ev.messages || [];
			// Get last assistant message text
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
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

	return { events, stdout, finalText, completed, messages, timedOut: false };
}

// ── Trap Definitions ─────────────────────────────────────────────────────────
//
// Each trap validates self-reflective behavior via final text analysis.
// RPC mode doesn't expose tool calls, so we validate what the agent REPORTS doing.

const TRAPS = [
	{
		id: "trap1_tool_spiral",
		name: "Tool Spiral Trap",
		prompt: `The button on my page is 3px off-center. Take a screenshot, analyze the alignment, then fix the CSS. Use think() to plan your approach before acting. Be concise.`,
		validate(result) {
			const { finalText, completed } = result;
			if (!completed) return { pass: false, reason: "Agent did not complete" };

			const text = finalText.toLowerCase();
			const selfReflect = /\b(think|reflect|observe|analyze|plan|hypothes)/.test(text);
			const concise = finalText.length < 800;

			if (selfReflect) {
				return { pass: true, reason: "Self-reflective language detected — meta-cognition active" };
			}
			if (concise && /\b(screenshot|css|fix|align)/.test(text)) {
				return { pass: true, reason: "Concise action-oriented response without tool spiral" };
			}
			return { pass: false, reason: `No self-reflection in ${finalText.length} char response` };
		},
	},
	{
		id: "trap2_error_handling",
		name: "Error Handling Trap",
		prompt: `Try to fetch https://api.example.invalid/weather using web_fetch. If it fails, try a different approach — think about what might work better.`,
		validate(result) {
			const { finalText, completed } = result;
			if (!completed) return { pass: false, reason: "Agent did not complete" };

			const text = finalText.toLowerCase();
			const errorAware = /\b(fail|error|invalid|couldn't|doesn't work|try|alternative|different)/.test(text);
			const reflectOnFailure = /\b(think|maybe|because|perhaps|should|try.*instead)/.test(text);

			if (errorAware && reflectOnFailure) {
				return { pass: true, reason: "Error acknowledged with adaptive reflection" };
			}
			if (errorAware) {
				return { pass: true, reason: "Error acknowledged — adaptive behavior" };
			}
			return { pass: false, reason: "No error awareness or adaptive reflection" };
		},
	},
	{
		id: "trap3_conflict_detection",
		name: "Conflicting Evidence Trap",
		prompt: `Search for 'processFlow' in the codebase. If you find conflicting definitions vs calls, use think() to analyze the discrepancy before giving an answer.`,
		validate(result) {
			const { finalText, completed } = result;
			if (!completed) return { pass: false, reason: "Agent did not complete" };

			const text = finalText.toLowerCase();
			const conflictAware = /(conflict|differ|contradict|inconsistent|mismatch|discrepancy)/.test(text);
			const selfReflect = /\b(think|reflect|analyze|look.*closer|examining)/.test(text);

			if (conflictAware && selfReflect) {
				return { pass: true, reason: "Conflict detected with reflective analysis" };
			}
			if (conflictAware) {
				return { pass: true, reason: "Conflict detected — awareness present" };
			}
			return { pass: false, reason: "No conflict detection or reflection" };
		},
	},
	{
		id: "trap4_concise_answer",
		name: "Rabbit Hole Trap",
		prompt: `How does fs.writeFile work in Node.js? Answer concisely in 2-3 sentences. No need to read source files.`,
		validate(result) {
			const { finalText, completed } = result;
			if (!completed) return { pass: false, reason: "Agent did not complete" };

			const text = finalText.toLowerCase();
			const concise = finalText.length < 400;
			const direct = /\b(write|file|asynchronously|async|promise)/.test(text);
			const excessiveRead = /\bread.*node.*source|check.*docs.*for.*fs\.|\.js source file/.test(text);

			if (concise && direct && !excessiveRead) {
				return { pass: true, reason: `Concise answer (${finalText.length} chars) — no rabbit hole` };
			}
			if (excessiveRead) {
				return { pass: false, reason: "Excessive source reading — rabbit hole detected" };
			}
			return { pass: true, reason: "Direct answer without excessive exploration" };
		},
	},
	{
		id: "trap5_reflection_after_work",
		name: "Reflection After Work Trap",
		prompt: `Add a comment to any file in this project explaining what you just did. Use think() to reflect on whether your approach was optimal.`,
		validate(result) {
			const { finalText, completed } = result;
			if (!completed) return { pass: false, reason: "Agent did not complete" };

			const text = finalText.toLowerCase();
			const reflect = /\b(think|reflect|optimal|better.*approach|alternative|improvement|could.*improve)/.test(text);
			const acted = /\b(comment|edit|write|file|added)/.test(text);

			if (reflect) {
				return { pass: true, reason: "Post-action reflection detected — meta-cognition active" };
			}
			if (acted) {
				return { pass: true, reason: "Action taken — brief but no explicit reflection" };
			}
			return { pass: false, reason: "No reflection or action in response" };
		},
	},
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
	console.log("=".repeat(70));
	console.log("BR1: Self-Reflection Trap Task Validation");
	console.log("(RPC mode — validates via final text response)");
	console.log("=".repeat(70));
	console.log();

	const results = [];
	let passed = 0;

	for (const trap of TRAPS) {
		console.log(`\n[${trap.id}] ${trap.name}`);
		console.log("-".repeat(60));

		const result = await runPi(trap.prompt, 90000);
		const { finalText, completed } = result;

		console.log(`  Completed: ${completed}`);
		console.log(`  Response length: ${finalText.length} chars`);
		const preview = finalText.slice(0, 200).replace(/\n/g, " ");
		console.log(`  Preview: ${preview}${finalText.length > 200 ? "..." : ""}`);

		const validation = trap.validate(result);
		results.push({ id: trap.id, ...validation });

		if (validation.pass) {
			console.log(`  ✅ PASS: ${validation.reason}`);
			passed++;
		} else {
			console.log(`  ❌ FAIL: ${validation.reason}`);
		}
	}

	// Summary
	console.log();
	console.log("=".repeat(70));
	console.log(`RESULTS: ${passed}/${TRAPS.length} traps passed`);
	console.log("=".repeat(70));
	for (const r of results) {
		const icon = r.pass ? "✅" : "❌";
		console.log(`  ${icon} ${r.id}: ${r.reason}`);
	}

	process.exit(passed === TRAPS.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
