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
 */

/** Tools whose failure can mean "the path was a guess". */
const PATH_BEARING_TOOLS = new Set(["read", "edit", "write", "bash"]);

/** The two spellings of "this path is not there" the tools emit. */
const MISSING_PATH = /ENOENT|no such file or directory/i;

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

/**
 * The path a failed call missed, or null when this result is not a path miss.
 */
export function detectPathMiss(toolName: string, input: unknown, text: string): PathMiss | null {
  if (!PATH_BEARING_TOOLS.has(toolName)) return null;
  if (!text || !MISSING_PATH.test(text)) return null;
  const path = pathFromCall(input) ?? pathFromText(text);
  if (!path) return null;
  return { tool: toolName, path };
}
