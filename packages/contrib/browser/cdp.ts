/**
 * Native CDP (Chrome DevTools Protocol) client - no external deps.
 * Uses Node.js built-in WebSocket to connect to Chrome at localhost:9222.
 */

import { execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { createLogger } from "../logger.js";

const log = createLogger("browser:cdp");

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
              if (msg.error)
                pending.reject(
                  new Error(`${msg.error.code}: ${msg.error.message}`),
                );
              else pending.resolve(msg.result);
            }
          } else if (msg.method) {
            for (const h of this.eventHandlers) h(msg.method, msg.params);
          }
        } catch {
          // Malformed inbound CDP frame — drop it and keep the socket's
          // message pump alive; the connection itself is unaffected.
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
    const domains = [
      "Log.enable",
      "Page.enable",
      "Runtime.enable",
      "DOM.enable",
    ];

    for (const domain of domains) {
      try {
        await this.send(domain);
        // Small delay between enabling domains
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        log.warn(`Failed to enable ${domain}: ${(err as Error).message}`);
      }
    }

    // Verify Page domain works by checking if we can get version
    try {
      const version = (await this.send("Browser.getVersion")) as {
        protocolVersion?: string;
      };
      log.debug(`Browser protocol: ${version?.protocolVersion}`);
    } catch {
      log.warn("Could not get browser version");
    }
  }

  async connectToBrowser(): Promise<void> {
    const resp = await fetch("http://localhost:9222/json/version");
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl)
      throw new Error(
        "No WebSocket URL. Is Chrome running with --remote-debugging-port=9222?",
      );
    await this.connect(data.webSocketDebuggerUrl);
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = this.nextId++;
    const cmd: CdpCommand = { id, method, params };

    log.debug(
      `>>> ${method}${params ? " " + JSON.stringify(params).slice(0, 100) : ""}`,
    );

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

/** Inputs that decide which processes a scraping reset may signal. */
export interface KillSelectionOptions {
  port: number;
  profileDir: string;
  selfPid: number;
}

/**
 * True when `cmdline` was launched with `arg` (`--flag=value`) as a whole
 * argument. The value may be shell-quoted, and a token boundary is required
 * after it so `--user-data-dir=/a` does not match `--user-data-dir=/ab`.
 */
function hasArg(cmdline: string, arg: string): boolean {
  const eq = arg.indexOf("=");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (eq === -1) return cmdline.split(/\s+/).includes(arg);
  const name = escape(arg.slice(0, eq));
  const value = escape(arg.slice(eq + 1));
  return new RegExp(`(?:^|\\s)${name}=["']?${value}["']?(?=\\s|$)`).test(
    cmdline,
  );
}

/** True for Chrome child processes (`--type=renderer`, `-utility`, ...). */
function isChromeHelper(cmdline: string): boolean {
  return cmdline.split(/\s+/).some((token) => token.startsWith("--type="));
}

/**
 * Choose which processes a scraping reset may SIGKILL, from a `ps` listing
 * shaped `pid command` per line.
 *
 * A pid is a candidate only when its command line carries BOTH the debugging
 * flag for `port` and the scraping `--user-data-dir`. A Chrome started
 * without the debugging flag is the owner's browser: it is never signalled,
 * whatever holds the port. Chrome helper processes inherit both flags but are
 * not the process we spawned, so they are skipped; the browser process reaps
 * them on exit. The caller's own pid is never returned, even when its command
 * line would otherwise match.
 */
export function selectKillablePids(
  psOutput: string,
  opts: KillSelectionOptions,
): number[] {
  const portFlag = `--remote-debugging-port=${opts.port}`;
  const profileFlag = `--user-data-dir=${opts.profileDir}`;
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cmdline = match[2];
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (pid === opts.selfPid) continue;
    if (isChromeHelper(cmdline)) continue;
    if (!hasArg(cmdline, portFlag)) continue;
    if (!hasArg(cmdline, profileFlag)) continue;
    pids.push(pid);
  }
  return pids;
}

/** File recording the pid of the scraping Chrome this contrib last spawned. */
function pidFilePath(profileDir: string): string {
  return `${profileDir}/.chrome-pid`;
}

/**
 * Upper bound on a pid we will pass back to `ps`/`kill`. Above this a value
 * is a corrupt record, not a process: `ps -p` rejects an out-of-range id
 * outright, which would hide the live candidates alongside it.
 */
const MAX_PID = 2 ** 22;

/** The recorded pid, or null when absent, unreadable, or nonsensical. */
function readRecordedPid(profileDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidFilePath(profileDir), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 && pid <= MAX_PID ? pid : null;
  } catch {
    return null;
  }
}

/** Pids whose command line mentions the debugging flag for `port`. */
function pidsMentioningDebugPort(port: number): number[] {
  try {
    const out = execSync(`pgrep -f -- "--remote-debugging-port=${port}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid <= MAX_PID);
  } catch {
    // pgrep exits non-zero when nothing matches; no candidates is the normal
    // cold-start case, not a failure.
    return [];
  }
}

/** `ps` command lines for `pids`, in the `pid command` shape above. */
function commandLinesFor(pids: number[]): string {
  if (pids.length === 0) return "";
  try {
    return execSync(`ps -ww -p ${pids.join(",")} -o pid=,command=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Kill the scraping Chrome this contrib started, if it is still running.
 *
 * Candidates are the pid recorded at spawn time plus any process whose
 * command line mentions the debugging flag; each is verified against its live
 * command line before signalling, so a Chrome without the flag (the owner's
 * browser) is never touched even when it holds the port. When nothing
 * verifies, nothing is killed: an occupied port is not evidence of a stale
 * scrape. Returns the pids that were signalled.
 */
export function killStaleScrapingChrome(opts: {
  port: number;
  profileDir: string;
  selfPid?: number;
}): number[] {
  const selfPid = opts.selfPid ?? process.pid;
  const candidates = new Set<number>(pidsMentioningDebugPort(opts.port));
  const recorded = readRecordedPid(opts.profileDir);
  if (recorded !== null) candidates.add(recorded);

  const killable = selectKillablePids(commandLinesFor([...candidates]), {
    port: opts.port,
    profileDir: opts.profileDir,
    selfPid,
  });

  for (const pid of killable) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone; the reset's goal (no stale scraping Chrome) holds.
    }
  }
  if (killable.length > 0) {
    try {
      rmSync(pidFilePath(opts.profileDir), { force: true });
    } catch {
      // A stale record is harmless: the next spawn overwrites it.
    }
  }
  return killable;
}

/** Spawn Chrome with remote debugging and return the port it started on. */
export async function spawnChrome(
  opts: { useProfile?: boolean; port?: number; profileDir?: string } = {},
): Promise<number> {
  const home = process.env.HOME ?? os.tmpdir();
  const SCRAPING_DIR = opts.profileDir ?? `${home}/.cache/browser-tools`;
  const port = opts.port ?? 9222;

  // Clean up singleton locks and replace the scraping Chrome from a previous
  // run. Only a process whose command line carries the debugging flag and this
  // profile is ever signalled; the owner's Chrome and this process are not.
  execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });
  execSync(
    `rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`,
    { stdio: "ignore" },
  );
  killStaleScrapingChrome({ port, profileDir: SCRAPING_DIR });

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
  log.debug(
    `Args: --remote-debugging-port=${port} --user-data-dir=${SCRAPING_DIR}`,
  );

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
    // Drop the record only while it still names this child, so a newer spawn's
    // record is never erased by an older one exiting.
    try {
      if (
        child.pid !== undefined &&
        readRecordedPid(SCRAPING_DIR) === child.pid
      ) {
        rmSync(pidFilePath(SCRAPING_DIR), { force: true });
      }
    } catch {
      // Best effort: the next spawn overwrites the record anyway.
    }
  });

  if (child.pid !== undefined) {
    try {
      writeFileSync(pidFilePath(SCRAPING_DIR), String(child.pid));
    } catch (err) {
      log.warn(`Could not record Chrome pid: ${(err as Error).message}`);
    }
  }

  child.unref();

  // Give Chrome a moment to start
  await new Promise((r) => setTimeout(r, 500));

  return port;
}

/** Poll until Chrome is ready on a port, then return the WebSocket URL. */
export async function waitForChrome(
  port: number,
  timeoutMs = 30000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`);
      if (resp.ok) {
        const data = (await resp.json()) as { webSocketDebuggerUrl: string };
        return data.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome not accepting connections yet — the loop below retries until
      // the timeout; this is the expected cold-start path.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
}
