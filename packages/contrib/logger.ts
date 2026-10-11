/**
 * Logger — structured logging for standalone pi-braid-contrib.
 *
 * Matches the pi-braid logger pattern (src/lib/core/logger.ts) while
 * staying standalone with no pi-braid dependency.
 *
 * Key behavior (matches pi-braid):
 *  - When a session context is bound via setLoggerContext(), all log lines
 *    route to ctx.ui.notify() instead of console — TUI-safe by default.
 *  - An in-memory buffer (last 200 entries) is always populated regardless
 *    of routing, retrievable for debugging.
 *  - Console output defaults to "none" (nothing writes to stdout) to
 *    protect pi's TUI cursor positioning. Lower to "info"/"warn"/"error"
 *    explicitly for verbose debugging sessions.
 *  - Format: `HH:mm:ss.mmm LEVEL  [source] message [data]` (same as pi-braid).
 *
 * Usage:
 *   const log = createLogger("my-ext");
 *   log.info("Progress update");
 *   log.warn("Something unexpected", { key: "val" });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type ConsoleLogLevel = LogLevel | "none";

/** Minimal shape compatible with ExtensionContext. Only needs `ui.notify`. */
export interface LoggerContext {
  ui?: {
    notify?: (
      message: string,
      notifyType?: "info" | "warning" | "error",
    ) => void;
  };
}

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

const _LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let _boundContext: LoggerContext | null = null;
const _suppressedSources = new Set<string>();
let _globalMinLevel: LogLevel = "info";
let _consoleMinLevel: ConsoleLogLevel = "none"; // TUI-safe default

const _logBuffer: LogEntry[] = [];
const MAX_BUFFER_SIZE = 200;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23); // HH:mm:ss.mmm
}

function formatLevel(level: LogLevel): string {
  return level.toUpperCase().padEnd(5);
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

function notifySeverityForLevel(level: LogLevel): "info" | "warning" | "error" {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  return "info";
}

function writeToConsole(entry: LogEntry): void {
  // When a logger context is bound, route through ctx.ui.notify so the
  // user sees the message as a TUI notification (NOT as stdout pollution
  // that would break TUI cursor positioning).
  if (_boundContext?.ui?.notify) {
    try {
      _boundContext.ui.notify(
        formatConsole(entry),
        notifySeverityForLevel(entry.level),
      );
    } catch {
      // Fall through to buffer-only below.
    }
    return;
  }

  // No ctx bound: fall back to console. By default _consoleMinLevel is
  // 'none' so nothing is written (TUI-safe). For explicit debug sessions
  // the user can call setConsoleLogLevel("info").
  if (_consoleMinLevel === "none") return;
  if (
    _LEVEL_PRIORITY[entry.level] < _LEVEL_PRIORITY[_consoleMinLevel as LogLevel]
  ) {
    return;
  }
  const line = formatConsole(entry);
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "info":
      console.info(line);
      break;
    case "debug":
      console.debug(line);
      break;
  }
}

function addToBuffer(entry: LogEntry): void {
  _logBuffer.push(entry);
  if (_logBuffer.length > MAX_BUFFER_SIZE) {
    _logBuffer.shift();
  }
}

class LoggerImpl implements Logger {
  private _source: string;

  constructor(source: string) {
    this._source = source;
  }

  private _shouldLog(level: LogLevel): boolean {
    if (_suppressedSources.has(this._source)) return false;
    return _LEVEL_PRIORITY[level] >= _LEVEL_PRIORITY[_globalMinLevel];
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

const _loggers = new Map<string, Logger>();

/**
 * Create (or retrieve) a named logger.
 * Loggers are cached by name — createLogger("foo") twice returns the same instance.
 */
export function createLogger(source: string): Logger {
  if (!_loggers.has(source)) {
    _loggers.set(source, new LoggerImpl(source));
  }
  return _loggers.get(source)!;
}

/**
 * Bind a context for log routing. When bound, log lines route to
 * ctx.ui.notify instead of console (TUI-safe). Pass null to unbind.
 *
 * Call from a session_start handler in your extension entry point:
 *
 *   pi.on("session_start", (_event, ctx) => { setLoggerContext(ctx); });
 *   pi.on("session_shutdown", (_event, _ctx) => { setLoggerContext(null); });
 *
 * NOTE: This is a single global binding. Pi runs one session per process,
 * so this is fine in practice.
 */
export function setLoggerContext(ctx: LoggerContext | null): void {
  _boundContext = ctx;
}

/** Suppress a specific source (e.g. during tests). */
export function suppressLogger(source: string): void {
  _suppressedSources.add(source);
}

/** Unsuppress a previously suppressed source. */
export function unsuppressLogger(source: string): void {
  _suppressedSources.delete(source);
}

/** Get all active logger source names. */
export function getActiveLoggerSources(): string[] {
  return Array.from(_loggers.keys());
}

/** Get the in-memory log buffer (for debugging). */
export function getLogBuffer(): readonly LogEntry[] {
  return _logBuffer;
}

/** Clear the in-memory log buffer. */
export function clearLogBuffer(): void {
  _logBuffer.length = 0;
}

/** Get formatted log buffer as string. */
export function formatLogBuffer(): string {
  return _logBuffer.map(formatConsole).join("\n");
}

/** Set the minimum log level globally. */
export function setGlobalLogLevel(level: LogLevel): void {
  _globalMinLevel = level;
}

/** Set the minimum level that writes to the process console.
 *  Default is "none" (TUI-safe). Lower to "info"/"warn"/"error"/"debug"
 *  for verbose debugging (may corrupt TUI rendering while active).
 *  The in-memory buffer is always populated. */
export function setConsoleLogLevel(level: ConsoleLogLevel): void {
  _consoleMinLevel = level;
}
