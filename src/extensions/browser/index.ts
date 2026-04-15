/**
 * Browser Extension — Native CDP browser automation, zero external deps.
 *
 * Connects to Chrome at localhost:9222 (must be started with --remote-debugging-port=9222).
 * No puppeteer or other browser automation packages required.
 *
 * Tools:
 * - browser_navigate: Navigate to URL
 * - browser_snapshot: Get DOM accessibility snapshot
 * - browser_eval: Execute JavaScript
 * - browser_screenshot: Take viewport screenshot
 * - browser_cookies: List cookies for current tab
 * - browser_content: Extract readable page content as markdown
 *
 * Commands:
 * - /browser-start: Start Chrome with remote debugging (macOS)
 * - /browser-connect: Connect to existing Chrome at :9222
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { CdpClient, isBrowserAvailable, listTabs } from "./cdp.js";
import { extractReadableContent } from "./readability.js";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;

// ── CDP connection state ─────────────────────────────────────────────
let cdp: CdpClient | null = null;
let connectedTabId: string = "";
let connectedUrl: string = "";
let sessionCleanup: (() => void) | null = null;

async function ensureConnected(): Promise<CdpClient> {
	if (cdp?.isConnected) return cdp;

	// Clean up old session
	if (cdp) {
		try { cdp.disconnect(); } catch { /* ignore */ }
		cdp = null;
	}
	if (sessionCleanup) {
		sessionCleanup();
		sessionCleanup = null;
	}

	const available = await isBrowserAvailable();
	if (!available) {
		throw new Error(
			"Chrome not reachable at localhost:9222.\n\n" +
			"Start Chrome with:\n" +
			'  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +
			'--remote-debugging-port=9222\n\n' +
			"Or on Linux:\n" +
			'  google-chrome --remote-debugging-port=9222',
		);
	}

	cdp = new CdpClient();
	await cdp.connectToBrowser();

	// Get active tab info
	const tabs = await listTabs();
	const activeTab = tabs[tabs.length - 1];
	connectedTabId = activeTab?.id ?? "";
	connectedUrl = activeTab?.url ?? "";

	// Listen for Page.navigated events to track URL
	sessionCleanup = cdp.onEvent((method, params) => {
		if (method === "Page.navigated" && typeof params === "object" && params !== null) {
			const p = params as { frame?: { url?: string } };
			if (p.frame?.url) connectedUrl = p.frame.url;
		}
	});

	return cdp;
}

// ── Common tool params ────────────────────────────────────────────────
const baseParams = Type.Object({
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

// ── browser_navigate ─────────────────────────────────────────────────
const navigateParams = Type.Object({
	...baseParams.properties,
	url: Type.String({ description: "URL to navigate to" }),
	new_tab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of current tab" })),
});

async function browserNavigate(input: Static<typeof navigateParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	// If new_tab, create a new target first
	let targetId: string | undefined;
	if (input.new_tab) {
		const resp = await fetch("http://localhost:9222/json/new?url=" + encodeURIComponent(input.url));
		const data = (await resp.json()) as { id: string; url: string };
		targetId = data.id;
		connectedUrl = data.url;
		connectedTabId = targetId;
		return {
			content: [{ type: "text", text: `✓ Opened in new tab: ${input.url}\nTab ID: ${targetId}` }],
			details: { url: connectedUrl, tabId: connectedTabId },
		};
	}

	// Navigate current tab
	await client.send("Page.navigate", { url: input.url });
	connectedUrl = input.url;

	// Wait for load
	const timeout = input.timeout ?? 30000;
	await new Promise((r) => setTimeout(r, Math.min(timeout, 10000)));

	return {
		content: [{ type: "text", text: `✓ Navigated to: ${input.url}` }],
		details: { url: connectedUrl, tabId: connectedTabId },
		isError: false,
	} as { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };
}

// ── browser_snapshot ─────────────────────────────────────────────────
const snapshotParams = Type.Object({
	...baseParams.properties,
	interactive: Type.Optional(Type.Boolean({ description: "Show only interactive elements (buttons, inputs, links)" })),
	depth: Type.Optional(Type.Number({ description: "Max DOM depth (default: unlimited)" })),
});

async function browserSnapshot(input: Static<typeof snapshotParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	// Get DOM tree
	const doc = (await client.send("DOM.getDocument", { depth: input.depth ?? -1, pierce: true })) as { root: { nodeId: number } };
	const tree = (await client.send(
		"DOM.getFlattenedDocument",
		{ depth: input.depth ?? -1, pierce: true },
	)) as { nodes: Array<{ nodeId: number; nodeName: string; value?: string; attributes?: string[]; childNodeCount: number }> };

	// Build text representation
	const lines: string[] = [];
	const MAX_DEPTH = input.depth ?? 10;

	if (connectedUrl) lines.push(`URL: ${connectedUrl}`);

	const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);

	function getAttrs(attrs?: string[]): string {
		if (!attrs) return "";
		const parts: string[] = [];
		for (let i = 0; i < attrs.length - 1; i += 2) {
			const k = attrs[i];
			const v = attrs[i + 1];
			if (["id", "class", "type", "placeholder", "name", "aria-label", "role"].includes(k)) {
				parts.push(`${k}="${v}"`);
			}
		}
		return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
	}

	let prevDepth = 0;
	for (const node of tree.nodes) {
		const depth = Math.min(node.childNodeCount > 0 ? prevDepth + 1 : prevDepth, MAX_DEPTH);

		if (node.nodeName === "#document") continue;

		if (node.nodeName === "#text") {
			const val = node.value?.trim();
			if (val) lines.push(`${"  ".repeat(depth)}"${val}"`);
		} else {
			const tag = node.nodeName.toLowerCase();
			const attrs = getAttrs(node.attributes);
			const interactive = interactiveTags.has(node.nodeName);
			const prefix = interactive ? "●" : "○";
			const extra = node.value ? ` "${node.value}"` : "";

			if (input.interactive && !interactive) {
				// Skip non-interactive in interactive mode
			} else {
				lines.push(`${"  ".repeat(depth)}${prefix} <${tag}${attrs}>${extra}`);
			}

			if (node.childNodeCount === 0) {
				prevDepth = depth;
			}
		}

		prevDepth = depth;
	}

	const text = lines.join("\n");
	const truncated = truncateHead(text, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });

	let output = truncated.content;
	if (truncated.truncated) {
		output += `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;
	}

	return {
		content: [{ type: "text", text: output }],
		details: { url: connectedUrl, tabId: connectedTabId, nodeCount: tree.nodes.length },
	};
}

// ── browser_eval ─────────────────────────────────────────────────────
const evalParams = Type.Object({
	...baseParams.properties,
	code: Type.String({ description: "JavaScript code to execute" }),
});

async function browserEval(input: Static<typeof evalParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	const result = (await client.send("Runtime.evaluate", {
		expression: input.code,
		returnByValue: true,
	})) as { result?: { type: string; value?: unknown; description?: string }; exceptionDetails?: unknown };

	if (result.exceptionDetails) {
		return {
			content: [{ type: "text", text: `Error: ${JSON.stringify(result.exceptionDetails)}` }],
			isError: true,
			details: {},
		};
	}

	const value = result.result?.value;
	let output: string;
	if (value === undefined) {
		output = result.result?.description ?? "(no return value)";
	} else if (typeof value === "string") {
		output = value;
	} else {
		output = JSON.stringify(value, null, 2);
	}

	const truncated = truncateHead(output, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
	return {
		content: [{ type: "text", text: truncated.content }],
		details: { url: connectedUrl, tabId: connectedTabId },
	};
}

// ── browser_screenshot ───────────────────────────────────────────────
const screenshotParams = Type.Object({
	...baseParams.properties,
	full: Type.Optional(Type.Boolean({ description: "Capture full page instead of viewport" })),
	format: Type.Optional(Type.String({ description: "Image format: png or jpeg (default: png)" })),
	quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100 (default: 80)" })),
});

async function browserScreenshot(input: Static<typeof screenshotParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	const result = (await client.send("Page.captureScreenshot", {
		format: input.format ?? "png",
		quality: input.quality ?? 80,
		// Note: CDP doesn't natively support full-page screenshot in one call
		// Would need to scroll and stitch. For now, just viewport.
	})) as { data: string };

	const mediaType = input.format === "jpeg" ? "image/jpeg" : "image/png";

	return {
		content: [{ type: "text", text: `[Screenshot captured (${mediaType}, ${(result.data.length * 0.75 / 1024).toFixed(1)}KB)]` }],
		details: { url: connectedUrl, tabId: connectedTabId, format: input.format ?? "png", base64Length: result.data.length },
	};
}

// ── browser_cookies ──────────────────────────────────────────────────
const cookiesParams = Type.Object({
	...baseParams.properties,
});

async function browserCookies(_input: Static<typeof cookiesParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	const result = (await client.send("Page.getCookies")) as { cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; session: boolean; expires?: number }> };

	if (result.cookies.length === 0) {
		return {
			content: [{ type: "text", text: "(no cookies for this page)" }],
			details: { url: connectedUrl, tabId: connectedTabId, count: 0 },
		};
	}

	const lines = result.cookies.map((c) => {
		const flags = [c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : "", c.session ? "Session" : ""].filter(Boolean).join(", ");
		return `${c.name}=${c.value}\n  domain: ${c.domain}  path: ${c.path}${flags ? `  [${flags}]` : ""}`;
	});

	return {
		content: [{ type: "text", text: lines.join("\n\n") }],
		details: { url: connectedUrl, tabId: connectedTabId, count: result.cookies.length },
	};
}

// ── browser_content ───────────────────────────────────────────────────
const contentParams = Type.Object({
	...baseParams.properties,
	url: Type.Optional(Type.String({ description: "URL to fetch content from (optional — uses current tab if omitted)" })),
});

async function browserContent(input: Static<typeof contentParams>): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
	const client = await ensureConnected();

	let targetUrl = input.url ?? connectedUrl;

	// If URL provided, navigate first
	if (input.url && input.url !== connectedUrl) {
		await client.send("Page.navigate", { url: input.url });
		connectedUrl = input.url;
		await new Promise((r) => setTimeout(r, 3000)); // wait for content to load
	}

	// Get DOM
	const doc = (await client.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: { nodeId: number } };
	const htmlResult = (await client.send("DOM.getOuterHTML", {
		nodeId: doc.root.nodeId,
		pierce: true,
	})) as { outerHTML: string };

	const { title, content } = extractReadableContent(htmlResult.outerHTML, connectedUrl);

	const truncated = truncateHead(content, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
	let output = `URL: ${connectedUrl}\nTitle: ${title}\n\n${truncated.content}`;
	if (truncated.truncated) {
		output += `\n\n[Content truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;
	}

	return {
		content: [{ type: "text", text: output }],
		details: { url: connectedUrl, tabId: connectedTabId },
	};
}

// ── Extension entry ───────────────────────────────────────────────────
export default function browserExtension(pi: ExtensionAPI) {
	// /browser-connect command
	pi.registerCommand("browser-connect", {
		description: "Connect to Chrome at localhost:9222 for browser automation",
		handler: async (_args, ctx) => {
			try {
				await ensureConnected();
				if (ctx.hasUI) {
					ctx.ui.setStatus("browser", ctx.ui.theme.fg("success", `Browser: ${connectedUrl || "(unknown)"}`));
				}
				ctx.ui.notify("Browser connected", "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Browser connect failed: ${msg.split("\n")[0]}`, "error");
			}
		},
	});

	// /browser-disconnect command
	pi.registerCommand("browser-disconnect", {
		description: "Disconnect from the browser session",
		handler: async (_args, ctx) => {
			if (cdp) {
				cdp.disconnect();
				cdp = null;
				connectedTabId = "";
				connectedUrl = "";
			}
			ctx.ui.notify("Browser disconnected", "info");
		},
	});

	// ── browser_navigate ────────────────────────────────────────────
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description: "Navigate a browser tab to a URL. Requires Chrome running with --remote-debugging-port=9222.",
		parameters: navigateParams,
		async execute(_id, params) {
			return browserNavigate(params);
		},
		renderCall(args: Static<typeof navigateParams>, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_navigate ")) +
					theme.fg("accent", args.url ?? ""),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as unknown as { text?: string })?.text ?? "";
			const ok = !(result as unknown as { isError?: boolean }).isError;
			return new Text(ok ? theme.fg("success", "✓ ") + theme.fg("muted", text) : theme.fg("error", "✗ " + text), 0, 0);
		},
	});

	// ── browser_snapshot ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description: "Get a DOM snapshot of the current page. Use interactive=true to show only buttons, inputs, and links.",
		parameters: snapshotParams,
		async execute(_id, params) {
			return browserSnapshot(params);
		},
		renderCall(args: Static<typeof snapshotParams>, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_snapshot"));
			if (args.interactive) text += theme.fg("muted", " --interactive");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as { nodeCount?: number };
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${d?.nodeCount ?? "?"} nodes`),
				0, 0,
			);
		},
	});

	// ── browser_eval ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description: "Execute JavaScript in the current browser tab and return the result.",
		parameters: evalParams,
		async execute(_id, params) {
			return browserEval(params);
		},
		renderCall(args: Static<typeof evalParams>, theme) {
			const preview = args.code.length > 60 ? args.code.slice(0, 60) + "…" : args.code;
			return new Text(
				theme.fg("toolTitle", theme.bold("browser_eval ")) +
					theme.fg("accent", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as unknown as { text?: string })?.text ?? "";
			const lines = text.split("\n");
			const preview = lines[0].length > 80 ? lines[0].slice(0, 80) + "…" : lines[0];
			const ok = !(result as unknown as { isError?: boolean }).isError;
			return new Text(
				ok
					? theme.fg("success", "✓ ") + theme.fg("muted", preview)
					: theme.fg("error", "✗ " + preview),
				0, 0,
			);
		},
	});

	// ── browser_screenshot ───────────────────────────────────────────
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Capture a screenshot of the current browser viewport.",
		parameters: screenshotParams,
		async execute(_id, params) {
			return browserScreenshot(params);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_screenshot")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as unknown as { text?: string })?.text ?? "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
		},
	});

	// ── browser_cookies ──────────────────────────────────────────────
	pi.registerTool({
		name: "browser_cookies",
		label: "Browser Cookies",
		description: "List all cookies for the current browser page.",
		parameters: cookiesParams,
		async execute(_id, params) {
			return browserCookies(params);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_cookies")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as { count?: number };
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${d?.count ?? 0} cookies`),
				0, 0,
			);
		},
	});

	// ── browser_content ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_content",
		label: "Browser Content",
		description: "Extract readable text content from the current page (or a given URL) as markdown, stripping navigation and boilerplate.",
		parameters: contentParams,
		async execute(_id, params) {
			return browserContent(params);
		},
		renderCall(args: Static<typeof contentParams>, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_content"));
			if (args.url) text += ` ${theme.fg("accent", args.url)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as unknown as { text?: string })?.text ?? "";
			const firstLine = text.split("\n")[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstLine), 0, 0);
		},
	});
}
