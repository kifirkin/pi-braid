/**
 * Document tools - read various document formats
 *
 * Supports formats via macOS native tools:
 * - doc, docx, rtf, rtfd, html, htm, txt: via textutil
 * - pdf: via native PDF tools (pdftotext, qlmanage, or textutil fallback)
 *
 * Probes for available PDF tools and uses the best available option.
 * Provides helpful error messages when tools are missing.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

/**
 * Standard formats supported by macOS textutil
 */
const TEXTUTIL_FORMATS = ["doc", "docx", "rtf", "rtfd", "html", "htm", "txt"];

/**
 * PDF formats - handled separately from textutil
 */
const PDF_FORMATS = ["pdf"];

const ALL_FORMATS = [...TEXTUTIL_FORMATS, ...PDF_FORMATS];

/**
 * Check if a command exists in PATH
 */
function commandExists(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Available PDF tools on this system
 */
interface PdfTools {
	pdftotext: boolean;
	qlmanage: boolean;
}

function detectPdfTools(): PdfTools {
	return {
		pdftotext: commandExists("pdftotext"),
		qlmanage: commandExists("qlmanage"),
	};
}

const cachedPdfTools = detectPdfTools();

/**
 * Get format description for error messages
 */
function getFormatDescription(ext: string): string {
	const descriptions: Record<string, string> = {
		doc: "Word document (.doc)",
		docx: "Word document (.docx)",
		rtf: "Rich Text Format (.rtf)",
		rtfd: "Rich Text Format with attachments (.rtfd)",
		html: "HTML document (.html)",
		htm: "HTML document (.htm)",
		txt: "Plain text (.txt)",
		pdf: "PDF document (.pdf)",
	};
	return descriptions[ext] || ext;
}

/**
 * Check if file is valid document
 */
function isValidDoc(path: string): { valid: boolean; format: string; isPdf: boolean } {
	const ext = path.toLowerCase().split(".").pop() || "";
	const format = TEXTUTIL_FORMATS.includes(ext) ? ext : PDF_FORMATS.includes(ext) ? ext : "";
	return {
		valid: format.length > 0 && fsSync.existsSync(path),
		format,
		isPdf: PDF_FORMATS.includes(ext),
	};
}

/**
 * Read PDF using available tools
 */
async function readPdf(path: string, maxLines: number): Promise<string> {
	const { pdftotext, qlmanage } = cachedPdfTools;
	const tmpFile = `/tmp/pdf_extract_${Date.now()}.txt`;

	try {
		let content: string;

		if (pdftotext) {
			// Best option: pdftotext (from poppler/poppler-utils)
			execSync(`pdftotext -layout "${path}" "${tmpFile}"`, {
				encoding: "utf-8",
				maxBuffer: 10 * 1024 * 1024,
			});
			content = await fs.readFile(tmpFile, "utf-8");
		} else if (qlmanage) {
			// macOS native: Quick Look can extract text from PDFs
			const { stdout } = await execAsync(
				`qlmanage -t -o /tmp -f 1 "${path}" 2>/dev/null && cat /tmp/*.txt 2>/dev/null || echo "QL extraction failed"`,
				{ timeout: 30000 },
			);
			// qlmanage -t outputs to /tmp/<basename>.txt
			const baseName = path.split("/").pop()?.replace(".pdf", "") || "document";
			const qlOutput = `/tmp/${baseName}.txt`;
			if (fsSync.existsSync(qlOutput)) {
				content = await fs.readFile(qlOutput, "utf-8");
			} else {
				// Fallback: try text extraction via macOS
				execSync(`cupsfilter "${path}" 2>/dev/null | textutil -convert txt -stdin -stdout > "${tmpFile}"`, {
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
				});
				content = await fs.readFile(tmpFile, "utf-8");
			}
		} else {
			// No PDF tools available
			const missingTools: string[] = [];
			if (!pdftotext) missingTools.push("pdftotext (install: brew install poppler)");
			if (!qlmanage) missingTools.push("qlmanage (built into macOS, check /usr/bin/qlmanage)");

			throw new Error(
				"NO_PDF_TOOLS:No PDF text extraction tools found. " +
				"Install pdftotext with: brew install poppler\n" +
				"Or ensure qlmanage is accessible: which qlmanage\n" +
				"For now, use bash to download and extract: curl -L <url> -o file.pdf && pdftotext file.pdf -",
			);
		}

		// Clean up temp file
		if (fsSync.existsSync(tmpFile)) await fs.unlink(tmpFile);

		// Truncate if needed
		const lines = content.split("\n");
		if (lines.length > maxLines) {
			content = `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length} total lines)`;
		}

		return content;
	} catch (error) {
		if (fsSync.existsSync(tmpFile)) {
			try {
				await fs.unlink(tmpFile);
			} catch {}
		}
		throw error;
	}
}

/**
 * Read document using macOS textutil
 */
async function readWithTextutil(path: string, format: string, maxLines: number): Promise<string> {
	const tmpFile = `/tmp/doc_extract_${Date.now()}.txt`;

	execSync(`textutil -convert ${format} "${path}" -output ${tmpFile}`, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
	});

	let content: string;
	try {
		content = await fs.readFile(tmpFile, "utf-8");
	} finally {
		try { await fs.unlink(tmpFile); } catch { /* ignore */ }
	}

	const lines = content.split("\n");
	if (lines.length > maxLines) {
		content = `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length} total lines)`;
	}

	return content;
}

export default function docExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_document",
		label: "Read Document",
		description:
			"Read text from various document formats (doc, docx, rtf, html, txt, pdf). " +
			"For PDF: uses pdftotext if available, otherwise qlmanage (macOS native). " +
			"Install pdftotext via: brew install poppler",
		parameters: readDocSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ lines: number; format: string }>> => {
			if (!fsSync.existsSync(params.path)) {
				return {
					content: [{ type: "text" as const, text: `File not found: ${params.path}` }],
					details: { lines: 0, format: "none" },
				};
			}

			const validation = isValidDoc(params.path);
			if (!validation.valid) {
				const ext = params.path.toLowerCase().split(".").pop() || "unknown";
				return {
					content: [
						{
							type: "text" as const,
							text: `Unsupported format: ${getFormatDescription(ext)}. ` +
								`Supported formats: ${ALL_FORMATS.join(", ")}`,
						},
					],
					details: { lines: 0, format: "none" },
				};
			}

			const maxLines = params.maxLines || 500;
			const format = validation.format;

			try {
				let content: string;

				if (validation.isPdf) {
					content = await readPdf(params.path, maxLines);
				} else {
					const outputFormat = params.format || "txt";
					content = await readWithTextutil(params.path, outputFormat, maxLines);
				}

				const lines = content.split("\n").filter((l) => l.trim().length > 0).length;

				return {
					content: [{ type: "text" as const, text: content }],
					details: { lines, format },
				};
			} catch (error) {
				const message = (error as Error).message;

				// Provide helpful context for common errors
				if (message.includes("NO_PDF_TOOLS")) {
					return {
						content: [{ type: "text" as const, text: message }],
						details: { lines: 0, format: "pdf" },
					};
				}

				// Check if it's a textutil error for PDF (common mistake)
				if (message.includes("Unsupported format") && params.path.toLowerCase().endsWith(".pdf")) {
					return {
						content: [
							{
								type: "text" as const,
								text: `PDF files cannot be read with textutil. ` +
									`Install pdftotext: brew install poppler\n` +
									`Or use bash directly:\n` +
									`  curl -L <url> -o file.pdf && pdftotext file.pdf -`,
							},
						],
						details: { lines: 0, format: "pdf" },
					};
				}

				return {
					content: [{ type: "text" as const, text: `Error reading document: ${message}` }],
					details: { lines: 0, format },
				};
			}
		},
	});
}
