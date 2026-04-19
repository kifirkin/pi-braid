/**
 * Web Fetch Extension - pi-scurl reimplemented without external deps.
 *
 * Provides a `web_fetch` tool that:
 * - Fetches URLs and converts HTML to LLM-optimized markdown (pure Node.js)
 * - Scans outgoing requests for leaked API keys/tokens
 * - Detects prompt injection in fetched content
 * - Rejects binary content (PDF, images, videos, etc.) with helpful error messages
 * - Truncates output to stay within context limits
 *
 * All logic uses Node.js built-ins only. No external dependencies.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

import { scanUrl, scanHeaders } from "./secrets.js";
import { analyzeInjection, wrapInjection } from "./injection.js";
import type { InjectionAction } from "./injection.js";
import { htmlToMarkdown } from "./markdown.js";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;

// Binary content types that cannot be meaningfully converted to text
const BINARY_CONTENT_TYPES = [
	"application/pdf",
	"application/postscript", // .ai, .eps
	"application/zip",
	"application/x-zip-compressed",
	"application/x-rar-compressed",
	"application/x-7z-compressed",
	"application/x-tar",
	"application/gzip",
	"application/x-gzip",
	"application/java-archive", // .jar
	"application/octet-stream", // generic binary (often downloads)
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
	"image/",
	"audio/",
	"video/",
	"font/",
];

function isBinaryContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase().trim().split(";")[0];
	return BINARY_CONTENT_TYPES.some(
		(binary) => normalized === binary || normalized.startsWith(binary),
	);
}

const fetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	raw: Type.Optional(
		Type.Boolean({ description: "Return raw response without HTML-to-markdown conversion (default: false)" }),
	),
	minimal: Type.Optional(
		Type.Boolean({ description: "Use minimal preset for LLM-optimized output (default: true)" }),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Custom request headers as key-value pairs",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Request timeout in milliseconds (default: 30000)" }),
	),
	injection_action: Type.Optional(
		StringEnum(["warn", "redact", "tag", "none"] as const, {
			description: "Action on prompt injection: warn (wrap tags), redact (mask patterns), tag (untrusted only), none (disabled). Default: warn",
		}),
	),
});

type FetchInput = Static<typeof fetchParams>;

interface FetchDetails {
	url: string;
	status: number;
	converted: boolean;
	originalSize: number;
	outputSize: number;
	reduction: string;
	injectionFlagged: boolean;
	injectionScore?: number;
	error?: string;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatReduction(original: number, output: number): string {
	if (original === 0) return "0%";
	return `${((1 - output / original) * 100).toFixed(1)}%`;
}

interface FetchResult {
	content: string;
	status: number;
	contentType: string;
	url: string;
	converted: boolean;
	originalSize: number;
	outputSize: number;
	injection?: ReturnType<typeof analyzeInjection>;
	error?: string;
}

async function secureFetch(url: string, options: {
	raw?: boolean;
	headers?: Record<string, string>;
	timeout?: number;
	injectionAction?: InjectionAction;
	signal?: AbortSignal;
}): Promise<FetchResult> {
	const {
		raw = false,
		headers = {},
		timeout = 30_000,
		injectionAction = "warn",
		signal,
	} = options;

	// Secret scanning on outgoing request
	const urlScan = scanUrl(url);
	if (urlScan.found) {
		return {
			content: "",
			status: 0,
			contentType: "",
			url,
			converted: false,
			originalSize: 0,
			outputSize: 0,
			error: `BLOCKED: ${urlScan.pattern!.name} detected in ${urlScan.location}. Remove the secret before fetching.`,
		};
	}

	const headerScan = scanHeaders(headers);
	if (headerScan.found) {
		return {
			content: "",
			status: 0,
			contentType: "",
			url,
			converted: false,
			originalSize: 0,
			outputSize: 0,
			error: `BLOCKED: ${headerScan.pattern!.name} detected in ${headerScan.location}. Remove the secret before fetching.`,
		};
	}

	// HTTP fetch
	let response: Response;
	try {
		const controller = new AbortController();
		const combinedSignal = signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal;

		const timer = setTimeout(() => controller.abort(), timeout);

		response = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate, br",
				"Cache-Control": "no-cache",
				"Pragma": "no-cache",
				"Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
				"Sec-Ch-Ua-Mobile": "?0",
				"Sec-Ch-Ua-Platform": '"macOS"',
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
				...headers,
			},
			signal: combinedSignal,
			redirect: "follow",
		});

		clearTimeout(timer);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? err.cause : undefined;

		let hint = "";
		if (cause && typeof cause === "object" && "code" in cause) {
			switch ((cause as { code: string }).code) {
				case "ECONNREFUSED":
					hint = " - server not accepting connections (check host/port)";
					break;
				case "ENOTFOUND":
					hint = " - DNS lookup failed (check hostname)";
					break;
				case "ETIMEDOUT":
					hint = " - connection timed out";
					break;
				case "ECONNRESET":
					hint = " - connection reset by server (possible anti-bot blocking)";
					break;
				case "ENETUNREACH":
					hint = " - network unreachable (check connectivity)";
					break;
				case "EAI_AGAIN":
					hint = " - DNS temporary failure, retry later";
					break;
			}
		}
		if (!hint) hint = " - check URL and try again";

		return {
			content: "",
			status: 0,
			contentType: "",
			url,
			converted: false,
			originalSize: 0,
			outputSize: 0,
			error: err instanceof Error && err.name === "AbortError"
				? "Request timed out or was cancelled"
				: message.replace(/^fetch failed:\s*/i, "") + hint,
		};
	}

	const contentType = response.headers.get("content-type") ?? "";
	let body: string;
	try {
		body = await response.text();
	} catch {
		return {
			content: "",
			status: response.status,
			contentType,
			url,
			converted: false,
			originalSize: 0,
			outputSize: 0,
			error: "Failed to read response body",
		};
	}

	const originalSize = new TextEncoder().encode(body).length;

	// Non-HTML: check for binary content types
	if (!contentType.includes("text/html") || raw) {
		// Detect binary content and reject with helpful message
		if (isBinaryContentType(contentType)) {
			const ext = contentType.includes("pdf") ? "PDF" : "binary";
			return {
				content: "",
				status: response.status,
				contentType,
				url,
				converted: false,
				originalSize,
				outputSize: 0,
				error: `Unsupported content type: ${contentType} (${formatSize(originalSize)}). Binary content like ${ext}s cannot be parsed as text. Consider downloading the file directly or using a PDF viewer service.`,
			};
		}

		let content = body;
		const injection = analyzeInjection(body);
		if (injection.flagged) {
			content = wrapInjection(body, injection, injectionAction);
		}
		const outputSize = new TextEncoder().encode(content).length;
		return {
			content,
			status: response.status,
			contentType,
			url,
			converted: false,
			originalSize,
			outputSize,
			injection,
		};
	}

	// HTML → Markdown via pure Node.js converter
	let markdown: string;
	try {
		markdown = htmlToMarkdown(body);
	} catch {
		return {
			content: body,
			status: response.status,
			contentType,
			url,
			converted: false,
			originalSize,
			outputSize: originalSize,
			error: "Markdown conversion failed",
		};
	}

	// Injection detection on markdown
	const injection = analyzeInjection(markdown);
	let content = markdown;
	if (injection.flagged) {
		content = wrapInjection(markdown, injection, injectionAction);
	}

	const outputSize = new TextEncoder().encode(content).length;

	return {
		content,
		status: response.status,
		contentType,
		url,
		converted: true,
		originalSize,
		outputSize,
		injection,
	};
}

export default function webFetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			`Fetch a URL and return clean markdown content optimized for LLMs. Converts HTML pages to compact markdown (~50-99% size reduction). Includes secret scanning (blocks requests containing API keys/tokens) and prompt injection detection. Binary content (PDFs, images, videos, etc.) is rejected with a helpful error message. Output truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}. Use for reading web pages, documentation, articles, API responses.`,

		parameters: fetchParams,

		async execute(_toolCallId, params: FetchInput, signal) {
			const url = (params.url || "").replace(/^@/, ""); // strip leading @

			const result = await secureFetch(url, {
				raw: params.raw,
				headers: params.headers,
				timeout: params.timeout,
				injectionAction: (params.injection_action as InjectionAction) ?? "warn",
				signal,
			});

			const details: FetchDetails = {
				url: result.url,
				status: result.status,
				converted: result.converted,
				originalSize: result.originalSize,
				outputSize: result.outputSize,
				reduction: formatReduction(result.originalSize, result.outputSize),
				injectionFlagged: result.injection?.flagged ?? false,
				injectionScore: result.injection?.score,
				error: result.error,
			};

			if (result.error) {
				return {
					content: [{ type: "text", text: result.error }],
					isError: true,
					details,
				};
			}

			// Truncate
			const truncation = truncateHead(result.content, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			// Header with metadata
			const header = [
				`URL: ${result.url}`,
				`Status: ${result.status}`,
				result.converted
					? `Converted: HTML → Markdown (${formatSize(result.originalSize)} → ${formatSize(result.outputSize)}, ${details.reduction} reduction)`
					: `Raw: ${formatSize(result.originalSize)}`,
			];
			if (result.injection?.flagged) {
				header.push(
					`⚠ Prompt injection detected (score: ${result.injection.score.toFixed(2)}, signals: ${result.injection.signals.join(", ")})`,
				);
			}

			return {
				content: [{ type: "text", text: header.join("\n") + "\n\n" + text }],
				details,
			};
		},

		renderCall(args: FetchInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url ?? "");
			if (args.raw) text += theme.fg("muted", " --raw");
			if (args.minimal === false) text += theme.fg("muted", " --full");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				const text = (result.content?.[0] as any)?.text ?? "Fetching...";
				return new Text(theme.fg("warning", text), 0, 0);
			}

			const d = result.details as FetchDetails | undefined;
			if (!d) {
				const raw = (result.content?.[0] as any)?.text ?? "";
				return new Text(raw, 0, 0);
			}

			if (d.error) {
				return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			}

			let text = d.converted
				? theme.fg("success", `✓ ${formatSize(d.originalSize)} → ${formatSize(d.outputSize)} (${d.reduction})`)
				: theme.fg("success", `✓ ${formatSize(d.outputSize)}`);
			text += theme.fg("muted", ` ${d.status}`);

			if (d.injectionFlagged) {
				text += theme.fg("warning", ` ⚠ injection p=${d.injectionScore?.toFixed(2)}`);
			}

			if (expanded) {
				const content = (result.content?.[0] as any)?.text ?? "";
				const lines = content.split("\n").slice(0, 20);
				text += "\n" + theme.fg("dim", lines.join("\n"));
				if (content.split("\n").length > 20) {
					text += "\n" + theme.fg("dim", "...");
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
