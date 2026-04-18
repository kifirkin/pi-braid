/**
 * Native CDP (Chrome DevTools Protocol) client - no external deps.
 * Uses Node.js built-in WebSocket to connect to Chrome at localhost:9222.
 */

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
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private eventHandlers: CdpEventHandler[] = [];
	private nextId = 1;
	private _isConnected = false;
	private _sessionId: string | null = null;

	async connect(wsUrl: string): Promise<void> {
		this.ws = new WebSocket(wsUrl);

		return new Promise((resolve, reject) => {
			if (!this.ws) return reject(new Error("No socket"));

			this.ws.onopen = () => { this._isConnected = true; resolve(); };
			this.ws.onerror = () => reject(new Error("WebSocket error"));
			this.ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data as string) as CdpResponse & { method?: string; params?: unknown };
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
				}
			};
			this.ws.onclose = () => { this._isConnected = false; };
		});
	}

	/**
	 * Enable required CDP domains after connecting to a tab.
	 * For attached sessions, we need to enable domains on the session.
	 */
	async enableDomains(): Promise<void> {
		// Enable all required domains with proper sequencing
		const domains = ["Log.enable", "Page.enable", "Runtime.enable", "DOM.enable", "Target.setAutoAttach"];
		for (const domain of domains) {
			try {
				await this.send(domain);
			} catch (err) {
				// Log but continue - some domains might not be available
				console.warn(`Failed to enable ${domain}: ${(err as Error).message}`);
			}
		}
	}

	/**
	 * Attach to a specific target (tab) by ID.
	 * This creates a new session for the target.
	 */
	async attachToTarget(targetId: string): Promise<void> {
		const result = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId?: string };
		if (result?.sessionId) {
			this._sessionId = result.sessionId;
		}
	}

	async connectToBrowser(): Promise<void> {
		const resp = await fetch("http://localhost:9222/json/version");
		const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
		if (!data.webSocketDebuggerUrl) throw new Error("No WebSocket URL. Is Chrome running with --remote-debugging-port=9222?");
		await this.connect(data.webSocketDebuggerUrl);
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected");
		}

		const id = this.nextId++;
		const cmd: CdpCommand = { id, method, params };

		console.log(`[CDP] >>> ${method}`, params ? JSON.stringify(params).slice(0, 200) : "");

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, 30000);

			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timeout); console.log(`[CDP] <<< ${method}:`, JSON.stringify(v).slice(0, 200)); resolve(v); },
				reject: (e) => { clearTimeout(timeout); console.log(`[CDP] !!! ${method}:`, e.message); reject(e); }
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
}

export interface TabInfo {
	id: string;
	url: string;
	title: string;
}

/** List all browser tabs. */
export async function listTabs(port = 9222): Promise<TabInfo[]> {
	const resp = await fetch(`http://localhost:${port}/json`);
	const data = (await resp.json()) as Array<{ id: string; url: string; title: string; webSocketDebuggerUrl?: string }>;
	return data.filter((t) => t.webSocketDebuggerUrl).map((t) => ({ id: t.id, url: t.url, title: t.title }));
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
		const resp = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		return resp.ok;
	} catch {
		return false;
	}
}

/** Spawn Chrome with remote debugging and return the port it started on. */
export async function spawnChrome(opts: { useProfile?: boolean; port?: number } = {}): Promise<number> {
	const { execSync } = await import("node:child_process");
	const { join } = await import("node:path");
	const home = process.env.HOME ?? "/Users/kifir";
	const SCRAPING_DIR = `${home}/.cache/browser-tools`;
	const port = opts.port ?? 9222;

	// Clean up singleton locks
	execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });
	execSync(`rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`, { stdio: "ignore" });

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

	const child = spawn(chromePath, [
		"--remote-debugging-port=" + port,
		`--user-data-dir=${SCRAPING_DIR}`,
		"--no-first-run",
		"--no-default-browser-check",
	], { detached: true, stdio: "ignore" });
	child.unref();

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
		} catch { /* not ready yet */ }
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
}
