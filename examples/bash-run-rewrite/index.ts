/**
 * bash-run rewrite: a plain command executes as `run`, everything else stays bash.
 *
 * A bash call that is one program followed by plain words needs no shell to be
 * interpreted: bash splits the text on spaces and execs exactly those words. The
 * `run` tool takes that word list as `argv` and execs the same program with the
 * same arguments, without a shell in between. This extension makes that
 * conversion where the call is decided, so the caller does not have to remember
 * which tool the call belongs to: the tool keeps the name `bash`, and a call
 * written for bash still lands here.
 *
 * Why a replacement tool and not a `tool_call` hook: pi hands a `tool_call`
 * handler the argument object and executes the tool it already resolved, and a
 * handler can only block, never return a result. A tool registered under a
 * built-in name replaces that definition, which is the one seam that can change
 * which tool runs. `bash-cwd` in the core extensions uses the same seam.
 *
 * What is not converted is not converted loudly: the call runs through pi's own
 * bash definition exactly as it would have without this extension. A refusal is
 * never a partial guess - the whitelist below is the whole argument, and the
 * fixture beside `test-bash-run-rewrite.mjs` holds one case per shell feature it
 * refuses, plus a probe in which bash itself tokenizes the same text.
 *
 * The one bound the rewrite introduces: `run` requires `timeout_ms`, and bash's
 * `timeout` is optional. A call that names one keeps it - the same seconds-to-
 * milliseconds conversion pi's bash applies - and a call that names none gets
 * 120000 ms where bash had no bound at all. `bash-run-rewrite/README.md` lists
 * the remaining differences.
 */

import { accessSync, constants, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

/** The tool this extension replaces. */
const BASH_TOOL = "bash";

/** The tool a converted call runs. */
const RUN_TOOL = "run";

/** The custom entry type this extension writes into the session record. */
const RECORD = "bash-run-rewrite";

/** The one line an operator sees when the first rewrite of a session fires. */
export const NOTICE = "bash-run rewrite: a plain command executes as run";

/** Milliseconds a converted call gets, since `run` requires a bound. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** `setTimeout`'s own ceiling, which `run`'s field refuses past. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Characters a word may carry and still reach the program literally. Everything
 * outside this set has a meaning to bash (quoting, expansion, globbing,
 * redirection, operators, tests, comments, brace and tilde expansion), so a
 * command carrying one is left to the shell. The set is positive on purpose: a
 * character added here is a claim that bash passes it through untouched, and
 * the fixture proves that claim against bash itself.
 */
const WORD_CHARACTERS = "A-Za-z0-9._/:@+,%=%-";

/** One character from that set; the scan below tests a word character by character. */
const WORD_CHARACTER = new RegExp(`^[${WORD_CHARACTERS}]$`);

/** What separates the directories `PATH` searches. */
const PATH_SEPARATOR = ":";

/** A word bash would read as an assignment when it opens the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Words that are not a program: shell builtins, reserved words and shell names.
 * `run` execs argv[0], so any of these would either fail to start or run a
 * different program than the shell would have run (a builtin is not a file, and
 * a shell name with `-c` is refused by `run` on purpose).
 */
const SHELL_WORDS: ReadonlySet<string> = new Set([
  // builtins
  ":",
  ".",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
  // reserved words
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
  // shells, which `run` refuses as a command string
  "bash",
  "dash",
  "fish",
  "ksh",
  "sh",
  "zsh",
]);

/** Why a call stays bash. */
export type RefusalCode =
  | "empty"
  | "whitespace"
  | "character"
  | "assignment"
  | "builtin"
  | "timeout"
  | "not-a-program"
  | "not-on-path";

/** A refusal, with the character or word that decided it where there is one. */
export interface Refusal {
  readonly code: RefusalCode;
  /** The offending character or word, when the code names one. */
  readonly detail?: string;
}

/** What the caller asked the bash tool, as far as the conversion reads it. */
export interface RewriteInput {
  /** The call's own timeout in seconds; carried over in milliseconds when whole. */
  readonly timeout?: unknown;
  /** Directory a path-shaped program is resolved against; defaults to the process cwd. */
  readonly cwd?: string;
  /** Whether the program is an executable file; injected by a fixture, disk by default. */
  readonly isExecutable?: (program: string) => boolean;
}

/** A converted call: the words bash would have passed, and the bound it runs under. */
export interface Conversion {
  readonly kind: "run";
  readonly argv: string[];
  readonly timeout_ms: number;
}

/** A call that stays with bash, and the rule that kept it there. */
export interface RefusalResult {
  readonly kind: "bash";
  readonly refusal: Refusal;
}

/**
 * The whole rewrite, as one pure function: a command string becomes the argv
 * `run` needs, or a refusal naming the rule that stopped it. Nothing here reads
 * the filesystem or the session, so the table is the fixture's subject.
 */
export function convert(
  command: string,
  input: RewriteInput = {},
): Conversion | RefusalResult {
  const bash = (refusal: Refusal): RefusalResult => ({ kind: "bash", refusal });

  if (input.timeout !== undefined && timeoutInMs(input.timeout) === null) {
    return bash({ code: "timeout" });
  }
  if (command === "") return bash({ code: "empty" });
  // Any whitespace other than the plain space this function splits on: a tab, a
  // newline, a carriage return. bash treats each as a separator too, and the
  // split below would not.
  if (/[^\S ]/.test(command)) {
    return bash({ code: "whitespace", detail: "tab or newline" });
  }
  // A space at either end or two in a row. bash collapses them; splitting on one
  // space would yield an empty word, so these calls keep their shell.
  if (command !== command.trim() || command.includes("  ")) {
    return bash({ code: "whitespace", detail: "space" });
  }

  const argv = command.split(" ");
  for (const word of argv) {
    for (const character of word) {
      if (!WORD_CHARACTER.test(character)) {
        return bash({ code: "character", detail: character });
      }
    }
  }

  if (ASSIGNMENT.test(argv[0]!)) {
    return bash({ code: "assignment", detail: argv[0] });
  }

  const program = argv[0]!;
  const name = basename(program);
  if (name === "" || name.startsWith("-")) {
    return bash({ code: "not-a-program", detail: program });
  }
  if (SHELL_WORDS.has(name)) return bash({ code: "builtin", detail: name });

  // The program has to be one this machine would actually start: bash looks it
  // up and fails with its own message, while `run` reports a spawn error, so a
  // name that resolves to nothing keeps the shell and its diagnosis.
  const cwd = input.cwd ?? process.cwd();
  const isExecutable =
    input.isExecutable ?? ((word: string) => resolvesToExecutable(word, cwd));
  if (!isExecutable(program))
    return bash({ code: "not-on-path", detail: program });

  return {
    kind: "run",
    argv,
    timeout_ms: timeoutInMs(input.timeout) ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * The call's own timeout in milliseconds, or null when it has no whole-
 * millisecond form. The conversion is the one pi's bash applies (`timeout *
 * 1000`), so a converted call is bounded exactly where bash would have been;
 * `run`'s field is an integer, so a fractional millisecond keeps the shell.
 */
function timeoutInMs(timeout: unknown): number | null {
  if (timeout === undefined) return null;
  const ms = Number(timeout) * 1000;
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) return null;
  return ms;
}

/** Whether a program word names an executable file: a path as given, else on `PATH`. */
function resolvesToExecutable(program: string, cwd: string): boolean {
  const candidates = program.includes("/")
    ? [resolve(cwd, program)]
    : (process.env.PATH ?? "")
        .split(PATH_SEPARATOR)
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, program));
  return candidates.some(isExecutableFile);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // A path that cannot be stat'd is not a program this call can start.
    return false;
  }
}

/**
 * pi's own bash arguments, plus `cwd`. The two shared ones are spelled the way
 * pi spells them; `cwd` is the argument the converted call passes through.
 */
const bashRunParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for this call only, relative to the session's current directory. It does not change the directory the next call inherits.",
    }),
  ),
});

export type BashRunParameters = Static<typeof bashRunParameters>;

/** Runs one call through pi's bash definition, as the tool would have. */
export type ShellExecutor = (
  toolCallId: string,
  params: BashRunParameters,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionToolContext,
) => Promise<AgentToolResult<unknown>>;

export interface BashRunRewriteOptions {
  /** Appends the rewrite record. Defaults to a no-op so a fixture can omit the API. */
  appendEntry?: (customType: string, data: unknown) => void;
  /** The shell path, injected by a fixture; defaults to pi's bash definition. */
  shell?: ShellExecutor;
  /** Directory pi's bash definition falls back to; defaults to `process.cwd()`. */
  fallbackCwd?: string;
}

/**
 * Rewrites counted per session, keyed by the session manager: that object lives
 * as long as the session does, so a new session starts the count at zero. Braid
 * extensions hold this in `getExtensionState`; this one loads standalone.
 */
const sessionCounts = new WeakMap<object, { rewrites: number }>();

function countFor(ctx: ExtensionToolContext): { rewrites: number } {
  const key = ctx.sessionManager as unknown as object;
  let count = sessionCounts.get(key);
  if (!count) {
    count = { rewrites: 0 };
    sessionCounts.set(key, count);
  }
  return count;
}

/** Whether the `run` tool is among the tools this call may reach. */
function runIsAvailable(ctx: ExtensionToolContext): boolean {
  return (ctx.tools ?? []).some((tool) => tool.name === RUN_TOOL);
}

/** The directory this call runs in, resolved the way `run` resolves `cwd`. */
function runDirectoryOf(
  ctx: ExtensionToolContext,
  params: BashRunParameters,
  fallbackCwd: string,
): string {
  return resolve(ctx.cwd ?? fallbackCwd, params.cwd ?? ".");
}

/**
 * The session record for a call that stayed bash: the class that kept it there,
 * plus the character for the one class where the character is the answer. The
 * command text is never written, so a refusal record cannot carry what a call
 * carried. `no-run-tool` is not a converter refusal: it says the rewrite had
 * nowhere to run, which is the census's other fact about a missed rewrite.
 */
function refusalRecord(
  code: RefusalCode | "no-run-tool",
  character?: string,
): Record<string, unknown> {
  return code === "character" && character !== undefined
    ? { refused: code, character }
    : { refused: code };
}

/** pi's bash definition, with the call's own directory pinned when it names one. */
function defaultShell(fallbackCwd: string): ShellExecutor {
  return async (toolCallId, params, signal, onUpdate, ctx) => {
    const definition = createBashToolDefinition(fallbackCwd, {
      spawnHook: ({ command, env }) => ({
        command,
        cwd: runDirectoryOf(ctx, params, fallbackCwd),
        env,
      }),
    });
    const result = await definition.execute(
      toolCallId,
      { command: params.command, timeout: params.timeout },
      signal,
      onUpdate as
        | AgentToolUpdateCallback<BashToolDetails | undefined>
        | undefined,
      ctx,
    );
    return result;
  };
}

export function createBashRunRewriteTool(
  options: BashRunRewriteOptions = {},
): ToolDefinition<typeof bashRunParameters> {
  const fallbackCwd = options.fallbackCwd ?? process.cwd();
  const shell = options.shell ?? defaultShell(fallbackCwd);
  const appendEntry = options.appendEntry ?? (() => {});

  return {
    name: BASH_TOOL,
    label: "bash",
    description:
      "Execute a bash command. A command that is one program followed by plain-word arguments is executed without a shell, through the `run` tool's argv path; every other command runs in the shell exactly as pi's bash tool runs it. Optionally provide a timeout in seconds; a converted call keeps that bound, and a call that names none runs under a fixed one.",
    parameters: bashRunParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(
      toolCallId: string,
      params: BashRunParameters,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      const conversion = convert(params.command, {
        timeout: params.timeout,
        cwd: runDirectoryOf(ctx, params, fallbackCwd),
      });
      // A call that stays bash says why, by class, so a census can report which
      // shell features keep work in the shell. Two conditions the pure function
      // cannot see decide the rest: the run tool has to be reachable from this
      // call, and a call with nowhere to run is the shell's problem.
      if (conversion.kind !== "run") {
        appendEntry(
          RECORD,
          refusalRecord(conversion.refusal.code, conversion.refusal.detail),
        );
        return shell(toolCallId, params, signal, onUpdate, ctx);
      }
      if (!runIsAvailable(ctx)) {
        appendEntry(RECORD, refusalRecord("no-run-tool"));
        return shell(toolCallId, params, signal, onUpdate, ctx);
      }

      const count = countFor(ctx);
      count.rewrites += 1;
      appendEntry(RECORD, {
        rewrites: count.rewrites,
        ...(count.rewrites === 1 ? { notice: NOTICE } : {}),
      });
      if (count.rewrites === 1) ctx.ui.notify(NOTICE, "info");

      const outcome = await ctx.executeTool(
        RUN_TOOL,
        {
          argv: conversion.argv,
          timeout_ms: conversion.timeout_ms,
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        },
        { signal, onUpdate },
      );
      return outcome.result;
    },
  };
}

export default function bashRunRewrite(pi: ExtensionAPI): void {
  pi.registerTool(
    createBashRunRewriteTool({
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    }),
  );
}
