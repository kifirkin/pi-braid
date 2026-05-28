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
import { Type, type Static } from "typebox";
const log = { info: console.log, debug: () => {}, warn: console.warn, error: console.error };
import { CdpClient, isBrowserAvailable, listTabs, spawnChrome, waitForChrome } from "./cdp.js";
import { extractReadableContent } from "./readability.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";


const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const DEBUG_PORTS = [9222, 9225];

// ── Tab Registry ──────────────────────────────────────────────────
/** Single tab entry in the browser session */
export interface TabEntry {
  id: string;
  url: string;
  title: string;
  client: CdpClient;
  active: boolean;
  createdAt: number;
}

const tabs = new Map<string, TabEntry>();
const sessionCleanups: (() => void)[] = [];
let autoStartDone = false; // only auto-spawn once per session
let connectLock: Promise<TabEntry> | null = null; // prevents concurrent connections

/** Get the currently active tab, or undefined if none */
export function getActiveTab(): TabEntry | undefined {
  for (const tab of tabs.values()) {
    if (tab.active) return tab;
  }
  return undefined;
}

/** Get a tab by ID, or undefined */
export function getTab(id: string): TabEntry | undefined {
  return tabs.get(id);
}

/** Set a tab as active, unset all others */
export function setActiveTab(id: string): void {
  for (const tab of tabs.values()) {
    tab.active = tab.id === id;
  }
}

/** Add a new tab to the registry */
export function addTab(entry: TabEntry): void {
  // Unset active on all existing tabs before adding new one
  for (const tab of tabs.values()) tab.active = false;
  tabs.set(entry.id, entry);
}

/** Remove a tab from the registry */
export function removeTab(id: string): TabEntry | undefined {
  const tab = tabs.get(id);
  if (tab) {
    try { tab.client.disconnect(); } catch { /* ok */ }
    tabs.delete(id);
    return tab;
  }
  return undefined;
}

/** Get all tabs as an array */
export function getAllTabs(): TabEntry[] {
  return Array.from(tabs.values());
}

/** Switch to a different tab, activating it */
export function switchToTab(id: string): TabEntry | undefined {
  const tab = tabs.get(id);
  if (!tab) return undefined;
  setActiveTab(id);
  return tab;
}

/** Close a tab and switch to another if needed */
export function closeTab(id: string): TabEntry | undefined {
  const tab = removeTab(id);
  if (!tab) return undefined;

  // If we closed the active tab, activate the most recent remaining tab
  if (tab.active && tabs.size > 0) {
    const remaining = Array.from(tabs.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (remaining.length > 0) setActiveTab(remaining[0].id);
  }
  return tab;
}

/** Open a URL in a new tab, connecting the CDP client */
async function openNewTab(port: number, url: string): Promise<TabEntry> {
  const resp = await fetch(
    `http://localhost:${port}/json/new?url=` + encodeURIComponent(url),
    { method: "PUT" },
  );
  const data = (await resp.json()) as {
    id: string;
    url: string;
    title?: string;
    webSocketDebuggerUrl: string;
  };

  const client = new CdpClient();
  client.setTargetId(data.id);
  await client.connect(data.webSocketDebuggerUrl);
  await client.enableDomains();

  const entry: TabEntry = {
    id: data.id,
    url: data.url,
    title: data.title ?? url,
    client,
    active: true,
    createdAt: Date.now(),
  };

  addTab(entry);
  return entry;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatEvalResult(value: unknown): string {
  if (value === undefined) return "(no return value)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v, i) => {
        if (typeof v === "object" && v !== null) return `${i}: ${JSON.stringify(v)}`;
        return `${i}: ${v}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
  }
  return String(value);
}

/** Ensure we have at least one tab, auto-starting Chrome if needed */
async function ensureTab(
  opts: { autoStart?: boolean; useProfile?: boolean } = {},
): Promise<TabEntry> {
  // Fast path: already have an active tab
  const active = getActiveTab();
  if (active && active.client.isConnected) return active;

  // Wait for any in-progress connection, then our own will start after
  if (connectLock) return connectLock;

  // Acquire connection lock — prevents concurrent ensureTab calls
  let resolveLock: ((entry: TabEntry) => void) | null = null;
  connectLock = new Promise<TabEntry>((r) => { resolveLock = r; });

  try {
    // Try existing Chrome
    let port: number | null = null;
    for (const p of DEBUG_PORTS) {
      if (await isBrowserAvailable(p)) { port = p; break; }
    }

    // Auto-start if no Chrome
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

    // Open a new tab
    const entry = await openNewTab(port, "about:blank");

    // Set up event tracking for this tab
    const cleanup = entry.client.onEvent((method, params) => {
      if (method === "Page.navigated" && typeof params === "object" && params !== null) {
        const p = params as { frame?: { url?: string } };
        if (p.frame?.url) {
          const tab = getTab(entry.id);
          if (tab) {
            tab.url = p.frame.url;
            // Update title from navigation event if available
            if (p.frame.title) tab.title = p.frame.title;
          }
        }
      }
    });
    sessionCleanups.push(cleanup);

    resolveLock?.(entry);
    return entry;
  } catch (err) {
    resolveLock?.(null as any);
    throw err;
  } finally {
    connectLock = null;
  }
}

// ── Tool param types ─────────────────────────────────────────────────

const baseTimeoutParam = Type.Optional(
  Type.Number({ description: "Timeout in milliseconds (default: 30000)" }),
);

const navigateParams = Type.Object({
  timeout: baseTimeoutParam,
  url: Type.String({ description: "URL to navigate to" }),
  tab_id: Type.Optional(
    Type.String({ description: "Tab ID to navigate in (defaults to active tab)" }),
  ),
});

const tabsListParams = Type.Object({});

const tabsSwitchParams = Type.Object({
  tab_id: Type.String({ description: "Tab ID to switch to" }),
});

const tabsCloseParams = Type.Object({
  tab_id: Type.String({ description: "Tab ID to close" }),
});

const tabsCreateParams = Type.Object({
  url: Type.String({ description: "URL to open in a new tab" }),
  switch_to: Type.Optional(
    Type.Boolean({ description: "Make the new tab active (default: true)" }),
  ),
});

const tabsWaitParams = Type.Object({
  tab_id: Type.String({ description: "Tab ID to wait on" }),
  url_pattern: Type.Optional(
    Type.String({ description: "URL pattern to match (substring match)" }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Max wait time in ms (default: 30000)" }),
  ),
});

const snapshotParams = Type.Object({
  timeout: baseTimeoutParam,
  interactive: Type.Optional(
    Type.Boolean({ description: "Show only interactive elements (buttons, inputs, links)" }),
  ),
  depth: Type.Optional(Type.Number({ description: "Max DOM depth (default: unlimited)" })),
});

const evalParams = Type.Object({
  timeout: baseTimeoutParam,
  code: Type.String({ description: "JavaScript code to execute" }),
});

const screenshotParams = Type.Object({
  timeout: baseTimeoutParam,
  format: Type.Optional(Type.String({ description: "Image format: png or jpeg (default: png)" })),
  quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100 (default: 80)" })),
});

const cookiesParams = Type.Object({});

const contentParams = Type.Object({
  timeout: baseTimeoutParam,
  url: Type.Optional(
    Type.String({
      description: "URL to fetch content from (optional - uses current tab if omitted)",
    }),
  ),
});

const uploadImageParams = Type.Object({
  filePath: Type.String({ description: "Absolute path to the image file to upload" }),
  selector: Type.Optional(
    Type.String({
      description:
        "CSS selector for the file input element (default: first input[type=file] on the page)",
    }),
  ),
  tab_id: Type.Optional(
    Type.String({ description: "Tab ID (defaults to active tab)" }),
  ),
  clickBtn: Type.Optional(
    Type.String({
      description:
        "Optional CSS selector for a button to click before uploading (e.g. '[aria-label=\"Add photos or video\"]' for X)",
    }),
  ),
});

const generateImageParams = Type.Object({
  code: Type.String({ description: "JavaScript code that draws on a canvas and returns a data URL" }),
  output: Type.Optional(
    Type.String({
      description: "Output file path (defaults to ~/.pi/screenshots/meme_TIMESTAMP.png)",
    }),
  ),
  tab_id: Type.Optional(
    Type.String({ description: "Tab ID (defaults to active tab)" }),
  ),
});

// ── Tool implementations ─────────────────────────────────────────────

/**
 * Send CDP command with retry and better error handling.
 */
async function sendWithRetry(
  client: CdpClient,
  method: string,
  params?: Record<string, unknown>,
  retries = 2,
): Promise<unknown> {
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
  let tab: TabEntry;
  try {
    tab = await ensureTab();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Connection failed: ${errorMsg}` }],
      details: { error: errorMsg },
      isError: true,
    };
  }

  // If specific tab_id requested, use that instead
  if (input.tab_id) {
    const targetTab = getTab(input.tab_id);
    if (!targetTab) {
      return {
        content: [{ type: "text" as const, text: `Tab not found: ${input.tab_id}` }],
        details: { tabId: input.tab_id },
        isError: true,
      };
    }
    tab = targetTab;
  }

  // Quick reachability pre-check for http/https URLs
  // Returns immediately if unreachable instead of waiting for full navigation timeout
  if (/^https?:\/\//i.test(input.url)) {
    try {
      const controller = new AbortController();
      const pingTimeout = setTimeout(() => controller.abort(), 5000);
      await fetch(input.url, { method: "HEAD", signal: controller.signal });
      clearTimeout(pingTimeout);
    } catch {
      return {
        content: [{ type: "text" as const, text: `✗ Unreachable: ${input.url} — server did not respond within 5s` }],
        details: { url: input.url, error: "unreachable" },
        isError: true,
      };
    }
  }

  const client = tab.client;

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
    const navResult = await sendWithRetry(client, "Page.navigate", { url: input.url });
    tab.url = input.url;
    // Wait briefly for initial page load, then return control to agent
    await new Promise((r) => setTimeout(r, Math.min(input.timeout ?? 2000, 2000)));
    const navInfo = navResult as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: `✓ Navigated to: ${input.url}` }],
      details: { url: tab.url, tabId: tab.id, navId: navInfo?.loaderId ?? null } as Record<string, unknown>,
      isError: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Navigation failed: ${errorMsg}` }],
      details: { url: tab.url, tabId: tab.id, error: errorMsg },
      isError: true,
    };
  }
}

async function browserSnapshot(input: Static<typeof snapshotParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  const doc = (await client.send("DOM.getDocument", {
    depth: input.depth ?? -1,
    pierce: true,
  })) as { root: { nodeId: number } };
  const tree = (await client.send("DOM.getFlattenedDocument", {
    depth: input.depth ?? -1,
    pierce: true,
  })) as {
    nodes: Array<{
      nodeName: string;
      value?: string;
      attributes?: string[];
      childNodeCount: number;
    }>;
  };

  const lines: string[] = [];
  if (tab.url) lines.push(`URL: ${tab.url}`);
  const interactiveTags = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "LABEL",
    "SUMMARY",
  ]);

  function getAttrs(attrs?: string[]): string {
    if (!attrs) return "";
    const parts: string[] = [];
    for (let i = 0; i < attrs.length - 1; i += 2) {
      const k = attrs[i],
        v = attrs[i + 1];
      if (["id", "class", "type", "placeholder", "name", "aria-label", "role"].includes(k))
        parts.push(`${k}="${v}"`);
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
      if (!input.interactive || interactive)
        lines.push(`${"  ".repeat(depth)}${prefix} <${tag}${attrs}>`);
    }
    prevDepth = depth;
  }

  const text = lines.join("\n");
  const truncated = truncateHead(text, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
  let output = truncated.content;
  if (truncated.truncated)
    output += `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;

  // Count element types for structured output
  const tagCounts: Record<string, number> = {};
  let interactiveCount = 0;
  let textNodeCount = 0;
  for (const node of tree.nodes) {
    if (node.nodeName === "#text") { textNodeCount++; continue; }
    const tag = node.nodeName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    if (interactiveTags.has(node.nodeName)) interactiveCount++;
  }

  return {
    content: [{ type: "text" as const, text: output }],
    details: { url: tab.url, tabId: tab.id, nodeCount: tree.nodes.length, interactiveCount, elementTypeCounts: tagCounts },
  };
}

async function browserEval(input: Static<typeof evalParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  const startTime = Date.now();
  const result = (await client.send("Runtime.evaluate", {
    expression: input.code,
    returnByValue: true,
  })) as {
    result?: { type: string; value?: unknown; description?: string };
    exceptionDetails?: unknown;
  };
  const execTimeMs = Date.now() - startTime;

  if (result.exceptionDetails) {
    return {
      content: [
        { type: "text" as const, text: `Error: ${JSON.stringify(result.exceptionDetails)}` },
      ],
      isError: true,
      details: { url: tab.url, tabId: tab.id, execTimeMs },
    } as {
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
      isError?: boolean;
    };
  }

  const output = formatEvalResult(result.result?.value ?? result.result?.description);
  const resultType = result.result?.type ?? "unknown";
  const truncated = truncateHead(output, {
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  return {
    content: [{ type: "text" as const, text: truncated.content }],
    details: { url: tab.url, tabId: tab.id, resultType, execTimeMs, truncated: truncated.truncated },
  };
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
  const tab = await ensureTab();
  const client = tab.client;

  const result = (await client.send("Page.captureScreenshot", {
    format: input.format ?? "png",
    quality: input.quality ?? 80,
  })) as { data: string };
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
    const dims =
      input.format === "jpeg"
        ? { widthPx: 1920, heightPx: 1080 } // Estimate for jpeg
        : (getPngDimensions(result.data) ?? { widthPx: 1920, heightPx: 1080 });

    const rendered = renderImage(result.data, dims, { maxWidthCells: 80 });
    if (rendered) {
      terminalImage = rendered.sequence;
    }
  }

  // Build content with optional inline image
  const sizeKB = ((result.data.length * 0.75) / 1024).toFixed(1);
  const filePathHint = filePath ? ` | Saved to: ${filePath}` : "";
  const baseText = `[Screenshot captured (${mediaType}, ${sizeKB}KB)${filePathHint}]`;
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text" as const, text: baseText }];

  // Add image content if terminal supports it
  if (terminalImage) {
    content.push({ type: "image" as const, data: result.data, mimeType: mediaType });
  }

  return {
    content,
    details: {
      url: tab.url,
      tabId: tab.id,
      format: fileFormat,
      base64Length: result.data.length,
      terminalImage: !!terminalImage,
      protocol: caps.images ?? null,
      filePath,
    },
  };
}

async function browserCookies(_input: Static<typeof cookiesParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  // Try Network.getAllCookies first (more reliable)
  let cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
    expires?: number;
  }>;
  try {
    const networkResult = (await client.send("Network.getAllCookies")) as {
      cookies: typeof cookies;
    };
    cookies = networkResult.cookies;
  } catch {
    // Fallback to Page.getCookies with empty URLs (gets all)
    try {
      const pageResult = (await client.send("Page.getCookies", { urls: [] })) as {
        cookies: typeof cookies;
      };
      cookies = pageResult.cookies;
    } catch {
      return {
        content: [
          { type: "text" as const, text: "ERROR: Could not retrieve cookies - CDP access limited" },
        ],
        details: { url: tab.url, tabId: tab.id, count: 0 },
        isError: true,
      };
    }
  }

  if (cookies.length === 0)
    return {
      content: [{ type: "text" as const, text: "(no cookies for this page)" }],
      details: { url: tab.url, tabId: tab.id, count: 0 },
    };

  const lines = cookies.map((c) => {
    const flags = [
      c.httpOnly ? "HttpOnly" : "",
      c.secure ? "Secure" : "",
      c.session ? "Session" : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `${c.name}=${c.value}\n  domain: ${c.domain}  path: ${c.path}${flags ? `  [${flags}]` : ""}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
    details: { url: tab.url, tabId: tab.id, count: cookies.length },
  };
}

async function browserContent(input: Static<typeof contentParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  if (input.url && input.url !== tab.url) {
    await client.send("Page.navigate", { url: input.url });
    tab.url = input.url;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const doc = (await client.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: { nodeId: number };
  };
  const htmlResult = (await client.send("DOM.getOuterHTML", {
    nodeId: doc.root.nodeId,
    pierce: true,
  })) as { outerHTML: string };

  const { title, content } = extractReadableContent(htmlResult.outerHTML, tab.url);
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const paragraphCount = content.split(/\n\n+/).filter(Boolean).length;
  const truncated = truncateHead(content, {
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  let output = `URL: ${tab.url}\nTitle: ${title}\n\n${truncated.content}`;
  if (truncated.truncated)
    output += `\n\n[Content truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;

  return {
    content: [{ type: "text" as const, text: output }],
    details: { url: tab.url, tabId: tab.id, wordCount, paragraphCount, truncated: truncated.truncated },
  };
}

// ── browser_upload_image ─────────────────────────────────────────────

async function browserUploadImage(input: Static<typeof uploadImageParams>) {
  const fullPath = path.resolve(input.filePath);
  if (!fs.existsSync(fullPath)) {
    return {
      content: [{ type: "text" as const, text: `File not found: ${fullPath}` }],
      details: { filePath: fullPath },
      isError: true,
    };
  }

  const tab = await ensureTab();
  if (input.tab_id) {
    const t = getTab(input.tab_id);
    if (t) {
      setActiveTab(input.tab_id);
    }
  }
  const client = tab.client;

  // Optional: click a button to open the file picker (e.g. X's "Add photo" button)
  if (input.clickBtn) {
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector(${JSON.stringify(input.clickBtn)});
        if (btn) { btn.click(); return 'clicked'; }
        return 'not found';
      })()`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Find the file input element using the provided selector or default
  const selector = input.selector || "input[type='file']";
  const findResult = (await client.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ found: false });
      // Get a CDP-stable reference via dataset
      const id = 'cdp_upload_' + Date.now();
      el.dataset.cdpUpload = id;
      return JSON.stringify({ found: true, id: id, tag: el.tagName, attr: el.getAttribute('accept') });
    })()`,
    returnByValue: true,
  })) as { result?: { value: string } };

  if (!findResult?.result?.value) {
    return {
      content: [{ type: "text" as const, text: "Evaluation returned no result" }],
      isError: true,
      details: {},
    };
  }

  const fi = JSON.parse(findResult.result.value);
  if (!fi.found) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No file input found with selector: ${selector}. Try a different selector or click a button first via clickBtn.`,
        },
      ],
      isError: true,
      details: { selector },
    };
  }

  // Use Runtime.evaluate to resolve the DOM node ID via CDP's internal node path
  // Alternative: use Runtime.evaluate with a WeakMap-based reference
  const nodeResult = (await client.send("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } };
  const docNodeId = nodeResult.root.nodeId;

  // Search the document for the element with our marker
  const searchResult = (await client.send("DOM.querySelector", {
    nodeId: docNodeId,
    selector: `[data-cdp-upload="${fi.id}"]`,
  })) as { nodeId: number };

  if (!searchResult.nodeId) {
    // Fallback: walk the DOM to find the node
    const markRes = (await client.send("Runtime.evaluate", {
      expression: `(function(){
        const el = document.querySelector('[data-cdp-upload="${fi.id}"]');
        if (!el) return null;
        // Use CDP internals to get the node ID
        return el.__cdp_node_id || null;
      })()`,
      returnByValue: true,
    })) as { result?: { value: unknown } };

    if (!markRes?.result?.value) {
      return {
        content: [{ type: "text" as const, text: "Found file input in DOM but could not resolve CDP node ID. The element may be in a shadow DOM or iframe." }],
        isError: true,
        details: { selector },
      };
    }
  }

  // Inject file via CDP at the protocol level — bypasses React state entirely
  try {
    await client.send("DOM.setFileInputFiles", {
      nodeId: searchResult.nodeId,
      files: [fullPath],
    });

    // Clean up the marker
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-cdp-upload="${fi.id}"]')?.removeAttribute('data-cdp-upload')`,
      returnByValue: true,
    });

    await new Promise((r) => setTimeout(r, 500));

    return {
      content: [{ type: "text" as const, text: `Uploaded ${path.basename(fullPath)} to ${selector}` }],
      details: { file: path.basename(fullPath), filePath: fullPath, selector },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Upload failed: ${errorMsg}` }],
      details: { error: errorMsg, selector, filePath: fullPath },
      isError: true,
    };
  }
}

// ── browser_generate_image ───────────────────────────────────────────

async function browserGenerateImage(input: Static<typeof generateImageParams>) {
  const tab = await ensureTab();
  if (input.tab_id) {
    const t = getTab(input.tab_id);
    if (t) {
      setActiveTab(input.tab_id);
      tab.client = t.client;
    }
  }

  const client = tab.client;

  // Execute the user's canvas code, expect a data URL back
  const evalCode = `
    (async () => {
      try {
        ${input.code}
        // After user code runs, look for a canvas and return its data URL
        const canvases = document.querySelectorAll('canvas');
        if (canvases.length > 0) {
          const c = canvases[canvases.length - 1];
          return JSON.stringify({ ok: true, dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height });
        }
        const imgs = document.querySelectorAll('img[src*="data:image/png"]');
        if (imgs.length > 0) {
          return JSON.stringify({ ok: true, dataUrl: imgs[imgs.length - 1].src, width: 0, height: 0 });
        }
        return JSON.stringify({ ok: false, error: 'No canvas or data URL image found after execution' });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    })()
  `;

  const result = (await client.send("Runtime.evaluate", {
    expression: evalCode,
    returnByValue: true,
    awaitPromise: true,
    timeout: 30000,
  })) as { result?: { value: string } };

  if (!result?.result?.value) {
    return {
      content: [{ type: "text" as const, text: "No result from evaluation" }],
      isError: true,
      details: {},
    };
  }

  const parsed = JSON.parse(result.result.value);
  if (!parsed.ok) {
    return {
      content: [{ type: "text" as const, text: `Image generation failed: ${parsed.error}` }],
      isError: true,
      details: {},
    };
  }

  // Decode base64 data URL and save to file
  const matches = parsed.dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!matches) {
    return {
      content: [{ type: "text" as const, text: "Invalid data URL format" }],
      isError: true,
      details: {},
    };
  }

  const format = matches[1] === "jpeg" ? "jpg" : "png";
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, "base64");

  let outputPath = input.output;
  if (!outputPath) {
    const screenshotsDir = path.join(os.homedir(), ".pi", "screenshots");
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const timestamp = Date.now();
    outputPath = path.join(screenshotsDir, `meme_${timestamp}.${format}`);
  }

  fs.writeFileSync(outputPath, buffer);

  return {
    content: [{ type: "text" as const, text: `Image saved to ${outputPath}` }],
    details: { filePath: outputPath, width: parsed.width, height: parsed.height, format },
  };
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

async function runBrowserPick(
  message: string,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const tab = await ensureTab();
  const client = tab.client;

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

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { url: tab.url, tabId: tab.id, count: items.length },
  };
}

// ── Extension entry ─────────────────────────────────────────────────
export default function browserExtension(pi: ExtensionAPI) {
  // ── /browser-pick ────────────────────────────────────────────────
  pi.registerCommand("browser-pick", {
    description:
      "Launch interactive element picker - user clicks elements on the page. Returns CSS selectors and element info.",
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
    description:
      "Spawn Chrome with remote debugging. Use --profile to sync your cookies and logins.",
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
        for (const tab of getAllTabs()) {
          try { tab.client.disconnect(); } catch { /* ok */ }
        }
        tabs.clear();
        ctx.ui.notify(
          "Chrome started on :9222" + (useProfile ? " (with your profile)" : ""),
          "info",
        );
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
        const tab = await ensureTab();
        ctx.ui.notify(`Connected: ${tab.url || "(unknown)"}`, "info");
        if (ctx.hasUI)
          ctx.ui.setStatus(
            "browser",
            ctx.ui.theme.fg("success", `Browser: ${tab.url || "(unknown)"}`),
          );
      } catch (err) {
        ctx.ui.notify(`Connect failed: ${(err as Error).message.split("\n")[0]}`, "error");
      }
    },
  });

  // ── /browser-tabs ─────────────────────────────────────────────────
  pi.registerCommand("browser-tabs", {
    description: "List all browser tabs. Usage: /browser-tabs",
    handler: async (_args, ctx) => {
      try {
        await ensureTab();
        const allTabs = getAllTabs();
        if (allTabs.length === 0) {
          ctx.ui.notify("No tabs open", "info");
          return;
        }
        const lines = allTabs.map((t, i) =>
          `${t.active ? "●" : "○"} [${i + 1}] ${t.title || t.url} (${t.id})`,
        );
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Tab list failed: ${(err as Error).message.split("\n")[0]}`, "error");
      }
    },
  });

  // ── /browser-disconnect ────────────────────────────────────────────
  pi.registerCommand("browser-disconnect", {
    description: "Disconnect from the browser session.",
    handler: async (_args, ctx) => {
      for (const tab of getAllTabs()) {
        try { tab.client.disconnect(); } catch { /* ok */ }
      }
      tabs.clear();
      for (const cleanup of sessionCleanups) {
        try { cleanup(); } catch { /* ok */ }
      }
      sessionCleanups.length = 0;
      ctx.ui.notify("Browser disconnected", "info");
    },
  });

  // ── session_shutdown cleanup ──────────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const tab of getAllTabs()) {
      try { tab.client.disconnect(); } catch { /* ok */ }
    }
    tabs.clear();
    for (const cleanup of sessionCleanups) {
      try { cleanup(); } catch { /* ok */ }
    }
    sessionCleanups.length = 0;
    autoStartDone = false;
  });

  // ── Tool registrations ─────────────────────────────────────────────

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate a browser tab to a URL. Auto-starts Chrome if not running.",
    parameters: navigateParams,
    async execute(_id, params) {
      return browserNavigate(params);
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_navigate ")) + theme.fg("accent", args.url ?? ""),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const ok = !(result as unknown as { isError?: boolean }).isError;
      return new Text(
        ok ? theme.fg("success", "✓ ") + theme.fg("muted", text) : theme.fg("error", "✗ " + text),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Get a DOM snapshot of the current page. Use interactive=true to show only buttons, inputs, and links.",
    parameters: snapshotParams,
    async execute(_id, params) {
      return browserSnapshot(params);
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("browser_snapshot"));
      if (args.interactive) t += theme.fg("muted", " --interactive");
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as { nodeCount?: number };
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", `${d?.nodeCount ?? "?"} nodes`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Browser Eval",
    description:
      "Execute JavaScript in the current browser tab and return the result. Returns structured key-value output for objects and arrays.",
    parameters: evalParams,
    async execute(_id, params) {
      return browserEval(params);
    },
    renderCall(args, theme) {
      const preview = args.code.length > 60 ? args.code.slice(0, 60) + "…" : args.code;
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_eval ")) + theme.fg("accent", preview),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const lines = text.split("\n");
      const preview = lines[0].length > 80 ? lines[0].slice(0, 80) + "…" : lines[0];
      const ok = !(result as unknown as { isError?: boolean }).isError;
      return new Text(
        ok
          ? theme.fg("success", "✓ ") + theme.fg("muted", preview)
          : theme.fg("error", "✗ " + preview),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture a screenshot of the current browser viewport. Saves to ~/.pi/screenshots/ and returns the file path in result.details.filePath for use with analyze_image.",
    parameters: screenshotParams,
    async execute(_id, params) {
      return browserScreenshot(params);
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("browser_screenshot")), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
    },
  });

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
    renderResult(result, _opts, theme) {
      const d = result.details as { count?: number };
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", `${d?.count ?? 0} cookies`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "browser_content",
    label: "Browser Content",
    description:
      "Extract readable text content from the current page (or a given URL) as markdown, stripping navigation and boilerplate.",
    parameters: contentParams,
    async execute(_id, params) {
      return browserContent(params);
    },
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

  // ── Tab management tools ──────────────────────────────────────────

  pi.registerTool({
    name: "browser_tabs_list",
    label: "Browser Tabs List",
    description: "List all open browser tabs with their IDs, URLs, and active status.",
    parameters: tabsListParams,
    async execute(_id, _params) {
      const allTabs = getAllTabs();
      const lines = allTabs.map((t, i) => {
        const status = t.active ? " [active]" : "";
        const title = t.title ? ` — ${t.title}` : "";
        return `[${i + 1}] ${t.id}${status}\n    URL: ${t.url}${title}`;
      });
      if (lines.length === 0) {
        return { content: [{ type: "text", text: "(no tabs open)" }], details: { count: 0 } };
      }
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { tabs: allTabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })) },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("browser_tabs_list")), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as { tabs?: unknown[] };
      const count = d?.tabs?.length ?? 0;
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${count} tab(s)`), 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_tabs_switch",
    label: "Browser Tabs Switch",
    description: "Switch browser focus to a specific tab by ID. Subsequent tools operate on the switched tab.",
    parameters: tabsSwitchParams,
    async execute(_id, params) {
      const tab = getTab(params.tab_id);
      if (!tab) {
        return { content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }], isError: true, details: {} };
      }
      switchToTab(params.tab_id);
      return {
        content: [{ type: "text", text: `Switched to tab ${params.tab_id}: ${tab.url}` }],
        details: { tabId: tab.id, url: tab.url },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_tabs_switch ")) + theme.fg("accent", args.tab_id),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const ok = !(result as unknown as { isError?: boolean }).isError;
      return new Text(ok ? theme.fg("success", "✓ ") + theme.fg("muted", text) : theme.fg("error", "✗ " + text), 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_tabs_close",
    label: "Browser Tabs Close",
    description: "Close a browser tab by ID. If closing the active tab, switches to the most recent remaining tab.",
    parameters: tabsCloseParams,
    async execute(_id, params) {
      const tab = closeTab(params.tab_id);
      if (!tab) {
        return { content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }], isError: true, details: {} };
      }
      const active = getActiveTab();
      return {
        content: [{ type: "text", text: `Closed tab ${params.tab_id}${active ? `, switched to ${active.id}` : ""}` }],
        details: { closedTabId: params.tab_id, activeTabId: active?.id },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_tabs_close ")) + theme.fg("accent", args.tab_id),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_tabs_create",
    label: "Browser Tabs Create",
    description: "Open a URL in a new browser tab. Optionally switches to it (default: true).",
    parameters: tabsCreateParams,
    async execute(_id, params) {
      // Ensure Chrome is running
      let port: number | null = null;
      for (const p of DEBUG_PORTS) {
        if (await isBrowserAvailable(p)) { port = p; break; }
      }
      if (!port) {
        port = await spawnChrome({});
        await waitForChrome(port);
      }
      const entry = await openNewTab(port, params.url);
      if (params.switch_to !== false) {
        setActiveTab(entry.id);
      } else {
        entry.active = false;
      }
      return {
        content: [{ type: "text", text: `Opened: ${params.url}\nTab ID: ${entry.id}` }],
        details: { tabId: entry.id, url: entry.url, active: entry.active },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_tabs_create ")) + theme.fg("accent", args.url),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
    },
  });

  pi.registerTool({
    name: "browser_tabs_wait",
    label: "Browser Tabs Wait",
    description: "Wait for a browser tab to finish loading or match a URL pattern.",
    parameters: tabsWaitParams,
    async execute(_id, params) {
      const tab = getTab(params.tab_id);
      if (!tab) {
        return { content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }], isError: true, details: {} };
      }
      const timeoutMs = params.timeout ?? 30000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (params.url_pattern && tab.url.includes(params.url_pattern)) {
          return {
            content: [{ type: "text", text: `Tab ${params.tab_id} reached: ${tab.url}` }],
            details: { tabId: tab.id, url: tab.url },
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        content: [{ type: "text", text: `Timeout waiting for tab ${params.tab_id} (${params.url_pattern ? `pattern: ${params.url_pattern}` : "load"})` }],
        details: { tabId: tab.id, url: tab.url, timedOut: true },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_tabs_wait ")) + theme.fg("accent", args.tab_id),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const ok = !(result as unknown as { timedOut?: boolean }).timedOut;
      return new Text(ok ? theme.fg("success", "✓ ") + theme.fg("muted", text) : theme.fg("warning", "⏱ " + text), 0, 0);
    },
  });

  // ── Image pipeline tools ─────────────────────────────────────────

  pi.registerTool({
    name: "browser_upload_image",
    label: "Browser Upload Image",
    description:
      "Upload a local image file to any page's file input via CDP. Finds input[type=file] by CSS selector or default. Optionally clicks a button first (e.g. X's 'Add photo'). Bypasses React state.",
    parameters: uploadImageParams,
    async execute(_id, params) {
      return browserUploadImage(params);
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_upload_image ")) +
          theme.fg("accent", args.filePath ?? ""),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const err = (result as unknown as { isError?: boolean }).isError;
      return new Text(
        err
          ? theme.fg("error", "✗ ") + theme.fg("muted", text)
          : theme.fg("success", "✓ ") + theme.fg("muted", text),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "browser_generate_image",
    label: "Browser Generate Image",
    description:
      "Run JavaScript in the browser to draw on a canvas, extract the result as PNG, and save to a file on disk. Use with browser_upload_image for zero-clipboard image posting.",
    parameters: generateImageParams,
    async execute(_id, params) {
      return browserGenerateImage(params);
    },
    renderCall(args, theme) {
      const preview = args.code.length > 60 ? args.code.slice(0, 60) + "…" : args.code;
      return new Text(
        theme.fg("toolTitle", theme.bold("browser_generate_image ")) +
          theme.fg("accent", preview),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const text = (result.content[0] as { text?: string })?.text ?? "";
      const err = (result as unknown as { isError?: boolean }).isError;
      return new Text(
        err
          ? theme.fg("error", "✗ ") + theme.fg("muted", text)
          : theme.fg("success", "✓ ") + theme.fg("muted", text),
        0,
        0,
      );
    },
  });
}

// ── Cleanup on disconnect or shutdown ────────────────────────────────