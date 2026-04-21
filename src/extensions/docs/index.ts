/**
 * Document tools - read various document formats
 *
 * Supports formats via macOS native tools:
 * - doc, docx, rtf, rtfd, html, htm, txt: via textutil
 * - pdf: via pdftotext (poppler) or strings fallback
 *
 * NEVER returns raw binary content to the agent.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

const readDocSchema = Type.Object({
	path: Type.String({ description: "Path to document file" }),
	format: Type.Optional(
		StringEnum(["txt", "html", "rtf"], {
			default: "txt",
			description: "Output format",
		}),
	),
	maxLines: Type.Optional(Type.Number({ default: 500, description: "Max lines to return" })),
});

const TEXTUTIL_FORMATS = ["doc", "docx", "rtf", "rtfd", "html", "htm", "txt"];
const PDF_FORMATS = ["pdf"];
const ALL_FORMATS = [...TEXTUTIL_FORMATS, ...PDF_FORMATS];

/** Check if a command exists in PATH */
function commandExists(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Detect available PDF text extraction tools */
function detectPdfTools(): { pdftotext: boolean } {
	return {
		pdftotext: commandExists("pdftotext"),
	};
}

const pdfTools = detectPdfTools();

/**
 * Check if content looks like binary (not readable text).
 * Returns true if content contains null bytes or excessive control characters.
 */
function isBinaryContent(content: string): boolean {
	// Check for null bytes (strongest binary indicator)
	if (content.includes("\0")) return true;

	// Check ratio of control characters (excluding whitespace)
	const sampleSize = Math.min(content.length, 8192);
	const sample = content.slice(0, sampleSize);
	let controlChars = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		// Control chars except tab (9), newline (10), carriage return (13)
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
			controlChars++;
		}
	}
	// If >5% control characters, it's likely binary
	return controlChars / sampleSize > 0.05;
}

/**
 * Truncate content to maxLines.
 */
function truncateLines(content: string, maxLines: number): string {
	const lines = content.split("\n");
	if (lines.length > maxLines) {
		return `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length} total lines)`;
	}
	return content;
}

/**
 * Read PDF text using pdftotext (from poppler).
 * Returns extracted text or null if extraction failed.
 */
function extractPdfWithPdftotext(path: string): string | null {
	if (!pdfTools.pdftotext) return null;

	try {
		const result = execSync(`pdftotext -layout "${path}" -`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			timeout: 30000,
		});
		if (result && result.trim().length > 0 && !isBinaryContent(result)) {
			return result;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Fallback: extract readable strings from PDF using `strings`.
 * Only useful for uncompressed/old PDFs. Returns null if output
 * is mostly PDF structure (not human-readable text).
 */
function extractPdfWithStrings(path: string): string | null {
	try {
		const result = execSync(`strings -n 6 "${path}"`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			timeout: 15000,
		});
		if (!result || result.trim().length < 50 || isBinaryContent(result)) {
			return null;
		}

		// Check if output is mostly PDF structure (not readable text)
		const lines = result.split("\n").filter((l) => l.trim().length > 0);
		const structurePatterns = /^(<<|>>|endobj|stream|endstream|xref|trailer|obj$|\d+ \d+ obj)/;
		const nonStructureLines = lines.filter((l) => !structurePatterns.test(l.trim()));
		const readableRatio = nonStructureLines.length / lines.length;

		// If <30% of lines are non-structure, strings didn't extract useful text
		if (readableRatio < 0.3) return null;

		return nonStructureLines.join("\n");
	} catch {
		return null;
	}
}

/**
 * Read PDF — tries pdftotext, falls back to strings.
 * NEVER returns raw binary. Returns null if no text could be extracted.
 */
function readPdf(path: string, maxLines: number): { content: string; method: string } {
	// Try pdftotext first (best quality)
	const pdftotextResult = extractPdfWithPdftotext(path);
	if (pdftotextResult) {
		return { content: truncateLines(pdftotextResult, maxLines), method: "pdftotext" };
	}

	// Fallback: strings extraction (safe, no binary pollution)
	const stringsResult = extractPdfWithStrings(path);
	if (stringsResult) {
		return {
			content: truncateLines(
				`[Note: pdftotext not available, extracted using 'strings' — formatting may be rough]\n\n${stringsResult}`,
				maxLines,
			),
			method: "strings",
		};
	}

	// Complete failure — return helpful error, never binary
	throw new Error(
		"Could not extract text from PDF. " +
		(pdfTools.pdftotext
			? "pdftotext ran but produced no output (possibly image-only PDF)."
			: "Install pdftotext for better PDF support: brew install poppler") +
		"\nFor image-based PDFs, use analyze_image on each page screenshot instead.",
	);
}

/**
 * Read document using macOS textutil.
 */
async function readWithTextutil(path: string, format: string, maxLines: number): Promise<string> {
	const tmpFile = `/tmp/doc_extract_${Date.now()}.txt`;

	execSync(`textutil -convert ${format} "${path}" -output "${tmpFile}"`, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
	});

	let content: string;
	try {
		content = await fs.readFile(tmpFile, "utf-8");
	} finally {
		try { await fs.unlink(tmpFile); } catch { /* ignore */ }
	}

	// Binary safety check for textutil output too
	if (isBinaryContent(content)) {
		throw new Error("textutil produced binary output — file may be corrupted or unsupported");
	}

	return truncateLines(content, maxLines);
}

export default function docExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_document",
		label: "Read Document",
		description:
			"Read text from various document formats (doc, docx, rtf, html, txt, pdf). " +
			"For PDF: uses pdftotext if available, otherwise 'strings' fallback. " +
			"Install pdftotext via: brew install poppler",
		parameters: readDocSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<{ lines: number; format: string; method?: string }>> => {
			if (!fsSync.existsSync(params.path)) {
				return {
					content: [{ type: "text" as const, text: `File not found: ${params.path}` }],
					details: { lines: 0, format: "none" },
				};
			}

			const ext = params.path.toLowerCase().split(".").pop() || "";
			const isPdf = PDF_FORMATS.includes(ext);
			const isTextutil = TEXTUTIL_FORMATS.includes(ext);

			if (!isPdf && !isTextutil) {
				return {
					content: [{
						type: "text" as const,
						text: `Unsupported format: .${ext}. Supported: ${ALL_FORMATS.join(", ")}`,
					}],
					details: { lines: 0, format: "none" },
				};
			}

			const maxLines = params.maxLines || 500;

			try {
				if (isPdf) {
					const { content, method } = readPdf(params.path, maxLines);
					const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
					return {
						content: [{ type: "text" as const, text: content }],
						details: { lines, format: "pdf", method },
					};
				} else {
					const outputFormat = params.format || "txt";
					const content = await readWithTextutil(params.path, outputFormat, maxLines);
					const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
					return {
						content: [{ type: "text" as const, text: content }],
						details: { lines, format: ext },
					};
				}
			} catch (error) {
				const message = (error as Error).message;
				return {
					content: [{ type: "text" as const, text: `Error reading document: ${message}` }],
					details: { lines: 0, format: isPdf ? "pdf" : ext },
				};
			}
		},
	});
}
