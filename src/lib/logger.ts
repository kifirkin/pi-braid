/**
 * Logger - Centralized logging for pi-braid extensions
 *
 * Routes output appropriately:
 * - TUI mode: Uses ctx.ui.notify() for user-visible messages, console for verbose
 * - Non-TUI mode: Falls back to console.log/error/warn
 * - Supports log levels with configurable minimum
 * - Per-source and global suppression
 *
 * Usage:
 *   import { createLogger } from "../../lib/logger.js";
 *
 *   const log = createLogger("my-extension");
 *   log.info("Starting up...");
 *   log.warn("Something unexpected");
 *   log.error("Failed to load", error);
 *   log.debug("Internal state", { count: 42 });
 *
 * Or import the taggedConsole helper for drop-in console replacement:
 *   import { taggedConsole } from "../../lib/logger.js";
 *   const log = taggedConsole("my-ext");
 *   log.log("Debug info");  // Outputs: [my-ext] Debug info
 */

import type { ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";

// Types

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
	timestamp: number;
	level: LogLevel;
	source: string;
	message: string;
	data?: unknown;
}

// Module state

const _LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const _suppressedSources = new Set<string>();
let _globallySuppressed = false;

/** In-memory log buffer for debugging (last 100 entries) */
const _logBuffer: LogEntry[] = [];
const MAX_BUFFER_SIZE = 100;

// Format helpers

function formatLevel(level: LogLevel): string {
	return level.toUpperCase().padEnd(5);
}

function formatSource(source: string): string {
	return `[${source}]`;
}

function formatMessage(entry: LogEntry): string {
	let msg = `${formatLevel(entry.level)} ${formatSource(entry.source)} ${entry.message}`;
	if (entry.data !== undefined) {
		if (entry.data instanceof Error) {
			msg += `\n  ${entry.data.message}`;
			if (entry.data.stack) {
				msg += `\n  ${entry.data.stack.split("\n").slice(1).join("\n  ")}`;
			}
		} else if (typeof entry.data === "object") {
			msg += ` ${JSON.stringify(entry.data)}`;
		} else {
			msg += ` ${String(entry.data)}`;
		}
	}
	return msg;
}

/** Buffer entry for later retrieval */
function bufferEntry(entry: LogEntry): void {
	_logBuffer.push(entry);
	if (_logBuffer.length > MAX_BUFFER_SIZE) {
		_logBuffer.shift();
	}
}

// Routing configuration

/**
 * TUI log routing behavior.
 * Controls how different log levels are displayed in TUI mode.
 */
export type TUIRouteMode = "all" | "alerts-only" | "silent";

interface LoggerConfig {
	/** Minimum log level to output (default: "info") */
	minLevel: LogLevel;
	/** How to route output in TUI mode (default: "alerts-only") */
	tuiRoute: TUIRouteMode;
	/** Suppress console.log in TUI mode even for info/debug (default: false) */
	suppressTUIConsole: boolean;
}

const _defaultConfig: LoggerConfig = {
	minLevel: "info",
	tuiRoute: "alerts-only",
	suppressTUIConsole: false,
};

let _globalConfig: LoggerConfig = { ..._defaultConfig };

// Core logger class

export class Logger {
	private readonly source: string;
	private readonly _config: LoggerConfig;
	private readonly _ctx: ExtensionContext | undefined;
	private readonly _ui: ExtensionUIContext | undefined;

	constructor(
		source: string,
		minLevel: LogLevel = "info",
		ctx?: ExtensionContext,
		config?: Partial<LoggerConfig>,
	) {
		this.source = source;
		this._config = { ..._defaultConfig, ..._globalConfig, ...config, minLevel };
		this._ctx = ctx;
		this._ui = ctx?.ui;
	}

	/** Create a child logger with a combined source name */
	child(suffix: string): Logger {
		return new Logger(`${this.source}:${suffix}`, this._config.minLevel, this._ctx, this._config);
	}

	/** Set minimum log level dynamically */
	withLevel(level: LogLevel): Logger {
		return new Logger(this.source, level, this._ctx, this._config);
	}

	/** Route output to a specific TUI mode */
	withTUIRoute(mode: TUIRouteMode): Logger {
		return new Logger(this.source, this._config.minLevel, this._ctx, {
			...this._config,
			tuiRoute: mode,
		});
	}

	/** Suppress console output in TUI mode */
	withSuppressConsole(suppress: boolean): Logger {
		return new Logger(this.source, this._config.minLevel, this._ctx, {
			...this._config,
			suppressTUIConsole: suppress,
		});
	}

	private shouldLog(level: LogLevel): boolean {
		if (_globallySuppressed) return false;
		if (_suppressedSources.has(this.source)) return false;
		return _LEVEL_PRIORITY[level] >= _LEVEL_PRIORITY[this._config.minLevel];
	}

	private log(level: LogLevel, message: string, data?: unknown): void {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			source: this.source,
			message,
			data,
		};


		bufferEntry(entry);

		// Route to appropriate destination based on context
		this.routeToDestination(entry);
	}

	private routeToDestination(entry: LogEntry): void {
		const { level, message } = entry;
		const hasUI = this._ctx?.hasUI ?? false;
		const routeMode = this._config.tuiRoute;
		const suppressConsole = this._config.suppressTUIConsole;

		// Build the formatted message once
		const formatted = formatMessage(entry);

		if (hasUI) {
			// TUI mode
			if (routeMode === "silent") {
				// No output at all - just buffer
				return;
			}


			if (routeMode === "alerts-only") {
				// Only notify for warnings/errors, console for info/debug
				if (level === "error") {
					this._ui?.notify(message, "error");
				} else if (level === "warn") {
					this._ui?.notify(message, "warning");
				} else if (!suppressConsole) {
					// Info/debug goes to console (for debugging)
					this.emitToConsole(entry, formatted);
				}
				return;
			}

			// routeMode === "all" - everything goes to console
			if (!suppressConsole) {
				this.emitToConsole(entry, formatted);
			}
		} else {
			// Non-TUI mode: always use console
			this.emitToConsole(entry, formatted);
		}
	}

	private emitToConsole(entry: LogEntry, formatted: string): void {
		switch (entry.level) {
			case "debug":
				console.debug(formatted);
				break;
			case "info":
				console.info(formatted);
				break;
			case "warn":
				console.warn(formatted);
			break;
			case "error":
				console.error(formatted);
				break;
		}
	}

	debug(message: string, data?: unknown): void {
		this.log("debug", message, data);
	}

	info(message: string, data?: unknown): void {
		this.log("info", message, data);
	}

	warn(message: string, data?: unknown): void {
		this.log("warn", message, data);
	}

	error(message: string, data?: unknown): void {
		this.log("error", message, data);
	}

	/** Log with explicit level (useful for dynamic levels) */
	logAt(level: LogLevel, message: string, data?: unknown): void {
		this.log(level, message, data);
	}
}

// Factory

/**
 * Create a logger for a given source name.
 *
 * @param source - Identifier for the logging extension/module
 * @param ctx - Extension context (optional, enables TUI-aware logging)
 * @param minLevel - Minimum log level (default: "info")
 */
export function createLogger(
	source: string,
	ctx?: ExtensionContext,
	minLevel: LogLevel = "info",
): Logger {
	return new Logger(source, minLevel, ctx);
}

// Global configuration

/** Set global logger configuration */
export function setLoggerConfig(config: Partial<LoggerConfig>): void {
	_globalConfig = { ..._globalConfig, ...config };
}

/** Reset global config to defaults */
export function resetLoggerConfig(): void {
	_globalConfig = { ..._defaultConfig };
}

/** Suppress logging for a specific source (or all if no source provided) */
export function suppressLogger(source?: string): void {
	if (source) {
		_suppressedSources.add(source);
	} else {
		_globallySuppressed = true;
	}
}

/** Restore logging for a specific source (or all if no source provided) */
export function restoreLogger(source?: string): void {
	if (source) {
		_suppressedSources.delete(source);
	} else {
		_globallySuppressed = false;
	}
}

/** Get recent log entries for debugging */
export function getLogBuffer(limit = 50): LogEntry[] {
	return _logBuffer.slice(-limit);
}

/** Clear the log buffer */
export function clearLogBuffer(): void {
	_logBuffer.length = 0;
}

/**
 * Helper to wrap console.log/error/warn with source tagging.
 * Use this as a drop-in replacement for console in extensions.
 *
 * Returns an object with console-like methods that add [source] prefix.
 * Note: This bypasses TUI routing - use createLogger() for TUI-aware logging.
 * This is mainly for verbose debug output that should always go to console.
 */
export interface TaggedConsole {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
	assert: (condition?: boolean, ...data: unknown[]) => void;
	clear: () => void;
	count: (label?: string) => void;
	countReset: (label?: string) => void;
	dir: (obj: unknown, options?: unknown) => void;
	dirxml: (obj: unknown) => void;
	group: (...label: unknown[]) => void;
	groupEnd: () => void;
	groupCollapsed: (...label: unknown[]) => void;
	table: (tabularData: unknown) => void;
	time: (label?: string) => void;
	timeEnd: (label?: string) => void;
	timeLog: (label?: string, ...data: unknown[]) => void;
	trace: (...data: unknown[]) => void;
}

export function taggedConsole(source: string): TaggedConsole {
	const prefix = formatSource(source);
	return {
		log: (...args: unknown[]) => console.log(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		info: (...args: unknown[]) => console.info(prefix, ...args),
		debug: (...args: unknown[]) => console.debug(prefix, ...args),
		assert: console.assert.bind(console),
		clear: console.clear.bind(console),
		count: console.count.bind(console),
		countReset: console.countReset.bind(console),
		dir: console.dir.bind(console),
		dirxml: console.dirxml.bind(console),
		group: console.group.bind(console),
		groupEnd: console.groupEnd.bind(console),
		groupCollapsed: console.groupCollapsed.bind(console),
		table: console.table.bind(console),
		time: console.time.bind(console),
		timeEnd: console.timeEnd.bind(console),
		timeLog: console.timeLog.bind(console),
		trace: console.trace.bind(console),
	};
}

/** @deprecated Use createLogger() for TUI-aware logging. taggedConsole() is for verbose debug only. */
export { taggedConsole as consoleTagged }
