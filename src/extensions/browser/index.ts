/**
 * Browser Extension - Native CDP browser automation, zero external deps.
 *
 * Tools:
 * - browser_navigate: Navigate to URL
 * - browser_snapshot: Get DOM accessibility snapshot
 * - browser_eval: Execute JavaScript with structured output
 * - browser_screenshot: Capture viewport screenshot
 * - browser_cookies: List cookies for current tab
 * - browser_content: Extract readable page content as markdown
 *
 * Commands:
 * - /browser-pick: Launch interactive element picker (user clicks elements)
 * - /browser-connect: Connect to existing Chrome at :9222 (auto-starts if absent)
 * - /browser-disconnect: Disconnect session
 * - /browser-start: Spawn Chrome with remote debugging (--profile for cookie sync)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead } from "@mariozechner/pi-coding-agent";
import { Text, Image as TUIImage } from "@mariozechner/pi-tui";
import { getCapabilities, renderImage, getPngDimensions } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger.js";
import { CdpClient, isBrowserAvailable, listTabs, spawnChrome, waitForChrome } from "./cdp.js";
import { extractReadableContent } from "./readability.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const log = createLogger("browser");

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const DEBUG_PORTS = [9222, 9225];

// ── CDP connection state ─────────────────────────────────────────────
let cdp: CdpClient | null = null;
let connectedTabId: string = "";
let connectedUrl: string = "";
let sessionCleanup: (() => void) | null = null;
let autoStartDone = false; // only auto-spawn once per session
let connectLock: Promise<CdpClient> | null = null; // prevents concurrent connections

async function getBrowserUrl(port: number): Promise<string> {
	const resp = await fetch(`http://localhost:${port}/json/version`);
	const data = (await resp.json()) as { webSocketDebuggerUrl: string };
	return data.webSocketDebuggerUrl;
}

/**
 * Connect to Chrome, auto-starting it if not already running.
 * Uses a lock to prevent concurrent connections.
 */
async function ensureConnected(opts: { autoStart?: boolean; useProfile?: boolean } = {}): Promise<CdpClient> {
	// Fast path: already connected
	if (cdp?.isConnected) return cdp;

	// Wait for any in-progress connection attempt
	if (connectLock) return connectLock;

	connectLock = doConnect(opts);
	try {
		return await connectLock;
	} finally {
		connectLock = null;
	}
}

async function doConnect(opts: { autoStart?: boolean; useProfile?: boolean }): Promise<CdpClient> {

	// Clean up old session
	if (cdp) { try { cdp.disconnect(); } catch { /* ok */ } cdp = null; }
	if (sessionCleanup) { sessionCleanup(); sessionCleanup = null; }

	let port: number | null = null;

	// Try existing Chrome
	for (const p of DEBUG_PORTS) {
		if (await isBrowserAvailable(p)) { port = p; break; }
	}

	// Auto-start if no Chrome found
	if (port === null) {
		if (opts.autoStart !== false) {
			port = await spawnChrome({ useProfile: opts.useProfile });
			await waitForChrome(port);
			autoStartDone = true;
		} else {
			throw new Error(
				"Chrome not reachable. Start it with:\n" +
				"  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n" +
				"Or use /browser-start --profile to launch with your cookies.",
			);
		}
	}

	// Always create a fresh tab when auto-starting Chrome
	// This ensures we get a page-level WebSocket with full CDP access
	const newResp = await fetch(`http://localhost:${port}/json/new?url=` + encodeURIComponent("about:blank"), { method: "PUT" });
	const newTab = (await newResp.json()) as { id: string; url: string; webSocketDebuggerUrl: string };
	connectedTabId = newTab.id;
	connectedUrl = newTab.url;
	cdp = new CdpClient();
	cdp.setTargetId(newTab.id);
	log.debug(`New tab created: ${newTab.webSocketDebuggerUrl}`);
	await cdp.connect(newTab.webSocketDebuggerUrl);

	// Wait for connection to stabilize (Chrome DevTools needs time to warm up)
	await new Promise((r) => setTimeout(r, 500));

	// Enable required domains
	await cdp.enableDomains();

	sessionCleanup = cdp.onEvent((method, params) => {
		if (method === "Page.navigated" && typeof params === "object" && params !== null) {
			const p = params as { frame?: { url?: string } };
			if (p.frame?.url) connectedUrl = p.frame.url;
		}
	});

	return cdp;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatEvalResult(value: unknown): string {
	if (value === undefined) return "(no return value)";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((v, i) => {
			if (typeof v === "object" && v !== null) return `${i}: ${JSON.stringify(v)}`;
			return `${i}: ${v}`;
		}).join("\n");
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
	}
	return String(value);
}

// ── Tool param types ─────────────────────────────────────────────────

const baseParams = Type.Object({
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

const navigateParams = Type.Object({
	...baseParams.properties,
	url: Type.String({ description: "URL to navigate to" }),
	new_tab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of current tab" })),
});

const snapshotParams = Type.Object({
	...baseParams.properties,
	interactive: Type.Optional(Type.Boolean({ description: "Show only interactive elements (buttons, inputs, links)" })),
	depth: Type.Optional(Type.Number({ description: "Max DOM depth (default: unlimited)" })),
});

const evalParams = Type.Object({
	...baseParams.properties,
	code: Type.String({ description: "JavaScript code to execute" }),
});

const screenshotParams = Type.Object({
	...baseParams.properties,
	format: Type.Optional(Type.String({ description: "Image format: png or jpeg (default: png)" })),
	quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100 (default: 80)" })),
});

const cookiesParams = Type.Object({});

const contentParams = Type.Object({
	...baseParams.properties,
	url: Type.Optional(Type.String({ description: "URL to fetch content from (optional - uses current tab if omitted)" })),
});

// ── Tool implementations ─────────────────────────────────────────────

/**
 * Send CDP command with retry and better error handling.
 */
async function sendWithRetry(client: CdpClient, method: string, params?: Record<string, unknown>, retries = 2): Promise<unknown> {
	let lastError: Error | null = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await client.send(method, params);
		} catch (err) {
			lastError = err as Error;
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
			}
		}
	}
	throw lastError;
}

async function browserNavigate(input: Static<typeof navigateParams>) {
	let client: CdpClient;
	try {
		client = await ensureConnected();
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Connection failed: ${errorMsg}` }],
			details: { url: connectedUrl, tabId: connectedTabId, error: errorMsg },
			isError: true
		};
	}

	if (input.new_tab) {
		const resp = await fetch("http://localhost:9222/json/new?url=" + encodeURIComponent(input.url), { method: "PUT" });
		const data = (await resp.json()) as { id: string; url: string };
		connectedTabId = data.id;
		connectedUrl = data.url;
		return { content: [{ type: "text" as const, text: `✓ Opened in new tab: ${input.url}\nTab ID: ${data.id}` }], details: { url: connectedUrl, tabId: connectedTabId } };
	}

	// Re-enable Page domain before navigating
	try {
		await client.send("Page.enable");
		await new Promise((r) => setTimeout(r, 200));
	} catch {
		// Ignore - might already be enabled
 /* Non-fatal: browser history unavailable */
	}

	// Navigate with retry
	try {
		await sendWithRetry(client, "Page.navigate", { url: input.url });
		connectedUrl = input.url;
		// Wait for navigation to complete (cap at 5 seconds for responsiveness)
		await new Promise((r) => setTimeout(r, Math.min(input.timeout ?? 5000, 5000)));
		return {
			content: [{ type: "text" as const, text: `✓ Navigated to: ${input.url}` }],
			details: { url: connectedUrl, tabId: connectedTabId, error: "" } as Record<string, unknown>,
			isError: false
		};
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Navigation failed: ${errorMsg}` }],
			details: { url: connectedUrl, tabId: connectedTabId, error: errorMsg },
			isError: true
		};
	}
}

async function browserSnapshot(input: Static<typeof snapshotParams>) {
	const client = await ensureConnected();

	const doc = (await client.send("DOM.getDocument", { depth: input.depth ?? -1, pierce: true })) as { root: { nodeId: number } };
	const tree = (await client.send("DOM.getFlattenedDocument", { depth: input.depth ?? -1, pierce: true })) as { nodes: Array<{ nodeName: string; value?: string; attributes?: string[]; childNodeCount: number }> };

	const lines: string[] = [];
	if (connectedUrl) lines.push(`URL: ${connectedUrl}`);
	const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);

	function getAttrs(attrs?: string[]): string {
		if (!attrs) return "";
		const parts: string[] = [];
		for (let i = 0; i < attrs.length - 1; i += 2) {
			const k = attrs[i], v = attrs[i + 1];
			if (["id", "class", "type", "placeholder", "name", "aria-label", "role"].includes(k)) parts.push(`${k}="${v}"`);
		}
		return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
	}

	let prevDepth = 0;
	for (const node of tree.nodes) {
		const depth = Math.min(node.childNodeCount > 0 ? prevDepth + 1 : prevDepth, input.depth ?? 10);
		if (node.nodeName === "#document") continue;
		if (node.nodeName === "#text") {
			const val = node.value?.trim();
			if (val) lines.push(`${"  ".repeat(depth)}"${val}"`);
		} else {
			const tag = node.nodeName.toLowerCase();
			const attrs = getAttrs(node.attributes);
			const interactive = interactiveTags.has(node.nodeName);
			const prefix = interactive ? "●" : "○";
			if (!input.interactive || interactive) lines.push(`${"  ".repeat(depth)}${prefix} <${tag}${attrs}>`);
		}
		prevDepth = depth;
	}

	const text = lines.join("\n");
	const truncated = truncateHead(text, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
	let output = truncated.content;
	if (truncated.truncated) output += `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;

	return { content: [{ type: "text" as const, text: output }], details: { url: connectedUrl, tabId: connectedTabId, nodeCount: tree.nodes.length } };
}

async function browserEval(input: Static<typeof evalParams>) {
	const client = await ensureConnected();

	const result = (await client.send("Runtime.evaluate", { expression: input.code, returnByValue: true })) as { result?: { type: string; value?: unknown; description?: string }; exceptionDetails?: unknown };

	if (result.exceptionDetails) {
		return { content: [{ type: "text" as const, text: `Error: ${JSON.stringify(result.exceptionDetails)}` }], isError: true, details: {} } as { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };
	}

	const output = formatEvalResult(result.result?.value ?? result.result?.description);
	const truncated = truncateHead(output, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
	return { content: [{ type: "text" as const, text: truncated.content }], details: { url: connectedUrl, tabId: connectedTabId } };
}

/**
 * Get the screenshots directory, creating it if needed.
 */
function getScreenshotsDir(): string {
	const dir = path.join(os.homedir(), ".pi", "screenshots");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Save base64 image data to a file and return the path.
 */
function saveScreenshotToFile(base64Data: string, format: string): string {
	const dir = getScreenshotsDir();
	const timestamp = Date.now();
	const filename = `screenshot_${timestamp}.${format}`;
	const filepath = path.join(dir, filename);
	const buffer = Buffer.from(base64Data, "base64");
	fs.writeFileSync(filepath, buffer);
	return filepath;
}

async function browserScreenshot(input: Static<typeof screenshotParams>) {
	const client = await ensureConnected();

	const result = (await client.send("Page.captureScreenshot", { format: input.format ?? "png", quality: input.quality ?? 80 })) as { data: string };
	const mediaType = input.format === "jpeg" ? "image/jpeg" : "image/png";
	const fileFormat = input.format ?? "png";

	// ── Save to file for analyze_image tool ─────────────────────────────────
	let filePath: string | undefined;
	try {
		filePath = saveScreenshotToFile(result.data, fileFormat);
	} catch (err) {
		log.error("Failed to save screenshot:", err);
	}

	// ── Terminal image rendering ─────────────────────────────────────────────
	// Render screenshot inline if terminal supports images (Kitty/iTerm2)
	const caps = getCapabilities();
	let terminalImage: string | undefined;

	if (caps.images && result.data) {
		const dims = input.format === "jpeg"
			? { widthPx: 1920, heightPx: 1080 } // Estimate for jpeg
			: getPngDimensions(result.data) ?? { widthPx: 1920, heightPx: 1080 };

		const rendered = renderImage(result.data, dims, { maxWidthCells: 80 });
		if (rendered) {
			terminalImage = rendered.sequence;
		}
	}

	// Build content with optional inline image
	const sizeKB = (result.data.length * 0.75 / 1024).toFixed(1);
	const filePathHint = filePath ? ` | Saved to: ${filePath}` : "";
	const baseText = `[Screenshot captured (${mediaType}, ${sizeKB}KB)${filePathHint}]`;
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
		{ type: "text" as const, text: baseText },
	];

	// Add image content if terminal supports it
	if (terminalImage) {
		content.push({ type: "image" as const, data: result.data, mimeType: mediaType });
	}

	return {
		content,
		details: {
			url: connectedUrl,
			tabId: connectedTabId,
			format: fileFormat,
			base64Length: result.data.length,
			terminalImage: !!terminalImage,
			protocol: caps.images ?? null,
			filePath,
		},
	};
}

async function browserCookies(_input: Static<typeof cookiesParams>) {
	const client = await ensureConnected();

	// Try Network.getAllCookies first (more reliable)
	let cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; session: boolean; expires?: number }>;
	try {
		const networkResult = (await client.send("Network.getAllCookies")) as { cookies: typeof cookies };
		cookies = networkResult.cookies;
	} catch {
		// Fallback to Page.getCookies with empty URLs (gets all)
		try {
			const pageResult = (await client.send("Page.getCookies", { urls: [] })) as { cookies: typeof cookies };
			cookies = pageResult.cookies;
		} catch {
			return { content: [{ type: "text" as const, text: "(could not retrieve cookies - CDP access limited)" }], details: { url: connectedUrl, tabId: connectedTabId, count: 0 }, isError: false };
		}
	}

	if (cookies.length === 0) return { content: [{ type: "text" as const, text: "(no cookies for this page)" }], details: { url: connectedUrl, tabId: connectedTabId, count: 0 } };


	const lines = cookies.map((c) => {
		const flags = [c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : "", c.session ? "Session" : ""].filter(Boolean).join(", ");
		return `${c.name}=${c.value}\n  domain: ${c.domain}  path: ${c.path}${flags ? `  [${flags}]` : ""}`;
	});

	return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details: { url: connectedUrl, tabId: connectedTabId, count: cookies.length } };
}

async function browserContent(input: Static<typeof contentParams>) {
	const client = await ensureConnected();

	if (input.url && input.url !== connectedUrl) {
		await client.send("Page.navigate", { url: input.url });
		connectedUrl = input.url;
		await new Promise((r) => setTimeout(r, 3000));
	}

	const doc = (await client.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: { nodeId: number } };
	const htmlResult = (await client.send("DOM.getOuterHTML", { nodeId: doc.root.nodeId, pierce: true })) as { outerHTML: string };

	const { title, content } = extractReadableContent(htmlResult.outerHTML, connectedUrl);
	const truncated = truncateHead(content, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
	let output = `URL: ${connectedUrl}\nTitle: ${title}\n\n${truncated.content}`;
	if (truncated.truncated) output += `\n\n[Content truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;

	return { content: [{ type: "text" as const, text: output }], details: { url: connectedUrl, tabId: connectedTabId } };
}

// ── browser_pick (interactive - for user command only) ─────────────

const PICK_SCRIPT = `
(function() {
  if (!window.__piPick) {
    window.__piPick = async function(message) {
      return new Promise(function(resolve) {
        var selections = [];
        var selectedElements = new Set();

        var overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";

        var highlight = document.createElement("div");
        highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s";
        overlay.appendChild(highlight);

        var banner = document.createElement("div");
        banner.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647;max-width:600px;text-align:center";
        banner.textContent = message + " (click to select, Cmd+click for multi, Enter to finish, ESC to cancel)";

        document.body.append(banner, overlay);

        function cleanup() {
          document.removeEventListener("mousemove", onMove, true);
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("keydown", onKey, true);
          overlay.remove();
          banner.remove();
          selectedElements.forEach(function(el) { el.style.outline = ""; });
        }

        function buildInfo(el) {
          var parents = [];
          var current = el.parentElement;
          while (current && current !== document.body) {
            var cls = current.className ? "." + current.className.trim().split(/\\s+/).join(".") : "";
            parents.push(current.tagName.toLowerCase() + (current.id ? "#" + current.id : "") + cls);
            current = current.parentElement;
          }
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            class: el.className || null,
            text: el.textContent ? el.textContent.trim().slice(0, 200) : null,
            cssSelector: (el.id ? "#" + el.id : (el.className ? el.tagName.toLowerCase() + "." + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase())),
            parents: parents.slice(0, 5).join(" > "),
            href: el.href || null,
            role: el.getAttribute("role") || null,
            ariaLabel: el.getAttribute("aria-label") || null
          };
        }

        function onMove(e) {
          var el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || overlay.contains(el) || banner.contains(el)) return;
          var r = el.getBoundingClientRect();
          highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:" + r.top + "px;left:" + r.left + "px;width:" + r.width + "px;height:" + r.height + "px";
        }

        function onClick(e) {
          if (banner.contains(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          var el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || overlay.contains(el) || banner.contains(el)) return;
          if (e.metaKey || e.ctrlKey) {
            if (!selectedElements.has(el)) {
              selectedElements.add(el);
              el.style.outline = "3px solid #10b981";
              selections.push(buildInfo(el));
              banner.textContent = message + " (" + selections.length + " selected, Cmd+click for multi, Enter to finish, ESC to cancel)";
            }
          } else {
            cleanup();
            resolve(selections.length > 0 ? selections : buildInfo(el));
          }
        }

        function onKey(e) {
          if (e.key === "Escape") { e.preventDefault(); cleanup(); resolve(null); }
          else if (e.key === "Enter" && selections.length > 0) { e.preventDefault(); cleanup(); resolve(selections); }
        }

        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
      });
    };
  }
  return window.__piPick;
})()
`;

async function runBrowserPick(message: string): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const client = await ensureConnected();

	// Inject pick helper
	await client.send("Runtime.evaluate", { expression: PICK_SCRIPT, returnByValue: true });

	// Launch picker in browser
	const result = (await client.send("Runtime.evaluate", {
		expression: `(window.__piPick || (${PICK_SCRIPT}))("${message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`,
		returnByValue: true,
		awaitPromise: true,
	})) as { result?: { value?: unknown } };

	const picked = result?.result?.value;
	if (picked === null || picked === undefined) {
		return { content: [{ type: "text" as const, text: "(cancelled)" }], details: {} };
	}

	const items = Array.isArray(picked) ? picked : [picked];
	const lines: string[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null) {
			lines.push(String(item));
			continue;
		}
		const o = item as Record<string, unknown>;
		if (o.tag) lines.push(`tag: ${o.tag}`);
		if (o.id) lines.push(`id: ${o.id}`);
		if (o.class) lines.push(`class: ${o.class}`);
		if (o.cssSelector) lines.push(`cssSelector: ${o.cssSelector}`);
		if (o.text) lines.push(`text: ${o.text}`);
		if (o.href) lines.push(`href: ${o.href}`);
		if (o.ariaLabel) lines.push(`ariaLabel: ${o.ariaLabel}`);
		if (o.parents) lines.push(`parents: ${o.parents}`);
	}

	return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { url: connectedUrl, tabId: connectedTabId, count: items.length } };
}

// ── Extension entry ─────────────────────────────────────────────────
export default function browserExtension(pi: ExtensionAPI) {

	// ── /browser-pick ────────────────────────────────────────────────
	pi.registerCommand("browser-pick", {
		description: "Launch interactive element picker - user clicks elements on the page. Returns CSS selectors and element info.",
		handler: async (args, ctx) => {
			const message = args[0] ?? "Click an element";
			try {
				const result = await runBrowserPick(message);
				const text = (result.content[0] as { text: string }).text;
				ctx.ui.notify("Element picked: " + text.split("\n")[0], "info");
			} catch (err) {
				ctx.ui.notify(`Pick failed: ${(err as Error).message.split("\n")[0]}`, "error");
			}
		},
	});

	// ── /browser-start ───────────────────────────────────────────────
	pi.registerCommand("browser-start", {
		description: "Spawn Chrome with remote debugging. Use --profile to sync your cookies and logins.",
		handler: async (args, ctx) => {
			const useProfile = args.includes("--profile");
			try {
				if (await isBrowserAvailable()) {
					ctx.ui.notify("Chrome already running on :9222", "info");
					return;
				}
				ctx.ui.notify("Starting Chrome…", "info");
				const port = await spawnChrome({ useProfile });
				await waitForChrome(port);
				// Reset connection state so next tool call uses the new instance
				if (cdp) { try { cdp.disconnect(); } catch { /* ok */ } cdp = null; }
				ctx.ui.notify("Chrome started on :9222" + (useProfile ? " (with your profile)" : ""), "info");
			} catch (err) {
				ctx.ui.notify(`Start failed: ${(err as Error).message.split("\n")[0]}`, "error");
			}
		},
	});

	// ── /browser-connect ─────────────────────────────────────────────
	pi.registerCommand("browser-connect", {
		description: "Connect to Chrome at :9222 (auto-starts if not running).",
		handler: async (_args, ctx) => {
			try {
				await ensureConnected();
				ctx.ui.notify(`Connected: ${connectedUrl || "(unknown)"}`, "info");
				if (ctx.hasUI) ctx.ui.setStatus("browser", ctx.ui.theme.fg("success", `Browser: ${connectedUrl || "(unknown)"}`));
			} catch (err) {
				ctx.ui.notify(`Connect failed: ${(err as Error).message.split("\n")[0]}`, "error");
			}
		},
	});

	// ── /browser-disconnect ────────────────────────────────────────────
	pi.registerCommand("browser-disconnect", {
		description: "Disconnect from the browser session.",
		handler: async (_args, ctx) => {
			if (cdp) { cdp.disconnect(); cdp = null; connectedTabId = ""; connectedUrl = ""; }
			ctx.ui.notify("Browser disconnected", "info");
		},
	});

	// ── Tool registrations ─────────────────────────────────────────────

	pi.registerTool({
		name: "browser_navigate", label: "Browser Navigate",
		description: "Navigate a browser tab to a URL. Auto-starts Chrome if not running.",
		parameters: navigateParams,
		async execute(_id, params) { return browserNavigate(params); },
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_navigate ")) + theme.fg("accent", args.url ?? ""), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const text = (result.content[0] as { text?: string })?.text ?? "";
			const ok = !(result as unknown as { isError?: boolean }).isError;
			return new Text(ok ? theme.fg("success", "✓ ") + theme.fg("muted", text) : theme.fg("error", "✗ " + text), 0, 0);
		},
	});

	pi.registerTool({
		name: "browser_snapshot", label: "Browser Snapshot",
		description: "Get a DOM snapshot of the current page. Use interactive=true to show only buttons, inputs, and links.",
		parameters: snapshotParams,
		async execute(_id, params) { return browserSnapshot(params); },
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("browser_snapshot"));
			if (args.interactive) t += theme.fg("muted", " --interactive");
			return new Text(t, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { nodeCount?: number };
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${d?.nodeCount ?? "?"} nodes`), 0, 0);
		},
	});

	pi.registerTool({
		name: "browser_eval", label: "Browser Eval",
		description: "Execute JavaScript in the current browser tab and return the result. Returns structured key-value output for objects and arrays.",
		parameters: evalParams,
		async execute(_id, params) { return browserEval(params); },
		renderCall(args, theme) {
			const preview = args.code.length > 60 ? args.code.slice(0, 60) + "…" : args.code;
			return new Text(theme.fg("toolTitle", theme.bold("browser_eval ")) + theme.fg("accent", preview), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const text = (result.content[0] as { text?: string })?.text ?? "";
			const lines = text.split("\n");
			const preview = lines[0].length > 80 ? lines[0].slice(0, 80) + "…" : lines[0];
			const ok = !(result as unknown as { isError?: boolean }).isError;
			return new Text(ok ? theme.fg("success", "✓ ") + theme.fg("muted", preview) : theme.fg("error", "✗ " + preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "browser_screenshot", label: "Browser Screenshot",
		description: "Capture a screenshot of the current browser viewport. Saves to ~/.pi/screenshots/ and returns the file path in result.details.filePath for use with analyze_image.",
		parameters: screenshotParams,
		async execute(_id, params) { return browserScreenshot(params); },
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("browser_screenshot")), 0, 0); },
		renderResult(result, _opts, theme) {
			const text = (result.content[0] as { text?: string })?.text ?? "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "browser_cookies", label: "Browser Cookies",
		description: "List all cookies for the current browser page.",
		parameters: cookiesParams,
		async execute(_id, params) { return browserCookies(params); },
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("browser_cookies")), 0, 0); },
		renderResult(result, _opts, theme) {
			const d = result.details as { count?: number };
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${d?.count ?? 0} cookies`), 0, 0);
		},
	});

	pi.registerTool({
		name: "browser_content", label: "Browser Content",
		description: "Extract readable text content from the current page (or a given URL) as markdown, stripping navigation and boilerplate.",
		parameters: contentParams,
		async execute(_id, params) { return browserContent(params); },
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("browser_content"));
			if (args.url) t += ` ${theme.fg("accent", args.url)}`;
			return new Text(t, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const text = (result.content[0] as { text?: string })?.text ?? "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
		},
	});
}
