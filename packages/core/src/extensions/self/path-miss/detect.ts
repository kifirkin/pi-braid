/**
 * Recognition of a missing-path tool failure, and the path it names.
 *
 * The shapes below are the ones the tools actually emit on this platform,
 * measured rather than invented:
 *
 *   read   ENOENT: no such file or directory, access '/x/y.ts'
 *   edit   Could not edit file: /x/y.ts. Error code: ENOENT.
 *   bash   ls: /x/y: No such file or directory
 *   bash   /bin/bash: line 0: cd: /x/y: No such file or directory
 *
 * Two of those carry a usable path in the call and the rest only in the text,
 * so the call wins when it has one: a path the model asked for is the path the
 * whisper should name, even when the tool's own wording echoes it loosely.
 *
 * Only a missing path is a path miss. A permission error, an unreadable file
 * or a failed assertion is a different failure with a different next move, and
 * steering toward `ls` there would cost a call without teaching anything.
 *
 * A localised runtime can spell the same failure in words these patterns do
 * not match. Node still prefixes its error with the errno token, so the token
 * is the locale-independent signal: a structured `code` when the event
 * carries one, otherwise the code word in the text. A failed call that yields
 * neither a recognised code nor a path is counted in `unattributed`, because
 * a detector that silently returns null cannot be told from one that never
 * ran.
 */

/** Tools whose failure can mean "the path was a guess". */
const PATH_BEARING_TOOLS = new Set(["read", "edit", "write", "bash"]);

/** Errnos that mean the path itself is missing. */
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Errno tokens the platform emits. The set is closed so a command's own
 * output cannot supply a token that is not an errno.
 */
const ERRNO_TOKEN =
  /\b(ENOENT|ENOTDIR|EACCES|EPERM|EISDIR|ELOOP|ENAMETOOLONG|ENOSPC|EMFILE|ENFILE|EIO)\b/;

/** The English wording a missing path uses when no code is available. */
const MISSING_PATH_PROSE = /no such file or directory/i;

/** A path quoted by a Node error: `ENOENT: ..., access '/x/y'`. */
const QUOTED_AFTER_SYSCALL =
  /\b(?:access|open|stat|lstat|scandir|opendir|unlink|readlink)\s+'([^']+)'/;

/** A shell builtin naming the directory it could not enter. */
const BASH_CD_TARGET = /(?:^|[:\s])cd:\s+(.+?):\s*no such file/i;

/** A program naming the operand it could not find: `ls: /x/y: No such file`. */
const PROGRAM_OPERAND = /([^\s:]+):\s*no such file or directory/i;

/** A bare errno (`ENOENT`), not a path. */
const ERRNO_ONLY = /^[A-Z][A-Z0-9_]*$/;

export interface PathMiss {
  /** The tool whose call missed. */
  tool: string;
  /** The path that was not there, as the tool or the call reported it. */
  path: string;
  /** The errno that classified the miss, when one was supplied or read. */
  code?: string;
}

export interface PathMissStats {
  /**
   * Failed calls by a path-bearing tool that produced no path: neither a
   * missing-path wording, nor a recognised errno, nor a path to name. A
   * rising count beside zero steers is a message shape this detector has
   * not learned, usually a localised runtime.
   */
  unattributed: number;
}

// Process-global on purpose: this counts message shapes the detector could
// not read across the whole process, not per-session state. The value only
// grows; resetting it at a session boundary would hide a fleet-wide shape.
let unattributed = 0;

/** The detector's counters, for a fixture or a diagnosis surface. */
export function getPathMissStats(): PathMissStats {
  return { unattributed };
}

/** Test hook: clear the counters. */
export function resetPathMissStats(): void {
  unattributed = 0;
}

/** The path the call itself asked for, when the tool takes one. */
function pathFromCall(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** The path an error message names, when the call did not carry one. */
function pathFromText(text: string): string | undefined {
  const candidates = [
    QUOTED_AFTER_SYSCALL.exec(text)?.[1],
    BASH_CD_TARGET.exec(text)?.[1],
    PROGRAM_OPERAND.exec(text)?.[1],
  ];
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (!path || ERRNO_ONLY.test(path)) continue;
    return path;
  }
  return undefined;
}

/** The errno token in the text, when it carries one. */
function errnoFromText(text: string): string | undefined {
  return ERRNO_TOKEN.exec(text)?.[1];
}

/**
 * The path a failed call missed, or null when this result is not a path miss.
 *
 * `code` is the structured errno when the event supplies one; it wins over
 * the text because a localised message can spell the same failure in words
 * this detector does not read. With no code, an errno token in the text is
 * the locale-independent half, and the English prose stays the fallback.
 */
export function detectPathMiss(
  toolName: string,
  input: unknown,
  text: string,
  code?: string,
): PathMiss | null {
  if (!PATH_BEARING_TOOLS.has(toolName)) return null;

  const errno = code?.toUpperCase() ?? errnoFromText(text);
  // A recognised errno that is not a missing path is a different failure.
  if (errno && !MISSING_PATH_CODES.has(errno)) return null;
  if (!errno && !MISSING_PATH_PROSE.test(text)) {
    unattributed++;
    return null;
  }

  const path = pathFromCall(input) ?? pathFromText(text);
  if (!path) {
    unattributed++;
    return null;
  }
  return { tool: toolName, path, ...(errno ? { code: errno } : {}) };
}
