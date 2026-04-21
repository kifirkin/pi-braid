/**
 * Logger — Unified logging for pi-braid extensions
 *
 * Respects the pi Extension API:
 * - No ctx available (load time, lib code) → plain console
 * - ctx available with UI (interactive mode) → ctx.ui.notify() for warn/error
 * - ctx available without UI (RPC/print mode) → console only
 *
 * Usage in extensions:
 *   const log = createLogger("my-extension");
 *
 *   export default function myExt(pi: ExtensionAPI): void {
 *     pi.registerTool("myTool", {
 *       async execute(toolCallId, params, signal, onUpdate, ctx) {
 *         log.bindContext(ctx);
 *         log.warn("Something unexpected"); // routes through TUI
 *         log.info("Progress update");      // console + status bar
 *       }
 *     });
 *   }
 *
 * Usage in lib/ (no ctx):
 *   const log = createLogger("evidence-pool");
 *   log.info("Pool initialized"); // console only
 */

import type {
	ExtensionContext,
	ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
	timestamp: number;
	level: LogLevel;
	source: string;
	message: string;
	data?: unknown;
}

export interface Logger {
	/** Bind a context for this execution scope. Call at start of handler/tool. */
	bindContext(ctx: ExtensionContext | undefined): void;
	/** Unbind the current context. Call at end if you want strict scoping. */
	unbindContext(): void;
	/** Check if a context is currently bound. */
	hasContext(): boolean;
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

// ── Module state ───────────────────────────────────────────────────────────

const _LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const _suppressedSources = new Set<string>();
let _globalMinLevel: LogLevel = "info";
let _globallySuppressed = false;

/** Minimum level that writes to the process console. info/debug are TUI/buffer only. */
let _consoleMinLevel: LogLevel = "warn";

/** In-memory log buffer for the current session (last 200 entries) */
const _logBuffer: LogEntry[] = [];
const MAX_BUFFER_SIZE = 200;

// ── Format helpers ─────────────────────────────────────────────────────────

function formatLevel(level: LogLevel): string {
	return level.toUpperCase().padEnd(5);
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toISOString().slice(11, 23); // HH:mm:ss.mmm
}

function formatData(data: unknown): string {
	if (data === undefined || data === null) return "";
	if (data instanceof Error) {
		let s = ` ${data.message}`;
		if (data.stack) s += ` | ${data.stack.split("\n").slice(1, 3).join(" | ")}`;
		return s;
	}
	if (typeof data === "object") {
		try {
			const json = JSON.stringify(data);
			return json.length > 200 ? ` ${json.slice(0, 197)}...` : ` ${json}`;
		} catch {
			return " [unstringifiable]";
		}
	}
	return ` ${String(data)}`;
}

function formatConsole(entry: LogEntry): string {
	const ts = formatTimestamp(entry.timestamp);
	return `${ts} ${formatLevel(entry.level)} [${entry.source}] ${entry.message}${formatData(entry.data)}`;
}

function formatNotify(entry: LogEntry): string {
	return `[${entry.source}] ${entry.message}${formatData(entry.data)}`;
}

// ── Core sink ──────────────────────────────────────────────────────────────

function writeToConsole(entry: LogEntry): void {
	if (_LEVEL_PRIORITY[entry.level] < _LEVEL_PRIORITY[_consoleMinLevel]) {
		return; // info/debug stay in buffer / TUI, don't spam the raw terminal
	}
	const line = formatConsole(entry);
	switch (entry.level) {
		case "warn":
			console.warn(line);
			break;
		case "error":
			console.error(line);
			break;
		default:
			console.log(line);
			break;
	}
}

function writeToUI(ui: ExtensionUIContext, entry: LogEntry): void {
	const msg = formatNotify(entry);
	switch (entry.level) {
		case "debug":
			// Debug goes to console only, not TUI
			break;
		case "info":
			// Info sets status but doesn't notify (too noisy)
			ui.setStatus?.(entry.source, msg);
			break;
		case "warn":
			ui.notify(msg, "warning");
			break;
		case "error":
			ui.notify(msg, "error");
			break;
	}
}

function addToBuffer(entry: LogEntry): void {
	_logBuffer.push(entry);
	if (_logBuffer.length > MAX_BUFFER_SIZE) {
		_logBuffer.shift();
	}
}

// ── Logger factory ─────────────────────────────────────────────────────────

class LoggerImpl implements Logger {
	private _source: string;
	private _ctxStack: (ExtensionContext | undefined)[] = [];

	constructor(source: string) {
		this._source = source;
	}

	bindContext(ctx: ExtensionContext | undefined): void {
		this._ctxStack.push(ctx);
	}

	unbindContext(): void {
		this._ctxStack.pop();
	}

	hasContext(): boolean {
		return this._ctxStack.length > 0 && this._ctxStack[this._ctxStack.length - 1] !== undefined;
	}

	private _currentCtx(): ExtensionContext | undefined {
		if (this._ctxStack.length === 0) return undefined;
		return this._ctxStack[this._ctxStack.length - 1];
	}

	private _shouldLog(level: LogLevel): boolean {
		if (_globallySuppressed) return false;
		if (_suppressedSources.has(this._source)) return false;
		if (_LEVEL_PRIORITY[level] < _LEVEL_PRIORITY[_globalMinLevel]) return false;
		return true;
	}

	private _emit(level: LogLevel, message: string, data?: unknown): void {
		if (!this._shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			source: this._source,
			message,
			data,
		};

		addToBuffer(entry);
		writeToConsole(entry);

		const ctx = this._currentCtx();
		if (ctx?.hasUI && ctx.ui) {
			writeToUI(ctx.ui, entry);
		}
	}

	debug(message: string, data?: unknown): void {
		this._emit("debug", message, data);
	}

	info(message: string, data?: unknown): void {
		this._emit("info", message, data);
	}

	warn(message: string, data?: unknown): void {
		this._emit("warn", message, data);
	}

	error(message: string, data?: unknown): void {
		this._emit("error", message, data);
	}
}

// ── Public API ─────────────────────────────────────────────────────────────

const _loggers = new Map<string, Logger>();

/**
 * Create (or retrieve) a named logger.
 *
 * Loggers are cached by name — calling createLogger("foo") twice returns the
 * same instance. This lets lib/ code and extension code share a logger.
 */
export function createLogger(source: string): Logger {
	if (!_loggers.has(source)) {
		_loggers.set(source, new LoggerImpl(source));
	}
	return _loggers.get(source)!;
}

/** Suppress a specific source (e.g. during tests). */
export function suppressLogger(source: string): void {
	_suppressedSources.add(source);
}

/** Unsuppress a previously suppressed source. */
export function unsuppressLogger(source: string): void {
	_suppressedSources.delete(source);
}

/** Suppress ALL loggers. */
export function suppressAllLoggers(): void {
	_globallySuppressed = true;
}

/** Unsuppress all loggers. */
export function unsuppressAllLoggers(): void {
	_globallySuppressed = false;
}

/** Set the minimum log level globally. */
export function setGlobalLogLevel(level: LogLevel): void {
	_globalMinLevel = level;
}

/** Set the minimum level that reaches the process console. */
export function setConsoleLogLevel(level: LogLevel): void {
	_consoleMinLevel = level;
}

/** Get the in-memory log buffer (for debugging / crash reports). */
export function getLogBuffer(): readonly LogEntry[] {
	return _logBuffer;
}

/** Clear the in-memory log buffer. */
export function clearLogBuffer(): void {
	_logBuffer.length = 0;
}

/** Get formatted log buffer as string (for crash reports). */
export function formatLogBuffer(): string {
	return _logBuffer.map(formatConsole).join("\n");
}

/** Get all active logger source names. */
export function getActiveLoggerSources(): string[] {
	return Array.from(_loggers.keys());
}

// ── Backwards compatibility ────────────────────────────────────────────────
// taggedConsole was a quick-and-dirty console wrapper. Removed in favor of
// the proper Logger interface above. If you have code using taggedConsole,
// replace:
//   import { taggedConsole } from "../../lib/logger.js";
//   const log = taggedConsole("source");
// With:
//   import { createLogger } from "../../lib/logger.js";
//   const log = createLogger("source");
