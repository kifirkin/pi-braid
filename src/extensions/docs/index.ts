/**
 * Document tools - read various document formats
 * Uses macOS textutil command
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";

const readDocSchema = Type.Object({
	path: Type.String({ description: "Path to document file" }),
	format: Type.Optional(
		Type.Union([Type.Literal("txt"), Type.Literal("html"), Type.Literal("rtf")], {
			default: "txt",
			description: "Output format",
		}),
	),
	maxLines: Type.Optional(Type.Number({ default: 500, description: "Max lines to return" })),
});

function isValidDoc(path: string): boolean {
	const ext = path.toLowerCase().split(".").pop();
	const valid = ["doc", "docx", "rtf", "rtfd", "html", "htm", "txt", "pdf"];
	return valid.includes(ext || "") && fs.existsSync(path);
}

export default function docExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_document",
		label: "Read Document",
		description: "Read text from various document formats (doc, docx, rtf, html, txt)",
		parameters: readDocSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ lines: number }>> => {
			if (!fs.existsSync(params.path)) {
				return {
					content: [{ type: "text" as const, text: `File not found: ${params.path}` }],
					details: { lines: 0 },
				};
			}

			if (!isValidDoc(params.path)) {
				return {
					content: [{ type: "text" as const, text: "Unsupported format or invalid file" }],
					details: { lines: 0 },
				};
			}

			try {
				const format = params.format || "txt";
				const tmpFile = `/tmp/doc_extract_${Date.now()}.txt`;

				execSync(`textutil -convert ${format} "${params.path}" -output ${tmpFile}`, {
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
				});

				let content = fs.readFileSync(tmpFile, "utf-8");
				fs.unlinkSync(tmpFile);

				const lines = content.split("\n");
				const maxLines = params.maxLines || 500;

				if (lines.length > maxLines) {
					content = `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length} total lines)`;
				}

				return {
					content: [{ type: "text" as const, text: content }],
					details: { lines: lines.length },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
					details: { lines: 0 },
				};
			}
		},
	});
}
