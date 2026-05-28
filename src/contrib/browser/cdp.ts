// @ts-nocheck
/**
 * Native CDP (Chrome DevTools Protocol) client - no external deps.
 * Uses Node.js built-in WebSocket to connect to Chrome at localhost:9222.
 */

import * as os from "node:os";

const log = { info: console.log, debug: () => {}, warn: console.warn, error: console.error };

interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type CdpEventHandler = (method: string, params: unknown) => void;

/**
 * Lightweight CDP WebSocket client.
 */
export class CdpClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers: CdpEventHandler[] = [];
  private nextId = 1;
  private _isConnected = false;
  private _sessionId: string | null = null;
  private _targetId: string | null = null;

  async connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("No socket"));

      this.ws.onopen = () => {
        this._isConnected = true;
        resolve();
      };
      this.ws.onerror = () => reject(new Error("WebSocket error"));
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as CdpResponse & {
            method?: string;
            params?: unknown;
          };
          if ("result" in msg || "error" in msg) {
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
              else pending.resolve(msg.result);
            }
          } else if (msg.method) {
            for (const h of this.eventHandlers) h(msg.method, msg.params);
          }
        } catch {
          // ignore parse errors
          /* Non-fatal: CDP connection not available */
        }
      };
      this.ws.onclose = () => {
        this._isConnected = false;
      };
    });
  }

  /**
   * Enable required CDP domains after connecting to a tab.
   * The WebSocket URL from /json/<tab-id> already provides full CDP access.
   */
  async enableDomains(): Promise<void> {
    // Connected to tab WebSocket - should have full access
    // Try to enable domains one at a time with delays
    const domains = ["Log.enable", "Page.enable", "Runtime.enable", "DOM.enable"];

    for (const domain of domains) {
      try {
        await this.send(domain);
        // Small delay between enabling domains
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        // Log but continue
        log.warn(`Failed to enable ${domain}: ${(err as Error).message}`);
      }
    }

    // Verify Page domain works by checking if we can get version
    try {
      const version = (await this.send("Browser.getVersion")) as { protocolVersion?: string };
      log.debug(`Browser protocol: ${version?.protocolVersion}`);
    } catch {
      log.warn("Could not get browser version");
    }
  }

  async connectToBrowser(): Promise<void> {
    const resp = await fetch("http://localhost:9222/json/version");
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl)
      throw new Error("No WebSocket URL. Is Chrome running with --remote-debugging-port=9222?");
    await this.connect(data.webSocketDebuggerUrl);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = this.nextId++;
    const cmd: CdpCommand = { id, method, params };

    log.debug(`>>> ${method}${params ? " " + JSON.stringify(params).slice(0, 100) : ""}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          log.debug(`<<< ${method}: OK`);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          log.debug(`!!! ${method}: ${e.message}`);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify(cmd));
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._isConnected = false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  setTargetId(targetId: string): void {
    this._targetId = targetId;
  }
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
}

/** List all browser tabs. */
export async function listTabs(port = 9222): Promise<TabInfo[]> {
  const resp = await fetch(`http://localhost:${port}/json`);
  const data = (await resp.json()) as Array<{
    id: string;
    url: string;
    title: string;
    webSocketDebuggerUrl?: string;
  }>;
  return data
    .filter((t) => t.webSocketDebuggerUrl)
    .map((t) => ({ id: t.id, url: t.url, title: t.title }));
}

/** Connect to a specific tab by WebSocket URL. */
export async function connectToTab(wsUrl: string): Promise<CdpClient> {
  const client = new CdpClient();
  await client.connect(wsUrl);
  return client;
}

/** Check if Chrome is reachable on the debugging port. */
export async function isBrowserAvailable(port = 9222): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Spawn Chrome with remote debugging and return the port it started on. */
export async function spawnChrome(
  opts: { useProfile?: boolean; port?: number } = {},
): Promise<number> {
  const { execSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const home = process.env.HOME ?? os.tmpdir();
  const SCRAPING_DIR = `${home}/.cache/browser-tools`;
  const port = opts.port ?? 9222;

  // Clean up singleton locks and old processes on that port
  execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });
  execSync(
    `rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`,
    { stdio: "ignore" },
  );
  // Kill any existing Chrome on this port
  execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });

  if (opts.useProfile) {
    // Sync Chrome profile (without session data)
    execSync(
      `rsync -a --delete ` +
        `--exclude='SingletonLock' --exclude='SingletonSocket' --exclude='SingletonCookie' ` +
        `--exclude='*/Sessions/*' --exclude='*/Current Session' --exclude='*/Current Tabs' ` +
        `--exclude='*/Last Session' --exclude='*/Last Tabs' ` +
        `"${home}/Library/Application Support/Google/Chrome/" "${SCRAPING_DIR}/"`,
      { stdio: "ignore" },
    );
  }

  const { spawn } = await import("node:child_process");
  const isMac = process.platform === "darwin";
  const chromePath = isMac
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome";

  // Verify Chrome exists
  try {
    execSync(`test -x "${chromePath}"`, { stdio: "pipe" });
  } catch {
    throw new Error(`Chrome not found at: ${chromePath}`);
  }

  log.info(`Starting Chrome at ${chromePath}`);
  log.debug(`Args: --remote-debugging-port=${port} --user-data-dir=${SCRAPING_DIR}`);

  // Chrome with full DevTools support
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${SCRAPING_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "pipe" },
  );

  child.on("error", (err) => {
    log.error(`Chrome spawn error: ${err.message}`);
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log.error(`Chrome exit code: ${code}`);
    }
  });

  child.unref();

  // Give Chrome a moment to start
  await new Promise((r) => setTimeout(r, 500));

  return port;
}

/** Poll until Chrome is ready on a port, then return the WebSocket URL. */
export async function waitForChrome(port: number, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`);
      if (resp.ok) {
        const data = (await resp.json()) as { webSocketDebuggerUrl: string };
        return data.webSocketDebuggerUrl;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
}
