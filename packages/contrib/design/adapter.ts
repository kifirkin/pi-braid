/**
 * The browser half: turn a URL or a local file into one snapshot per width,
 * plus a screenshot per width.
 *
 * Thin on purpose. It opens a tab, emulates a width, waits for layout to
 * settle, evaluates one collection script, captures a full-page PNG, and
 * repeats. Every decision about what a number means lives in `./audit.ts`,
 * which this module never imports: the adapter produces records, the ruler
 * measures them.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  CdpClient,
  isBrowserAvailable,
  spawnChrome,
  waitForChrome,
} from "../browser/cdp.js";
import type { Snapshot } from "./audit.js";

const PORT = 9222;
const VIEWPORT_HEIGHT = 900;
const MAX_SCREENSHOT_HEIGHT = 12000;
const SETTLE_TIMEOUT_MS = 30000;

interface Target {
  url: string;
  /** The local file behind a `file:` target, for DESIGN.md discovery. */
  localPath: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Accept an http(s) URL, a file URL, or a path. A scheme this audit cannot
 * render is refused before a browser is touched, so a typo is not a
 * navigation error forty seconds later.
 */
export function resolveTarget(target: string): Target {
  const text = target.trim();
  if (text === "") throw new Error("target is empty");
  if (/^https?:\/\//i.test(text)) return { url: text, localPath: null };
  if (/^file:\/\//i.test(text)) {
    const localPath = fileURLToPath(text);
    if (!existsSync(localPath)) {
      throw new Error(`local file not found: ${localPath}`);
    }
    return { url: text, localPath };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    throw new Error(
      `unsupported target scheme (only http, https and file are rendered): ${text}`,
    );
  }
  const localPath = resolve(text);
  if (!existsSync(localPath)) {
    throw new Error(`local file not found: ${localPath}`);
  }
  return { url: pathToFileURL(localPath).href, localPath };
}

/** The project token file: beside the page, then one directory above it. */
export function findDesignFile(localPath: string | null): string | null {
  if (localPath === null) return null;
  const directory = dirname(localPath);
  for (const candidate of [
    join(directory, "DESIGN.md"),
    join(dirname(directory), "DESIGN.md"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * One collection script, evaluated at every width. It records what the CSS
 * computed to, never what a stylesheet says; selector paths are tag plus
 * `:nth-of-type` so a finding reads the same in any run.
 */
const COLLECT = `(() => {
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1 };
  const INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1,
    menuitem: 1, option: 1, slider: 1, spinbutton: 1, textbox: 1,
    combobox: 1, searchbox: 1,
  };
  const STYLE_KEYS = [
    "color", "background-color", "font-size", "font-weight", "line-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border-radius", "box-shadow", "display", "visibility", "opacity",
  ];
  const FIELD = (key) => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

  window.scrollTo(0, 0);

  const elements = Array.from(document.querySelectorAll("*")).filter(
    (element) => !SKIP[element.tagName],
  );
  const indexOf = new Map();
  elements.forEach((element, index) => indexOf.set(element, index));

  const pathOf = (element) => {
    const segments = [];
    let cursor = element;
    while (cursor && cursor.nodeType === 1) {
      const tag = cursor.tagName.toLowerCase();
      if (tag === "html") {
        segments.unshift("html");
        break;
      }
      let position = 1;
      let sibling = cursor.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === cursor.tagName) position += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(tag + ":nth-of-type(" + position + ")");
      cursor = cursor.parentElement;
    }
    return segments.join(" > ");
  };

  const isInteractive = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href");
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") {
      return !element.disabled;
    }
    if (tag === "input") return element.type !== "hidden" && !element.disabled;
    if (element.hasAttribute("onclick")) return true;
    const role = element.getAttribute("role");
    if (role && INTERACTIVE_ROLES[role]) return true;
    const tabindex = element.getAttribute("tabindex");
    return tabindex !== null && Number(tabindex) >= 0 && element.tabIndex >= 0;
  };

  const nodes = elements.map((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.data)
      .join(" ")
      .replace(/\\s+/g, " ")
      .trim();
    const parent = element.parentElement;
    const parentIndex = parent !== null && indexOf.has(parent) ? indexOf.get(parent) : null;
    const computed = {};
    for (const key of STYLE_KEYS) {
      computed[FIELD(key)] = style.getPropertyValue(key);
    }
    return {
      tag: element.tagName.toLowerCase(),
      path: pathOf(element),
      parent: parentIndex,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      style: computed,
      text: ownText,
      textLength: Array.from(ownText).length,
      interactive: isInteractive(element),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });

  const htmlBackground = window.getComputedStyle(document.documentElement).backgroundColor;
  const bodyBackground = document.body
    ? window.getComputedStyle(document.body).backgroundColor
    : "rgba(0, 0, 0, 0)";
  const transparent = (value) => !value || value === "transparent" || /^rgba\\(.*,\\s*0\\)$/.test(value);
  const canvasColor = !transparent(htmlBackground)
    ? htmlBackground
    : !transparent(bodyBackground)
      ? bodyBackground
      : "rgb(255, 255, 255)";

  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    window.innerHeight,
  );

  return JSON.stringify({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight,
    canvasColor,
    nodes,
  });
})()`;

async function evaluate(
  client: CdpClient,
  expression: string,
  awaitPromise = false,
): Promise<unknown> {
  const result = (await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  })) as { result?: { value?: unknown } };
  return result.result?.value;
}

/**
 * Navigate and wait for the new document to load, then for fonts and two
 * layout frames.
 *
 * The load event is the signal, not `document.readyState`: after
 * `Page.navigate` the previous document is still complete, so a readyState
 * poll can read the page that was there before and report it as this width.
 * The listener is attached before the navigation is issued, so the event for
 * this document cannot be missed.
 */
async function loadPage(
  client: CdpClient,
  url: string,
  timeoutMs: number,
): Promise<void> {
  let loaded = false;
  const stop = client.onEvent((method) => {
    if (method === "Page.loadEventFired") loaded = true;
  });
  try {
    const deadline = Date.now() + timeoutMs;
    const outcome = (await client.send("Page.navigate", { url })) as {
      errorText?: string;
    };
    // A refused connection still fires the load event, for the browser's own
    // error document. Measuring that document would report the error page's
    // colours and type as the target's, so the navigation failure is the
    // result.
    if (typeof outcome?.errorText === "string" && outcome.errorText !== "") {
      throw new Error(`navigation failed: ${outcome.errorText} (${url})`);
    }
    while (!loaded && Date.now() < deadline) await sleep(25);
    if (!loaded) {
      throw new Error(
        `page did not finish loading within ${timeoutMs}ms: ${url}`,
      );
    }
    const errorPage =
      (await evaluate(client, "location.protocol === 'chrome-error:'")) ===
      true;
    if (errorPage) {
      throw new Error(`navigation landed on the browser error page: ${url}`);
    }
  } finally {
    stop();
  }
  // Fonts, two layout frames, then a bounded wait for running animations to
  // finish and a freeze of whatever is still moving. A measurement taken while
  // a toast slides or a pulse scales reads coverage that changes between runs;
  // freezing removes the motion during collection. A looping animation is
  // frozen wherever it happens to be, so its own box can still differ between
  // runs of a live page - a recorded snapshot does not.
  await evaluate(
    client,
    `(async () => {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (_) {}
      }
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
      const running = () =>
        document.getAnimations().filter((a) => a.playState === "running");
      const deadline = Date.now() + 1500;
      while (running().length > 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
      }
      for (const animation of document.getAnimations()) {
        try { animation.pause(); } catch (_) {}
      }
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
      return true;
    })()`,
    true,
  );
  await sleep(50);
}

async function openTab(
  port: number,
): Promise<{ client: CdpClient; id: string }> {
  const response = await fetch(
    `http://localhost:${port}/json/new?url=` +
      encodeURIComponent("about:blank"),
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`could not open a browser tab (HTTP ${response.status})`);
  }
  const target = (await response.json()) as {
    id: string;
    webSocketDebuggerUrl: string;
  };
  const client = new CdpClient();
  client.setTargetId(target.id);
  await client.connect(target.webSocketDebuggerUrl);
  await client.enableDomains();
  return { client, id: target.id };
}

async function closeTab(
  client: CdpClient,
  port: number,
  id: string,
): Promise<void> {
  try {
    await client.send("Page.close");
  } catch {
    try {
      await fetch(`http://localhost:${port}/json/close/` + id);
    } catch {
      // Closing is best effort: the tab itself is disposable.
    }
  }
  client.disconnect();
}

export interface CaptureOptions {
  widths: number[];
  /** Where PNGs land; null skips screenshots (the fixture recorder does). */
  screenshotDir: string | null;
  /** Per-width load timeout. */
  timeoutMs?: number;
}

export interface CapturedWidth {
  snapshot: Snapshot;
  screenshot: { path: string; height: number; truncated: boolean } | null;
}

export interface CaptureResult {
  target: string;
  widths: CapturedWidth[];
}

/**
 * Render `target` at each width and return the recorded snapshots. Chrome is
 * reused when already reachable on the debugging port, otherwise started with
 * the contrib package's own scratch profile.
 */
export async function capturePage(
  target: string,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const resolved = resolveTarget(target);
  const widths = [...new Set(options.widths)].sort((a, b) => a - b);
  if (widths.length === 0) throw new Error("at least one width is required");
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;

  let port = PORT;
  if (!(await isBrowserAvailable(PORT))) {
    port = await spawnChrome({});
    await waitForChrome(port);
  }

  const { client, id } = await openTab(port);
  const captured: CapturedWidth[] = [];

  try {
    for (const width of widths) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await loadPage(client, resolved.url, timeoutMs);

      const raw = await evaluate(client, COLLECT);
      if (typeof raw !== "string") {
        throw new Error(
          `snapshot collection returned no records at ${width}px`,
        );
      }
      const snapshot = JSON.parse(raw) as Snapshot;
      snapshot.url = resolved.url;

      let screenshot: CapturedWidth["screenshot"] = null;
      if (options.screenshotDir !== null) {
        const height = Math.min(
          Math.ceil(snapshot.documentHeight),
          MAX_SCREENSHOT_HEIGHT,
        );
        const shot = (await client.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        })) as { data?: string };
        if (typeof shot.data === "string" && shot.data !== "") {
          mkdirSync(options.screenshotDir, { recursive: true });
          const path = join(options.screenshotDir, `${width}.png`);
          writeFileSync(path, Buffer.from(shot.data, "base64"));
          screenshot = {
            path,
            height,
            truncated: height < Math.ceil(snapshot.documentHeight),
          };
        }
      }

      captured.push({ snapshot, screenshot });
    }
  } finally {
    await closeTab(client, port, id);
  }

  return { target: resolved.url, widths: captured };
}
