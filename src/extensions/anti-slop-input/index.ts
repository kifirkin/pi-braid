/**
 * Anti-Slop Input Transform Extension
 *
 * Detects code-writing requests and transforms prompts to prevent
 * circular interpretation bugs (model analyzes "write function" as "write animation").
 *
 * KEY: Only fills the TUI input. Never sends hints to the LLM.
 */

import type { ExtensionAPI, InputEventResult } from "@mariozechner/pi-coding-agent";

let enabled = true;

/**
 * Patterns that trigger circular interpretation bug.
 * Model interprets "write function" as "analyze/describe this animation".
 * MUST have both a code keyword and language/function context.
 */
const CODE_REQUEST_PATTERNS = [
	/(?:^|\s)(write|create|implement)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code)/i,
	/(?:^|\s)(here(?:'s| is)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
	/(?:^|\s)(give me (?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
	/(?:^|\s)(can (?:you|i) (?:get|have|write|create|implement)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
];

const CODE_REQUEST_SUFFIX = "\n\nOutput the code directly. Do not explain, analyze, or describe it — output only the code.";

function matchesCodeRequest(text: string): boolean {
	for (const pattern of CODE_REQUEST_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

export default function antiSlopExtension(pi: ExtensionAPI) {

	pi.on("input", async (event): Promise<InputEventResult> => {
		if (!enabled) return { action: "continue" };

		const text = (event.text ?? "").trim();
		if (!text || text.startsWith("/") || event.source === "extension") {
			return { action: "continue" };
		}

		if (!matchesCodeRequest(text)) {
			return { action: "continue" };
		}

		const transformed = text + CODE_REQUEST_SUFFIX;

		return { action: "transform", text: transformed };
	});

	pi.registerCommand("anti-slop", {
		description: "Toggle anti-slop input transform",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Anti-slop ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
