/**
 * The shell's working directory across calls.
 *
 * A `bash` call starts a fresh shell, so every directory the caller established
 * is gone by the next call. In the session corpus 48,841 of 70,530 calls spend
 * their opening tokens re-establishing it. This module is the state machine
 * behind the tool override: it decides where a call runs and what the next call
 * inherits. It holds no I/O, so the fixtures and the corpus replay drive the
 * same code the tool runs.
 *
 * The rules, in the order the tool applies them:
 *
 *   1. An explicit `cwd` argument decides where the call runs and never changes
 *      what the next call inherits.
 *   2. Otherwise the persisted directory decides, and with none the session's
 *      start directory does.
 *   3. After a call that exited 0, the last `cd` at a statement boundary in the
 *      command becomes the persisted directory, resolved against the directory
 *      that call ran in. A call that exited non-zero moves nothing: its `cd` is
 *      the one most likely not to have run, and persisting it would make the
 *      next call wrong in a way the caller cannot see.
 *
 * What the parser refuses matters as much as what it accepts. A `cd` inside a
 * subshell, a command substitution, a pipeline or a background job runs in
 * another process, so the shell this session keeps is not in that directory; a
 * `cd` inside a control-flow body or a function body may not have run at all;
 * and a `cd` whose argument needs the shell to expand it (`$VAR`, `~`, a glob,
 * an escape) leaves the text no longer naming a directory. Those parse to
 * nothing and the session keeps the directory it had. A wrong directory is worse
 * than a missing one.
 *
 * The scan is deliberately a scanner, not a shell parser: it tracks quotes,
 * comments, heredoc bodies, parenthesis and control-structure depth, and it
 * records only the `cd` words that open a statement. Everything else in a
 * command is text.
 */

import { resolve } from "node:path";

/** One session's directory state, carried in the tool's session-scoped state bucket. */
export interface SessionCwd {
  /** The directory pi gave the session. The state falls back here, and never drifts from it silently. */
  base: string;
  /** The directory the next call runs in. Equal to `base` until a successful `cd` moves it. */
  dir: string;
}

export function createSessionCwd(base: string): SessionCwd {
  return { base, dir: base };
}

/**
 * Follow a session-level cwd change. pi can hand one session a different
 * `ctx.cwd` (a resume into another tree); when it does, the shell state belongs
 * to the tree the session left, so it is reset rather than carried over.
 *
 * Returns true when the state moved.
 */
export function rebase(state: SessionCwd, sessionCwd: string): boolean {
  if (state.base === sessionCwd) return false;
  state.base = sessionCwd;
  state.dir = sessionCwd;
  return true;
}

/**
 * The directory this call runs in. A persisted directory that no longer exists
 * falls back to the session start: a removed directory is recoverable, a
 * silently wrong one is not. `stale` reports the fallback so the result can say
 * it out loud.
 */
export function resolveRunDirectory(
  state: SessionCwd,
  isDirectory: (path: string) => boolean,
): { dir: string; stale: boolean } {
  if (isDirectory(state.dir)) return { dir: state.dir, stale: false };
  state.dir = state.base;
  return { dir: state.base, stale: true };
}

/** A `cd` the parser is willing to act on: its argument, still unresolved. */
export interface ParsedCd {
  path: string;
}

/** How a statement was opened. A `cd` reached through `|`, `&` or `||` may not move this shell. */
type Opener = "start" | "&&" | ";" | "newline" | "||" | "pipe" | "background" | "paren";

/** A `cd` word found at a statement start, with the context that decides whether it counts. */
interface CdStatement {
  /** Offset just past the `cd` word. */
  argStart: number;
  opener: Opener;
  /** Parenthesis (subshell / command substitution / backtick) depth at this statement. */
  parenDepth: number;
  /** Control-structure (if/for/while/case/function/group) depth at this statement. */
  controlDepth: number;
}

interface ScanResult {
  cds: CdStatement[];
  /** The command contains a construct after which the text no longer states the final directory. */
  unreadable: boolean;
}

/** Words that open a control structure. A `cd` inside one may not have run. */
const CONTROL_OPENERS = new Set(["if", "for", "while", "until", "case", "select", "function"]);
/** Words that close one. */
const CONTROL_CLOSERS = new Set(["fi", "done", "esac"]);
/** Words that move the shell by a mechanism this scanner does not model. */
const DIRECTORY_WORDS = new Set(["pushd", "popd"]);

const WORD = /^[A-Za-z_][\w-]*/;

/**
 * Skip a heredoc body: read the delimiter, then advance past the line that ends
 * it. A body is data, so a `cd` inside one is not a command.
 */
function skipHeredoc(command: string, at: number): number {
  let i = at + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs) i++;
  while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;

  const quote = command[i];
  let delimiter: string;
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, i + 1);
    if (end === -1) return command.length;
    delimiter = command.slice(i + 1, end);
    i = end + 1;
  } else {
    let end = i;
    while (end < command.length && !/[\s;&|<>]/.test(command[end]!)) end++;
    delimiter = command.slice(i, end);
    i = end;
  }
  if (delimiter === "") return i;

  while (i < command.length && command[i] !== "\n") i++;
  i++;
  while (i < command.length) {
    let end = command.indexOf("\n", i);
    if (end === -1) end = command.length;
    const line = stripTabs ? command.slice(i, end).replace(/^\t+/, "") : command.slice(i, end);
    if (line === delimiter) return end + 1;
    i = end + 1;
  }
  return command.length;
}

/**
 * Walk the command once, outside quotes, and record the `cd` words that open a
 * statement plus whether anything appears that this scanner cannot follow.
 *
 * Quotes are tracked so a `cd` inside `git commit -m "x; cd y"` is text, not a
 * command; comments so `# cd /x` is a comment; heredocs so a body is data.
 */
function scan(command: string): ScanResult {
  const cds: CdStatement[] = [];
  let unreadable = false;
  let quote: '"' | "'" | null = null;
  let inBacktick = false;
  let parenDepth = 0;
  let controlDepth = 0;
  let atStatementStart = true;
  let opener: Opener = "start";
  let i = 0;

  while (i < command.length) {
    const ch = command[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") i += 2;
      else {
        if (ch === '"') quote = null;
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atStatementStart = false;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "\n") {
      atStatementStart = true;
      opener = "newline";
      i++;
      continue;
    }
    if (ch === ";") {
      atStatementStart = true;
      opener = ";";
      i++;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        atStatementStart = true;
        opener = "&&";
        i += 2;
      } else {
        atStatementStart = true;
        opener = "background";
        i++;
      }
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        atStatementStart = true;
        opener = "||";
        i += 2;
      } else {
        atStatementStart = true;
        opener = "pipe";
        i++;
      }
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      atStatementStart = true;
      opener = "paren";
      i++;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      atStatementStart = true;
      opener = ";";
      i++;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      parenDepth++;
      atStatementStart = true;
      opener = "paren";
      i += 2;
      continue;
    }
    if (ch === "`") {
      inBacktick = !inBacktick;
      parenDepth = Math.max(0, parenDepth + (inBacktick ? 1 : -1));
      atStatementStart = true;
      opener = "paren";
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        i += 3; // a herestring: no body to skip
      } else {
        i = skipHeredoc(command, i);
      }
      atStatementStart = false;
      continue;
    }
    if (ch === "#" && atStatementStart) {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }

    if (atStatementStart) {
      atStatementStart = false;
      if (ch === "{") {
        // A group or a function body: statements follow, so the scan stays at a
        // statement start, and a `cd` inside is not this shell's last word.
        controlDepth++;
        atStatementStart = true;
        i++;
        continue;
      }
      if (ch === "}") {
        controlDepth = Math.max(0, controlDepth - 1);
        atStatementStart = true;
        i++;
        continue;
      }
      const word = WORD.exec(command.slice(i))?.[0];
      if (word !== undefined) {
        const after = command[i + word.length];
        if (word === "cd" && (after === undefined || /[\s;&|)]/.test(after))) {
          cds.push({ argStart: i + word.length, opener, parenDepth, controlDepth });
        } else if (CONTROL_OPENERS.has(word)) {
          controlDepth++;
        } else if (CONTROL_CLOSERS.has(word)) {
          controlDepth = Math.max(0, controlDepth - 1);
        } else if (DIRECTORY_WORDS.has(word)) {
          unreadable = true;
        }
      }
    }
    i++;
  }

  // An unterminated quote means the rest of the text is a string whose end this
  // scan never saw: nothing after it can be read.
  if (quote !== null || inBacktick) unreadable = true;
  return { cds, unreadable };
}

/**
 * Read the argument word at `from`: a single- or double-quoted string, or a bare
 * word ending at whitespace or a shell operator. Returns undefined when there is
 * no argument.
 */
function readArgument(command: string, from: number): { token: string; end: number } | undefined {
  let i = from;
  while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;
  if (i >= command.length) return undefined;

  const quote = command[i];
  if (quote === "'" || quote === '"') {
    let j = i + 1;
    while (j < command.length && command[j] !== quote) j++;
    if (j >= command.length) return undefined;
    return { token: command.slice(i + 1, j), end: j + 1 };
  }

  let j = i;
  while (j < command.length && !/[\s;&|<>()]/.test(command[j]!)) j++;
  if (j === i) return undefined;
  return { token: command.slice(i, j), end: j };
}

/**
 * Whether the token is a path this module can resolve without the shell: not a
 * flag, and nothing the shell would expand (`$VAR`, `~`, a glob, a brace, an
 * escape).
 */
function isPlainPath(token: string): boolean {
  if (token === "") return false;
  if (token.startsWith("-")) return false;
  return !/[$`~*?[\]{}\\]/.test(token);
}

/**
 * The last `cd` a command performs, when the text says so without ambiguity.
 *
 * Returns undefined for anything the parser cannot stand behind, which is the
 * safe answer: the session keeps its directory and the caller's own `cd` still
 * runs, because a command is never rewritten.
 */
export function parseTrailingCd(command: string): ParsedCd | undefined {
  const { cds, unreadable } = scan(command);
  if (unreadable || cds.length === 0) return undefined;

  const cd = cds[cds.length - 1]!;
  if (cd.parenDepth > 0 || cd.controlDepth > 0) return undefined;
  if (cd.opener === "pipe" || cd.opener === "background" || cd.opener === "||") return undefined;

  const argument = readArgument(command, cd.argStart);
  if (argument === undefined || !isPlainPath(argument.token)) return undefined;

  // What follows the argument decides whether this `cd` is the one that moves
  // this shell. A pipe or a background job puts it in another process; a second
  // word means it was given more than one path and a `cd` that fails is a `cd`
  // that did not happen.
  let k = argument.end;
  while (k < command.length && (command[k] === " " || command[k] === "\t")) k++;
  const next = command[k];
  if (next === "|" && command[k + 1] !== "|") return undefined;
  if (next === "&" && command[k + 1] !== "&") return undefined;
  if (next !== undefined && !/[\n;&|<>#]/.test(next)) {
    if (!(/[0-9]/.test(next) && command[k + 1] === ">")) return undefined;
  }

  return { path: argument.token };
}

/** The absolute directory a parsed `cd` moves to, resolved the way the shell would have. */
export function resolveCdTarget(cd: ParsedCd, ranIn: string): string {
  return resolve(ranIn, cd.path);
}

export interface CwdNoteInput {
  /** The session's start directory. */
  base: string;
  /** The directory this call ran in. */
  ranIn: string;
  /** The directory the next call will inherit. */
  next: string;
  /** The persisted directory was gone and the call fell back to `base`. */
  stale: boolean;
  /** The call named its own `cwd`, so it did not run where the session is. */
  overridden: boolean;
}

/**
 * The line a result carries when the caller cannot assume the session start.
 * Omitted when the call ran in the start directory and the session is still
 * there, so the common first call stays byte-for-byte what it was.
 */
export function cwdNote(input: CwdNoteInput): string | undefined {
  const { base, ranIn, next, stale, overridden } = input;
  if (ranIn === next) {
    if (next !== base) return `[cwd ${next}]`;
    return stale ? `[cwd ${base} (the previous directory no longer exists)]` : undefined;
  }
  return overridden
    ? `[cwd ${ranIn}; the next call inherits ${next}]`
    : `[cwd ${ranIn} -> ${next}]`;
}
