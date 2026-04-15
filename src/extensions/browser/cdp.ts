/**
 * Native CDP (Chrome DevTools Protocol) client — no external deps.
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
	private url = "";

	async connect(wsUrl: string): Promise<void> {
		this.url = wsUrl;
		this.ws = new WebSocket(wsUrl);

		return new Promise((resolve, reject) => {
			if (!this.ws) return reject(new Error("No socket"));

			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) => reject(new Error(`WebSocket error: ${JSON.stringify(e)}`));
			this.ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data as string) as CdpResponse & { method?: string; params?: unknown };
					if ("result" in msg || "error" in msg) {
						// Response
						const pending = this.pending.get(msg.id);
						if (pending) {
							this.pending.delete(msg.id);
							if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
							else pending.resolve(msg.result);
						}
					} else if (msg.method) {
						// Event
						for (const h of this.eventHandlers) h(msg.method, msg.params);
					}
				} catch {
					// ignore parse errors
				}
			};
			this.ws.onclose = () => {
				this.ws = null;
			};
		});
	}

	/** Enable required CDP domains after connecting to a tab. */
	async enableDomains(): Promise<void> {
		await this.send("DOM.enable");
		await this.send("Runtime.enable");
		await this.send("Page.enable");
	}

	async connectToBrowser(): Promise<void> {
		const resp = await fetch("http://localhost:9222/json/version");
		const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
		if (!data.webSocketDebuggerUrl) throw new Error("No WebSocket URL found. Is Chrome running with --remote-debugging-port=9222?");
		await this.connect(data.webSocketDebuggerUrl);
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected");
		}

		const id = this.nextId++;
		const cmd: CdpCommand = { id, method, params };

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
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
	}

	get isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}
}

export interface TabInfo {
	id: string;
	url: string;
	title: string;
}

/**
 * List all browser tabs.
 */
export async function listTabs(port = 9222): Promise<TabInfo[]> {
	const resp = await fetch(`http://localhost:${port}/json`);
	const data = (await resp.json()) as Array<{ id: string; url: string; title: string; webSocketDebuggerUrl?: string }>;
	return data
		.filter((t) => t.webSocketDebuggerUrl)
		.map((t) => ({ id: t.id, url: t.url, title: t.title }));
}

/**
 * Connect to a specific tab by ID.
 */
export async function connectToTab(wsUrl: string): Promise<CdpClient> {
	const client = new CdpClient();
	await client.connect(wsUrl);
	return client;
}

/**
 * Check if Chrome is reachable on the debugging port.
 */
export async function isBrowserAvailable(port = 9222): Promise<boolean> {
	try {
		const resp = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		return resp.ok;
	} catch {
		return false;
	}
}
