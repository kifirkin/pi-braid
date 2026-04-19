/**
 * Anti-Slop Input Transform Extension
 * 
 * Transforms slop-prone prompts BEFORE they reach the LLM.
 * 
 * Pattern: Model interprets "write function" as "analyze/animation this code".
 * Fix: Append directive suffix to force code output mode.
 * 
 * KEY DESIGN:
 * - Runs independently of user-message-preprocessor
 * - NOT disabled when preprocessor is off
 * - Uses conservative patterns only (clear code generation slop)
 */

import type { ExtensionAPI, InputEventResult } from "@mariozechner/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSERVATIVE PATTERN DETECTION
// Only transform prompts that are CLEARLY code generation requests
// that the model misinterprets as analysis requests
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Patterns that trigger circular interpretation bug.
 * Model interprets "write function" as "analyze/animation this code".
 * 
 * MUST have:
 * 1. Clear code keyword (write/create/implement)
 * 2. Language/function context nearby
 */
const CODE_REQUEST_PATTERNS = [
	// "Write a JavaScript function" - code keyword + language/function
	/(?:^|\s)(write|create|implement)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code)/i,
	
	// "Here's a JavaScript function:" - here is + language/function context
	/(?:^|\s)(here(?:'s| is)|here(?:'s| is) (?:a|an))\s+(?:javascript|js|typescript|python|function|class|code)/i,
];

/**
 * The suffix appended when code request slop is detected.
 * Direct, clear instruction to the model.
 */
const CODE_REQUEST_SUFFIX = " [CODE: Write the requested code. Return ONLY code block. No preamble, no explanation.]";

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let enabled = true;

// ═══════════════════════════════════════════════════════════════════════════════
// PATTERN MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if text matches any code request pattern.
 */
function matchesCodeRequest(text: string): boolean {
	for (const pattern of CODE_REQUEST_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════════════

export default function antiSlopExtension(pi: ExtensionAPI) {

	// ── Input Transform ───────────────────────────────────────────────────
	// Transform slop-prone prompts BEFORE they reach the LLM.
	// This runs regardless of preprocessor enabled/disabled state.

	pi.on("input", async (event, _ctx): Promise<InputEventResult> => {
		if (!enabled) {
			return { action: "continue" };
		}

		const text = event.text?.trim() || "";
		
		// Skip: empty, commands, or extension-injected messages
		if (!text || text.startsWith("/") || event.source === "extension") {
			return { action: "continue" };
		}

		// Check for code request slop
		if (matchesCodeRequest(text)) {
			return {
				action: "transform",
				text: text + CODE_REQUEST_SUFFIX,
			};
		}

		return { action: "continue" };
	});

	// ── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("anti-slop", {
		description: "Toggle anti-slop input transform",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Anti-slop ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("anti-slop-test", {
		description: "Test anti-slop pattern detection",
		handler: async (args, ctx) => {
			const text = args || "Write a JavaScript function reverse(s)";
			if (matchesCodeRequest(text)) {
				ctx.ui.notify(`SLOP: "${text}"${CODE_REQUEST_SUFFIX}`, "warning");
			} else {
				ctx.ui.notify(`No slop: "${text}"`, "info");
			}
		},
	});

}
