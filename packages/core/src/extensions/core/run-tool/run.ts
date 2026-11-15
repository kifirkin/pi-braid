/**
 * The execution core of the `run` tool: one program and its argv, no shell.
 *
 * What this module refuses is what a shell would have interpreted:
 *   - the five operators that make a command string a program (`|`, `&&`, `;`,
 *     a backtick, `$(`);
 *   - a shell invoked with a command string (`sh -c ...`), which is the same
 *     thing in a different spelling;
 *   - a glob at a path-segment boundary (`*.md`, `src/*`), because the caller
 *     passed an expression where a program expects a path.
 * A `*` inside an argument (a sed quantifier, a grep `--include` filter) is
 * not a boundary and is left to the program, which is where such a pattern
 * belongs.
 *
 * What it does not do is as load-bearing: no TTY, no shell profile, no glob
 * expansion, no environment invention. The child gets the caller's environment,
 * a stdin that ends (or the text the caller supplied), and stdout/stderr to
 * files so the bytes are exact and the memory is bounded. Both streams are
 * returned separately; each is capped, and the dropped bytes and the file that
 * holds the rest are named rather than dropped silently.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { findWorkspaceEscape } from "../../../lib/tools/workspace-guard.js";

/** setTimeout's own ceiling: a longer timeout cannot be armed. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The smallest cap worth reporting a window for. */
export const MIN_OUTPUT_BYTES = 1_024;

/** A cap past the harness's own structured-output budget buys nothing. */
export const MAX_OUTPUT_BYTES = 1_048_576;

/** Per stream, when the call names no cap: the harness's truncation default. */
export const DEFAULT_OUTPUT_BYTES = DEFAULT_MAX_BYTES;

/**
 * Verbs whose operand is destroyed or rewritten. The set is this tool's policy,
 * not the guard's: `git` will bring its own.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "dd",
  "chmod",
  "shred",
  "truncate",
]);

/** Programs that take a command string: `-c` makes one of them a shell again. */
const SHELL_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Shell operators that only mean something inside a shell. */
const SHELL_OPERATORS = ["&&", "$(", "|", ";", "`"] as const;

/** Longest argument quoted back in a refusal, so the message stays readable. */
const MAX_QUOTED_ARGUMENT = 160;

/** How far past a byte budget a read looks for a line boundary. */
const LINE_WINDOW_SLACK = 8 * 1024;

/** Share of the cap kept from the head; the tail keeps the rest. */
const HEAD_SHARE = 0.6;

/** A validated `run` call. */
export interface RunRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout_ms: number;
  max_output_bytes?: number;
}

/** Why a call never reached a program. */
export interface RunRefusal {
  kind:
    | "argv"
    | "metacharacter"
    | "shell-string"
    | "glob"
    | "timeout"
    | "output-cap"
    | "cwd"
    | "destructive-escape";
  message: string;
}

/** One stream after the cap was applied. */
export interface RunStream {
  /** What the result text shows. */
  text: string;
  /** Bytes the program wrote to this stream. */
  bytes: number;
  /** Bytes the text shows, before the omission marker. */
  shownBytes: number;
  /** Bytes the text does not show. */
  droppedBytes: number;
  /** Whether the cap applied. */
  truncated: boolean;
  /** The file holding the full stream; present when `truncated`. */
  fullTextPath?: string;
}

/** What one call captured, before the cap is applied to either stream. */
export interface RunCapture {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  cwd: string;
  argv: string[];
  /** Present when the child could not be spawned at all. */
  spawnError?: string;
  /** Full stdout, in a file this call owns. */
  stdoutPath: string;
  /** Full stderr, in a file this call owns. */
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** The capture directory, removed by `discardCapture`. */
  captureDir?: string;
}

/** Where a call runs, and what bounds its destructive verbs. */
export interface RunContext {
  /** Absolute directory the program runs in. */
  cwd: string;
  /** Boundary for the destructive guard. */
  workspaceRoot: string;
}

function quote(text: string): string {
  return text.length > MAX_QUOTED_ARGUMENT ? `${text.slice(0, MAX_QUOTED_ARGUMENT)}...` : text;
}

/**
 * A `*` at a path-segment boundary: the whole element, a leading `*.ext`, a
 * trailing directory wildcard, or a wildcard between two segments. A star
 * inside a word or a pattern is the program's business.
 */
export function isGlobExpression(element: string): boolean {
  if (!element.includes("*")) return false;
  return element.startsWith("*") || element.endsWith("*") || element.includes("/*");
}

/** The first element carrying a shell operator, or null. */
function findShellOperator(argv: readonly string[]): {
  index: number;
  operator: string;
} | null {
  for (let index = 0; index < argv.length; index++) {
    const element = argv[index];
    for (const operator of SHELL_OPERATORS) {
      if (element.includes(operator)) return { index, operator };
    }
  }
  return null;
}

/** Whether a shell program is being handed a command string. */
function isShellCommandString(argv: readonly string[]): boolean {
  if (!SHELL_PROGRAMS.has(basename(argv[0] ?? ""))) return false;
  return argv.slice(1).some((element) => {
    if (element === "--command") return true;
    // A short-flag cluster: -c, -ec, -lc. A long flag (--login) is not one.
    return /^-[A-Za-z]*c[A-Za-z]*$/.test(element);
  });
}

/**
 * Everything wrong with a call that can be known before a process starts: the
 * argv shape, shell operators, a shell command string, a glob, the timeout, the
 * cap, and a destructive verb reaching outside the workspace.
 *
 * Pure. The cwd is already resolved and its existence checked by the caller;
 * the workspace boundary is passed in.
 */
export function findRefusal(request: RunRequest, context: RunContext): RunRefusal | null {
  const { argv } = request;
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      kind: "argv",
      message:
        "refused: argv is required and must be non-empty. Pass the program as argv[0] and one element per argument.",
    };
  }
  if (argv.some((element) => typeof element !== "string" || element === "")) {
    return {
      kind: "argv",
      message:
        "refused: every argv element must be a non-empty string. An empty element cannot be passed to a program.",
    };
  }

  const operator = findShellOperator(argv);
  if (operator) {
    return {
      kind: "metacharacter",
      message:
        `refused: argv[${operator.index}] carries "${operator.operator}". ` +
        "run executes argv directly and never through a shell, so the operator would be a literal argument. " +
        `Argument: ${quote(argv[operator.index])}`,
    };
  }

  if (isShellCommandString(argv)) {
    return {
      kind: "shell-string",
      message:
        "refused: argv[0] is a shell and argv carries -c, so this is a command string rather than a program call. " +
        "run does not hand commands to a shell. Use bash, or pass the program and its arguments directly.",
    };
  }

  const glob = argv.slice(1).find(isGlobExpression);
  if (glob !== undefined) {
    return {
      kind: "glob",
      message:
        `refused: "${quote(glob)}" is a glob, and run does not expand globs. ` +
        "Pass the paths the glob would have matched, or use find or grep, which take patterns themselves.",
    };
  }

  const timeout = request.timeout_ms;
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    return {
      kind: "timeout",
      message:
        "refused: timeout_ms is required and must be a finite number of milliseconds. " +
        "A call with no timeout can hang the session.",
    };
  }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    return {
      kind: "timeout",
      message:
        `refused: timeout_ms must be an integer from 1 to ${MAX_TIMEOUT_MS}; got ${timeout}. ` +
        "A call with no timeout can hang the session.",
    };
  }

  if (request.max_output_bytes !== undefined) {
    const cap = request.max_output_bytes;
    if (!Number.isInteger(cap) || cap < MIN_OUTPUT_BYTES || cap > MAX_OUTPUT_BYTES) {
      return {
        kind: "output-cap",
        message: `refused: max_output_bytes must be an integer from ${MIN_OUTPUT_BYTES} to ${MAX_OUTPUT_BYTES}; got ${String(cap)}.`,
      };
    }
  }

  const escape = findWorkspaceEscape({
    verbs: DESTRUCTIVE_VERBS,
    argv,
    cwd: context.cwd,
    workspaceRoot: context.workspaceRoot,
  });
  if (escape) {
    return {
      kind: "destructive-escape",
      message:
        `refused: "${escape.verb}" names "${escape.path}", which resolves to ${escape.resolved}, ` +
        `outside the workspace ${escape.root}. A destructive verb is refused when a path argument leaves the workspace; use bash if that is intended.`,
    };
  }

  return null;
}

function statSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    // The capture file is created by this call and read after the child exits;
    // a vanished file reads as empty output rather than failing the result.
    return 0;
  }
}

/** Read into `buffer` from `fd`, closing the descriptor whatever happens. */
function readFrom(fd: number, buffer: Buffer, length: number, position: number): number {
  try {
    return readSync(fd, buffer, 0, length, position);
  } finally {
    closeSync(fd);
  }
}

/** Read the first `budget` bytes of a file, cut at a line boundary. */
function readHead(file: string, budget: number): string {
  const window = Math.min(Math.max(budget, 1) + LINE_WINDOW_SLACK, Math.max(statSize(file), 1));
  const buffer = Buffer.allocUnsafe(window);
  const read = readFrom(openSync(file, "r"), buffer, window, 0);
  const slice = buffer.subarray(0, read);
  const newline = slice.lastIndexOf(0x0a);
  const end = newline >= 0 && newline <= budget ? newline + 1 : Math.min(budget, read);
  return stripSplitCharacter(slice.subarray(0, end).toString("utf8"), "end");
}

/** Read the last `budget` bytes of a file, cut at a line boundary. */
function readTail(file: string, budget: number): string {
  const size = statSize(file);
  const start = Math.max(0, size - budget - LINE_WINDOW_SLACK);
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  const read = readFrom(openSync(file, "r"), buffer, length, start);
  const slice = buffer.subarray(0, read);
  const newline = slice.indexOf(0x0a);
  const offset = newline >= 0 && newline < slice.length ? newline + 1 : 0;
  const kept = slice.subarray(offset);
  const fromEnd = kept.subarray(Math.max(0, kept.length - budget));
  return stripSplitCharacter(fromEnd.toString("utf8"), "start");
}

/**
 * A byte window can cut a multi-byte character in half; a lone replacement
 * character at that edge is the cut, not the program's output.
 */
function stripSplitCharacter(text: string, edge: "start" | "end"): string {
  return edge === "end" ? text.replace(/\uFFFD$/, "") : text.replace(/^\uFFFD/, "");
}

/** Apply the byte cap to one captured stream, keeping a head and a tail. */
export function boundStream(file: string, cap: number, fullTextPath?: string): RunStream {
  const bytes = statSize(file);
  if (bytes <= cap) {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = bytes === 0 ? 0 : readFrom(openSync(file, "r"), buffer, bytes, 0);
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      bytes,
      shownBytes: read,
      droppedBytes: 0,
      truncated: false,
    };
  }

  const headBudget = Math.floor(cap * HEAD_SHARE);
  const tailBudget = cap - headBudget;
  const head = readHead(file, headBudget);
  const tail = readTail(file, tailBudget);
  const kept = Buffer.byteLength(head) + Buffer.byteLength(tail);
  const droppedBytes = Math.max(0, bytes - kept);
  const marker = `\n[... ${droppedBytes} bytes omitted ...]\n`;
  return {
    text: `${head}${marker}${tail}`,
    bytes,
    shownBytes: kept,
    droppedBytes,
    truncated: true,
    ...(fullTextPath ? { fullTextPath } : {}),
  };
}

/** Kill the child's process group, falling back to the child alone. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone, or the child never led one; fall through to
      // the direct kill so a single process is still terminated.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child exited between the timeout firing and this call; the exit
    // event already carries the result, so there is nothing left to stop.
  }
}

/**
 * Run one program. The caller has already refused the shapes that never reach a
 * program (see `findRefusal`) and resolved `context.cwd`.
 *
 * The child is spawned detached on POSIX so the timeout and an aborted tool call
 * kill the whole tree, not only the leader; stdout and stderr are files rather
 * than pipes, so a grandchild cannot hold the result open after the program
 * exits, and the capture is byte-exact without buffering the stream in memory.
 */
export async function executeArgv(
  request: RunRequest,
  context: RunContext,
  signal?: AbortSignal,
): Promise<RunCapture> {
  const cwd = resolve(context.cwd);
  const dir = mkdtempSync(join(tmpdir(), "pi-run-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");

  let child: ChildProcess;
  const startedAt = performance.now();
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(stdoutPath, "w");
    stderrFd = openSync(stderrPath, "w");
    child = spawn(request.argv[0], request.argv.slice(1), {
      cwd,
      env: { ...process.env, ...(request.env ?? {}) },
      // shell: false is the default; it is written out because "no shell" is
      // this tool's contract, not an inherited default a refactor could flip.
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", stdoutFd, stderrFd],
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }

  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;

  const exit = new Promise<{ code: number | null; signal: string | null }>((settle) => {
    let done = false;
    const finish = (code: number | null, killed: string | null) => {
      if (done) return;
      done = true;
      settle({ code, signal: killed });
    };
    child.once("exit", (code, killed) => finish(code, killed));
    child.once("error", (error) => {
      spawnError = `${(error as NodeJS.ErrnoException).code ?? "spawn"}: ${error.message}`;
      finish(null, null);
    });
  });

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  if (child.stdin) {
    child.stdin.on("error", () => {
      // A program may exit before reading its stdin; the write failure is then
      // the program's answer, reported through its exit code, not a tool error.
    });
    child.stdin.end(request.stdin ?? "");
  }

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, request.timeout_ms);

  // The timer and the abort listener belong to the wait, not to the call: they
  // are released when the wait settles, whichever way it settles.
  const result = await exit.finally(() => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  });

  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    aborted,
    durationMs: Math.round(performance.now() - startedAt),
    cwd,
    argv: request.argv,
    ...(spawnError === undefined ? {} : { spawnError }),
    stdoutPath,
    stderrPath,
    stdoutBytes: spawnError === undefined ? statSize(stdoutPath) : 0,
    stderrBytes: statSize(stderrPath),
    captureDir: dir,
  };
}

/** Remove the capture directory after the caller has offloaded what it needs. */
export function discardCapture(capture: RunCapture): void {
  if (capture.captureDir) {
    rmSync(capture.captureDir, { recursive: true, force: true });
  }
}

/** The capture file for one stream, while the capture directory still exists. */
export function capturePathFor(capture: RunCapture, stream: "stdout" | "stderr"): string {
  return stream === "stdout" ? capture.stdoutPath : capture.stderrPath;
}
