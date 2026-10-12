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
 * - /browser-connect: Connect to existing Chrome at :9222 (auto-starts if absent)
 * - /browser-disconnect: Disconnect session
 * - /browser-start: Spawn Chrome with remote debugging (--profile for cookie sync)
 */

import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { createLogger } from "../logger.js";
import { browserScreenshotsDir } from "../state-paths.js";
const log = createLogger("browser");
import {
  CdpClient,
  isBrowserAvailable,
  spawnChrome,
  waitForChrome,
} from "./cdp.js";
import { extractReadableContent } from "./readability.js";
import {
  computeCapturePlan,
  DEFAULT_JPEG_QUALITY,
  MAX_SCREENSHOT_DIM,
  type ViewportMetrics,
} from "./capture-plan.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * braid's tool renderers read an extra `isError` flag to color error results
 * (pi-core signals tool errors through thrown exceptions, so the flag is
 * render-only and absent from the SDK's AgentToolResult type). Declaring it
 * here keeps the flag typed instead of silencing the whole file.
 */
type BrowserToolResult = AgentToolResult<any> & { isError?: boolean };
const MAX_OUTPUT_LINES = 2000;
const DEBUG_PORTS = [9222, 9225];

// Settings

interface BrowserSettings {
  advanced: boolean;
}

function readBrowserSettings(): BrowserSettings {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let parsed: { braid?: { contrib?: { browserAdvanced?: unknown } } } = {};
  try {
    if (fs.existsSync(settingsPath)) {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    // Unreadable/missing settings file — the advanced-tools default (OFF)
    // below is the safe fallback.
  }
  // Default: advanced OFF (privacy + context budget — opt-in for the heavy tools)
  return {
    advanced: parsed.braid?.contrib?.browserAdvanced === true,
  };
}

// TUI renderer factory

/**
 * Generalized TUI renderers for browser tools. Replaces 26 hand-rolled
 * renderCall/renderResult functions with a single factory. The default
 * rules cover the common case (first line of content, ✓/✗, color from
 * details) and tool-specific counts (cookies, tabs) are handled by
 * inspecting result.details.
 */
function makeBrowserRenderer(
  toolName: string,
  options: { successDetailKey?: string; successUnit?: string } = {},
) {
  return {
    renderCall(args: unknown, theme: any) {
      const a = (args ?? {}) as Record<string, unknown>;
      let preview = "";
      if (typeof a.url === "string") preview = " " + a.url;
      else if (typeof a.code === "string") {
        preview =
          " " + (a.code.length > 60 ? a.code.slice(0, 60) + "…" : a.code);
      } else if (typeof a.tab_id === "string") preview = " " + a.tab_id;
      else if (typeof a.filePath === "string") preview = " " + a.filePath;
      else if (a.interactive === true) preview = " --interactive";
      return new Text(
        theme.fg("toolTitle", theme.bold(toolName)) +
          theme.fg("accent", preview),
        0,
        0,
      );
    },
    renderResult(result: any, _opts: any, theme: any) {
      const details = (result?.details ?? {}) as Record<string, unknown>;
      // Tool-specific: a number from details we want to display prominently
      if (
        options.successDetailKey &&
        typeof details[options.successDetailKey] === "number" &&
        (details[options.successDetailKey] as number) >= 0
      ) {
        const n = details[options.successDetailKey] as number;
        const unit = options.successUnit ?? "";
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("muted", `${n} ${unit}`.trim()),
          0,
          0,
        );
      }
      // Default: first line of content, colored by error/timedOut flag
      const text =
        (result?.content?.[0] as { text?: string } | undefined)?.text ?? "";
      const firstLine = text.split("\n")[0] ?? "";
      const preview =
        firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
      const isError = (result as { isError?: boolean }).isError === true;
      const timedOut =
        (result as { details?: { timedOut?: boolean } }).details?.timedOut ===
        true;
      if (timedOut) {
        return new Text(
          theme.fg("warning", "⏱ ") + theme.fg("muted", preview),
          0,
          0,
        );
      }
      if (isError) {
        return new Text(
          theme.fg("error", "✗ ") + theme.fg("muted", preview),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", preview),
        0,
        0,
      );
    },
  };
}

// Tab Registry
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
    try {
      tab.client.disconnect();
    } catch {
      // Best-effort cleanup — socket may already be closed.
    }
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
    const remaining = Array.from(tabs.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
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

// Helpers

function formatEvalResult(value: unknown): string {
  if (value === undefined) return "(no return value)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v, i) => {
        if (typeof v === "object" && v !== null)
          return `${i}: ${JSON.stringify(v)}`;
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

  if (connectLock) return connectLock;

  // Acquire connection lock — prevents concurrent ensureTab calls. The
  // definite-assignment assertion is safe: a Promise executor runs
  // synchronously, so `resolveLock` is bound before this line returns.
  let resolveLock!: (entry: TabEntry) => void;
  connectLock = new Promise<TabEntry>((r) => {
    resolveLock = r;
  });

  try {
    // Reuse a running instance before spawning a new one.
    let port: number | null = null;
    for (const p of DEBUG_PORTS) {
      if (await isBrowserAvailable(p)) {
        port = p;
        break;
      }
    }

    // Auto-start if no Chrome
    if (port === null) {
      if (opts.autoStart !== false) {
        port = await spawnChrome({ useProfile: opts.useProfile });
        await waitForChrome(port);
      } else {
        throw new Error(
          "Chrome not reachable. Start it with:\n" +
            "  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n" +
            "Or use /browser-start --profile to launch with your cookies.",
        );
      }
    }

    const entry = await openNewTab(port, "about:blank");

    const cleanup = entry.client.onEvent((method, params) => {
      if (
        method === "Page.navigated" &&
        typeof params === "object" &&
        params !== null
      ) {
        const p = params as { frame?: { url?: string; title?: string } };
        if (p.frame?.url) {
          const tab = getTab(entry.id);
          if (tab) {
            tab.url = p.frame.url;
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

// Tool param types

const baseTimeoutParam = Type.Optional(
  Type.Number({ description: "Timeout in milliseconds (default: 30000)" }),
);

const navigateParams = Type.Object({
  timeout: baseTimeoutParam,
  url: Type.String({ description: "URL to navigate to" }),
  tab_id: Type.Optional(
    Type.String({
      description: "Tab ID to navigate in (defaults to active tab)",
    }),
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
    Type.Boolean({
      description: "Show only interactive elements (buttons, inputs, links)",
    }),
  ),
  depth: Type.Optional(
    Type.Number({ description: "Max DOM depth (default: unlimited)" }),
  ),
});

const evalParams = Type.Object({
  timeout: baseTimeoutParam,
  code: Type.String({ description: "JavaScript code to execute" }),
});

const screenshotParams = Type.Object({
  timeout: baseTimeoutParam,
  format: Type.Optional(
    Type.String({ description: "Image format: jpeg (default) or png" }),
  ),
  quality: Type.Optional(
    Type.Number({ description: "JPEG quality 0-100 (default: 75)" }),
  ),
});

const cookiesParams = Type.Object({});

const contentParams = Type.Object({
  timeout: baseTimeoutParam,
  url: Type.Optional(
    Type.String({
      description:
        "URL to fetch content from (optional - uses current tab if omitted)",
    }),
  ),
});

// Tool implementations

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
      content: [
        { type: "text" as const, text: `Connection failed: ${errorMsg}` },
      ],
      details: { error: errorMsg },
      isError: true,
    };
  }

  // If specific tab_id requested, use that instead
  if (input.tab_id) {
    const targetTab = getTab(input.tab_id);
    if (!targetTab) {
      return {
        content: [
          { type: "text" as const, text: `Tab not found: ${input.tab_id}` },
        ],
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
      const pingTimeout = setTimeout(() => controller.abort(), 10000);
      await fetch(input.url, { method: "HEAD", signal: controller.signal });
      clearTimeout(pingTimeout);
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: `✗ Unreachable: ${input.url} — server did not respond within 10s`,
          },
        ],
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
    // Already enabled or transient CDP hiccup — navigation proceeds
    // regardless; a stale Page domain self-corrects on the next send.
  }

  // Navigate with retry
  try {
    const navResult = await sendWithRetry(client, "Page.navigate", {
      url: input.url,
    });
    tab.url = input.url;
    // Wait briefly for initial page load, then return control to agent
    await new Promise((r) =>
      setTimeout(r, Math.min(input.timeout ?? 2000, 2000)),
    );
    const navInfo = navResult as Record<string, unknown>;
    return {
      content: [
        { type: "text" as const, text: `✓ Navigated to: ${input.url}` },
      ],
      details: {
        url: tab.url,
        tabId: tab.id,
        navId: navInfo?.loaderId ?? null,
      } as Record<string, unknown>,
      isError: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text" as const, text: `Navigation failed: ${errorMsg}` },
      ],
      details: { url: tab.url, tabId: tab.id, error: errorMsg },
      isError: true,
    };
  }
}

async function browserSnapshot(input: Static<typeof snapshotParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  await client.send("DOM.getDocument", {
    depth: input.depth ?? -1,
    pierce: true,
  });
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
      if (
        [
          "id",
          "class",
          "type",
          "placeholder",
          "name",
          "aria-label",
          "role",
        ].includes(k)
      )
        parts.push(`${k}="${v}"`);
    }
    return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
  }

  let prevDepth = 0;
  for (const node of tree.nodes) {
    const depth = Math.min(
      node.childNodeCount > 0 ? prevDepth + 1 : prevDepth,
      input.depth ?? 10,
    );
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
  const truncated = truncateHead(text, {
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  let output = truncated.content;
  if (truncated.truncated)
    output += `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines]`;

  const tagCounts: Record<string, number> = {};
  let interactiveCount = 0;
  for (const node of tree.nodes) {
    if (node.nodeName === "#text") {
      continue;
    }
    const tag = node.nodeName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    if (interactiveTags.has(node.nodeName)) interactiveCount++;
  }

  return {
    content: [{ type: "text" as const, text: output }],
    details: {
      url: tab.url,
      tabId: tab.id,
      nodeCount: tree.nodes.length,
      interactiveCount,
      elementTypeCounts: tagCounts,
    },
  };
}

async function browserEval(input: Static<typeof evalParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  const startTime = Date.now();
  // Wrap in block scope to isolate variable declarations between calls — prevents
  // "Identifier 'ta' has already been declared" errors from const/let reuse
  // without affecting completion value or top-level await
  const result = (await client.send("Runtime.evaluate", {
    expression: `{\n${input.code}\n}`,
    returnByValue: true,
  })) as {
    result?: { type: string; value?: unknown; description?: string };
    exceptionDetails?: unknown;
  };
  const execTimeMs = Date.now() - startTime;

  if (result.exceptionDetails) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${JSON.stringify(result.exceptionDetails)}`,
        },
      ],
      isError: true,
      details: { url: tab.url, tabId: tab.id, execTimeMs },
    } as {
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
      isError?: boolean;
    };
  }

  const output = formatEvalResult(
    result.result?.value ?? result.result?.description,
  );
  const resultType = result.result?.type ?? "unknown";
  const truncated = truncateHead(output, {
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  return {
    content: [{ type: "text" as const, text: truncated.content }],
    details: {
      url: tab.url,
      tabId: tab.id,
      resultType,
      execTimeMs,
      truncated: truncated.truncated,
    },
  };
}

/**
 * Get the screenshots directory, creating it if needed.
 */
function getScreenshotsDir(): string {
  const dir = browserScreenshotsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save base64 image data to a file and return the path + decoded byte size.
 */
function saveScreenshotToFile(
  base64Data: string,
  format: string,
): { filePath: string; bytes: number } {
  const dir = getScreenshotsDir();
  const timestamp = Date.now();
  const filename = `screenshot_${timestamp}.${format}`;
  const filepath = path.join(dir, filename);
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(filepath, buffer);
  return { filePath: filepath, bytes: buffer.byteLength };
}

/**
 * Read viewport metrics (CSS px + DPR + scroll offsets) from the page.
 * Falls back to sane defaults if evaluation fails (e.g. about:blank races).
 */
async function readViewportMetrics(
  client: CdpClient,
): Promise<ViewportMetrics> {
  const fallback: ViewportMetrics = {
    width: 1280,
    height: 720,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
  };
  try {
    const res = (await client.send("Runtime.evaluate", {
      expression:
        "JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY })",
      returnByValue: true,
    })) as { result?: { value?: string } };
    if (typeof res.result?.value !== "string") return fallback;
    const parsed = JSON.parse(res.result.value) as Partial<ViewportMetrics>;
    return {
      width: typeof parsed.width === "number" ? parsed.width : fallback.width,
      height:
        typeof parsed.height === "number" ? parsed.height : fallback.height,
      dpr: typeof parsed.dpr === "number" ? parsed.dpr : fallback.dpr,
      scrollX:
        typeof parsed.scrollX === "number" ? parsed.scrollX : fallback.scrollX,
      scrollY:
        typeof parsed.scrollY === "number" ? parsed.scrollY : fallback.scrollY,
    };
  } catch {
    return fallback;
  }
}

async function browserScreenshot(input: Static<typeof screenshotParams>) {
  const tab = await ensureTab();
  const client = tab.client;

  // Bounded, DPR-neutralized capture. Defaults target the ~100-300KB
  // size class: jpeg quality 75, deviceScaleFactor 1, long edge ≤ 1440px.
  const format = input.format === "png" ? "png" : "jpeg";
  const quality =
    typeof input.quality === "number"
      ? Math.min(100, Math.max(0, Math.round(input.quality)))
      : DEFAULT_JPEG_QUALITY;

  const metrics = await readViewportMetrics(client);

  // Neutralize device pixel ratio (Retina 2x → 1x) for the capture only.
  let dsfNeutralized = false;
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: Math.ceil(metrics.width),
      height: Math.ceil(metrics.height),
      deviceScaleFactor: 1,
      mobile: false,
    });
    dsfNeutralized = true;
  } catch (err) {
    log.warn(
      "setDeviceMetricsOverride unavailable, compensating via clip scale:",
      err,
    );
  }

  try {
    const plan = computeCapturePlan(metrics, dsfNeutralized);
    const result = (await client.send("Page.captureScreenshot", {
      format,
      quality,
      captureBeyondViewport: true,
      clip: {
        x: plan.x,
        y: plan.y,
        width: plan.width,
        height: plan.height,
        scale: plan.scale,
      },
    })) as { data?: string };

    if (!result?.data) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Screenshot failed: captureScreenshot returned no image data",
          },
        ],
        details: { url: tab.url, tabId: tab.id, format, quality },
        isError: true,
      };
    }

    // Save to file; the agent reads it via the describe_image tool
    let filePath: string | undefined;
    let bytes = 0;
    try {
      const saved = saveScreenshotToFile(result.data, format);
      filePath = saved.filePath;
      bytes = saved.bytes;
    } catch (err) {
      log.error("Failed to save screenshot:", err);
    }

    const sizeKB = (bytes / 1024).toFixed(1);
    const dims = `${plan.captureWidthPx}x${plan.captureHeightPx}px`;
    const formatLabel = format === "png" ? "PNG" : `JPEG q${quality}`;
    const readHint = filePath
      ? ` Read it with describe_image (image_path: "${filePath}").`
      : " (Warning: saving to disk failed — no file path available.)";
    const text =
      `Screenshot captured: ${dims} ${formatLabel}, ${bytes} bytes (${sizeKB}KB).` +
      (filePath ? ` Saved to: ${filePath}.` : "") +
      readHint;

    return {
      content: [{ type: "text" as const, text }],
      details: {
        url: tab.url,
        tabId: tab.id,
        format,
        quality,
        bytes,
        widthPx: plan.captureWidthPx,
        heightPx: plan.captureHeightPx,
        dpr: metrics.dpr,
        dprNeutralized: dsfNeutralized,
        maxDim: MAX_SCREENSHOT_DIM,
        filePath,
      },
    };
  } finally {
    if (dsfNeutralized) {
      try {
        await client.send("Emulation.clearDeviceMetricsOverride");
      } catch {
        /* ok — restore best-effort */
      }
    }
  }
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
      const pageResult = (await client.send("Page.getCookies", {
        urls: [],
      })) as {
        cookies: typeof cookies;
      };
      cookies = pageResult.cookies;
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: "ERROR: Could not retrieve cookies - CDP access limited",
          },
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

  const doc = (await client.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as {
    root: { nodeId: number };
  };
  const htmlResult = (await client.send("DOM.getOuterHTML", {
    nodeId: doc.root.nodeId,
    pierce: true,
  })) as { outerHTML: string };

  const { title, content } = extractReadableContent(
    htmlResult.outerHTML,
    tab.url,
  );
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
    details: {
      url: tab.url,
      tabId: tab.id,
      wordCount,
      paragraphCount,
      truncated: truncated.truncated,
    },
  };
}

// Registration: core (always loaded)

function registerCoreTools(pi: ExtensionAPI): void {
  const r = makeBrowserRenderer;
  pi.registerTool({
    name: "browser_navigate",
    exposure: "deferred",
    label: "Browser Navigate",
    description:
      "Navigate a browser tab to a URL. Auto-starts Chrome if not running.",
    parameters: navigateParams,
    async execute(_id, params) {
      return browserNavigate(params);
    },
    ...r("browser_navigate"),
  });
  pi.registerTool({
    name: "browser_snapshot",
    exposure: "deferred",
    label: "Browser Snapshot",
    description:
      "Get a DOM snapshot of the current page. " +
      "Use interactive=true to show only interactive elements.",
    parameters: snapshotParams,
    async execute(_id, params) {
      return browserSnapshot(params);
    },
    ...r("browser_snapshot", {
      successDetailKey: "nodeCount",
      successUnit: "nodes",
    }),
  });
  pi.registerTool({
    name: "browser_eval",
    exposure: "deferred",
    label: "Browser Eval",
    description:
      "Execute JavaScript in the current browser tab. " +
      "Returns structured key-value output for objects and arrays.",
    parameters: evalParams,
    async execute(_id, params) {
      return browserEval(params);
    },
    ...r("browser_eval"),
  });
  pi.registerTool({
    name: "browser_screenshot",
    exposure: "deferred",
    label: "Browser Screenshot",
    description:
      "Capture a screenshot of the current browser viewport. " +
      "Returns a bounded JPEG (quality 75 by default, long edge <= 1440px, DPR-neutralized) " +
      "saved to disk — the tool result contains only a text summary plus the saved file path " +
      "(details.filePath), never the image data. " +
      "Read the image by passing that path to the describe_image tool (params.image_path). " +
      "Params may override format (jpeg/png) and quality (0-100).",
    parameters: screenshotParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      return browserScreenshot(params);
    },
    ...r("browser_screenshot"),
  });
}

function registerCoreCommands(pi: ExtensionAPI): void {
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
        for (const tab of getAllTabs()) {
          try {
            tab.client.disconnect();
          } catch {
            // Best-effort cleanup — sockets may already be closed.
          }
        }
        tabs.clear();
        ctx.ui.notify(
          "Chrome started on :9222" +
            (useProfile ? " (with your profile)" : ""),
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Start failed: ${(err as Error).message.split("\n")[0]}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("browser-connect", {
    description: "Connect to Chrome at :9222 (auto-starts if not running).",
    handler: async (_args, ctx) => {
      try {
        const tab = await ensureTab();
        ctx.ui.notify(`Connected: ${tab.url || "(unknown)"}`, "info");
        if (ctx.hasUI) {
          ctx.ui.setStatus(
            "browser",
            ctx.ui.theme.fg("success", `Browser: ${tab.url || "(unknown)"}`),
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `Connect failed: ${(err as Error).message.split("\n")[0]}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("browser-disconnect", {
    description: "Disconnect from the browser session.",
    handler: async (_args, ctx) => {
      for (const tab of getAllTabs()) {
        try {
          tab.client.disconnect();
        } catch {
          // Best-effort cleanup — sockets may already be closed.
        }
      }
      tabs.clear();
      for (const cleanup of sessionCleanups) {
        try {
          cleanup();
        } catch {
          // One failing cleanup must not skip the rest.
        }
      }
      sessionCleanups.length = 0;
      ctx.ui.notify("Browser disconnected", "info");
    },
  });
}

// Registration: advanced (opt-in via braid.contrib.browserAdvanced)

function registerAdvancedTools(pi: ExtensionAPI): void {
  const r = makeBrowserRenderer;
  pi.registerTool({
    name: "browser_cookies",
    label: "Browser Cookies",
    description: "List all cookies for the current browser page.",
    parameters: cookiesParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      return browserCookies(params);
    },
    ...r("browser_cookies", {
      successDetailKey: "count",
      successUnit: "cookies",
    }),
  });
  pi.registerTool({
    name: "browser_content",
    label: "Browser Content",
    description:
      "Extract readable text from a live web page (current tab or given URL) as markdown. " +
      "For local files, use document_parse instead.",
    parameters: contentParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      return browserContent(params);
    },
    ...r("browser_content"),
  });

  // Tab management
  pi.registerTool({
    name: "browser_tabs_list",
    label: "Browser Tabs List",
    description:
      "List all open browser tabs with their IDs, URLs, and active status.",
    parameters: tabsListParams,
    async execute(_id, _params) {
      const allTabs = getAllTabs();
      if (allTabs.length === 0) {
        return {
          content: [{ type: "text", text: "(no tabs open)" }],
          details: { count: 0, tabs: [] },
        };
      }
      const lines = allTabs.map((t, i) => {
        const status = t.active ? " [active]" : "";
        const title = t.title ? ` — ${t.title}` : "";
        return `[${i + 1}] ${t.id}${status}\n    URL: ${t.url}${title}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: {
          count: allTabs.length,
          tabs: allTabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
          })),
        },
      };
    },
    ...r("browser_tabs_list", {
      successDetailKey: "count",
      successUnit: "tab(s)",
    }),
  });
  pi.registerTool({
    name: "browser_tabs_switch",
    label: "Browser Tabs Switch",
    description:
      "Switch browser focus to a specific tab by ID. Subsequent tools operate on the switched tab.",
    parameters: tabsSwitchParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      const tab = getTab(params.tab_id);
      if (!tab) {
        return {
          content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }],
          isError: true,
          details: {},
        };
      }
      switchToTab(params.tab_id);
      return {
        content: [
          {
            type: "text",
            text: `Switched to tab ${params.tab_id}: ${tab.url}`,
          },
        ],
        details: { tabId: tab.id, url: tab.url },
      };
    },
    ...r("browser_tabs_switch"),
  });
  pi.registerTool({
    name: "browser_tabs_close",
    label: "Browser Tabs Close",
    description:
      "Close a browser tab by ID. If closing the active tab, switches to the most recent remaining tab.",
    parameters: tabsCloseParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      const tab = closeTab(params.tab_id);
      if (!tab) {
        return {
          content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }],
          isError: true,
          details: {},
        };
      }
      const active = getActiveTab();
      return {
        content: [
          {
            type: "text",
            text: `Closed tab ${params.tab_id}${active ? `, switched to ${active.id}` : ""}`,
          },
        ],
        details: { closedTabId: params.tab_id, activeTabId: active?.id },
      };
    },
    ...r("browser_tabs_close"),
  });
  pi.registerTool({
    name: "browser_tabs_create",
    label: "Browser Tabs Create",
    description:
      "Open a URL in a new browser tab. Optionally switches to it (default: true).",
    parameters: tabsCreateParams,
    async execute(_id, params) {
      let port: number | null = null;
      for (const p of DEBUG_PORTS) {
        if (await isBrowserAvailable(p)) {
          port = p;
          break;
        }
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
        content: [
          { type: "text", text: `Opened: ${params.url}\nTab ID: ${entry.id}` },
        ],
        details: { tabId: entry.id, url: entry.url, active: entry.active },
      };
    },
    ...r("browser_tabs_create"),
  });
  pi.registerTool({
    name: "browser_tabs_wait",
    label: "Browser Tabs Wait",
    description:
      "Wait for a browser tab to finish loading or match a URL pattern.",
    parameters: tabsWaitParams,
    async execute(_id, params): Promise<BrowserToolResult> {
      const tab = getTab(params.tab_id);
      if (!tab) {
        return {
          content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }],
          isError: true,
          details: {},
        };
      }
      const timeoutMs = params.timeout ?? 30000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (params.url_pattern && tab.url.includes(params.url_pattern)) {
          return {
            content: [
              {
                type: "text",
                text: `Tab ${params.tab_id} reached: ${tab.url}`,
              },
            ],
            details: { tabId: tab.id, url: tab.url },
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        content: [
          {
            type: "text",
            text: `Timeout waiting for tab ${params.tab_id} (${params.url_pattern ? `pattern: ${params.url_pattern}` : "load"})`,
          },
        ],
        details: { tabId: tab.id, url: tab.url, timedOut: true },
      };
    },
    ...r("browser_tabs_wait"),
  });
}

function registerAdvancedCommands(pi: ExtensionAPI): void {
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
        const lines = allTabs.map(
          (t, i) =>
            `${t.active ? "●" : "○"} [${i + 1}] ${t.title || t.url} (${t.id})`,
        );
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(
          `Tab list failed: ${(err as Error).message.split("\n")[0]}`,
          "error",
        );
      }
    },
  });
}

// Extension entry
export default function browserExtension(pi: ExtensionAPI) {
  const settings = readBrowserSettings();

  // session_shutdown cleanup (always runs)
  pi.on("session_shutdown", async () => {
    for (const tab of getAllTabs()) {
      try {
        tab.client.disconnect();
      } catch {
        // Best-effort cleanup — sockets may already be closed.
      }
    }
    tabs.clear();
    for (const cleanup of sessionCleanups) {
      try {
        cleanup();
      } catch {
        // One failing cleanup must not skip the rest.
      }
    }
    sessionCleanups.length = 0;
  });

  // Core: always loaded (4 tools + 3 commands)
  registerCoreTools(pi);
  registerCoreCommands(pi);

  if (settings.advanced) {
    // Advanced: 7 tools + 1 command
    registerAdvancedTools(pi);
    registerAdvancedCommands(pi);
    log.info("Browser extension registered (core + advanced).");
  } else {
    log.info(
      "Browser extension registered (core only). " +
        "Set braid.contrib.browserAdvanced: true to enable 7 advanced tools " +
        "(cookies, content, tabs_*).",
    );
  }
}

// Cleanup on disconnect or shutdown
