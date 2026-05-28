/**
 * Logger — Unified logging for pi-braid extensions
 *
 * Respects the pi Extension API:
 * - No ctx available (load time, lib code) → plain console
 * - ctx available with UI (interactive mode) → ctx.ui.notify() for warn/error
 * - ctx available without UI (RPC/print mode) → console only
 *
 * Usage:
 *   const log = createLogger("my-extension");
 *   log.warn("Something unexpected");
 *   log.info("Progress update");
 *
 * All output goes to console (warn/error) and in-memory buffer. Removed:
 * bindContext/unbindContext/hasContext — the context stack added complexity
 * for a single caller. Errors remain visible in console + log buffer.
 */



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

// formatNotify removed — only used by the removed writeToUI function.

// ── Core sink ──────────────────────────────────────────────────────────────

function writeToConsole(entry: LogEntry): void {
  if (_LEVEL_PRIORITY[entry.level] < _LEVEL_PRIORITY[_consoleMinLevel]) {
    return; // info/debug stay in buffer / TUI, don't spam the raw terminal
  }
  const line = formatConsole(entry);
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    default:
      // warn/info/debug: no raw console output — only ui.notify for warn/error
      break;
  }
}

// writeToUI removed — no longer needed after removing the context stack.
// All output routes through console + in-memory buffer.

function addToBuffer(entry: LogEntry): void {
  _logBuffer.push(entry);
  if (_logBuffer.length > MAX_BUFFER_SIZE) {
    _logBuffer.shift();
  }
}

// ── Logger factory ─────────────────────────────────────────────────────────

class LoggerImpl implements Logger {
  private _source: string;

  constructor(source: string) {
    this._source = source;
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
//   import { taggedConsole } from "../../lib/core/logger.js";
//   const log = taggedConsole("source");
// With:
//   import { createLogger } from "../../lib/core/logger.js";
//   const log = createLogger("source");
