/**
 * REPL Extension - Interactive code execution with persistent state
 *
 * Provides a `repl` tool for running Python/Node/Shell code with
 * variable state that persists between calls within a session.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReplTool } from "../../tools/repl.js";

export default function replExtension(pi: ExtensionAPI) {
	const replTool = createReplTool(process.cwd());

	pi.registerTool({
		name: replTool.name,
		label: replTool.label,
		description: replTool.description,
		parameters: replTool.parameters,
		execute: replTool.execute,
	});
}
