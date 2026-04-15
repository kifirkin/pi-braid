/**
 * REPL Extension - Native TypeScript/JavaScript code execution
 *
 * Provides a `repl` tool for running TypeScript/JavaScript code with
 * persistent state between calls within a session. Native to pi-agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReplTool } from "../../tools/repl.js";

export default function replExtension(pi: ExtensionAPI) {
	const replTool = createReplTool();

	pi.registerTool({
		name: replTool.name,
		label: replTool.label,
		description: replTool.description,
		parameters: replTool.parameters,
		execute: replTool.execute,
	});
}
