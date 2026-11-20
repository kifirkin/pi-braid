/**
 * `bash`, with a working directory that survives the call.
 *
 * pi-core owns the shell tool and runs every call in `ctx.cwd`, so the directory
 * a caller established is gone by the next call. The tool cannot be wrapped from
 * outside that seam: pi's extension API lets a tool registered under a built-in
 * name replace it, and the replacement reuses pi's own definition for everything
 * else (its shell, its timeout, its output accumulator, its offload, its
 * renderers), delegating execution with a `spawnHook` that pins the directory
 * this call should run in. Nothing about the process execution is reimplemented
 * here.
 *
 * What changes is only the directory:
 *
 *   - this call runs in an explicit `cwd` that names a directory, else the
 *     session's persisted directory, else the session's start directory;
 *   - a `cwd` that names no directory at all is absent, not an override: a
 *     null, a blank string, and the two words a constrained generator emits when
 *     it means either, run the call where it would have run anyway;
 *   - a `cwd` that names a file is answered here in one line, naming the
 *     argument and what it resolved to, because the argument is this tool's own
 *     and the spawn it would reach reports ENOTDIR, a code that names neither;
 *   - a call that exited 0 leaves its last `cd` behind as the persisted
 *     directory, resolved against where the call ran;
 *   - a call that exited non-zero moves nothing, and a directory that no longer
 *     exists falls back to the session start;
 *   - a result that ran outside the start directory, or that moved the session,
 *     ends with one `[cwd ...]` line, so the state is visible to its inheritor.
 *
 * The state lives in the extension's session-scoped bucket, not in the prompt:
 * see `session-cwd.ts` for the rules and `AGENTS.md` beside this file for why
 * the rule is not a sentence asking callers to use absolute paths.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
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
import { getExtensionState } from "../../../lib/state/extension-state.js";
import {
  createSessionCwd,
  cwdNote,
  parseTrailingCd,
  rebase,
  resolveCdTarget,
  resolveRunDirectory,
} from "./session-cwd.js";
import type { SessionCwd } from "./session-cwd.js";

/** The state bucket key. One tool, one state object per session. */
const STATE_KEY = "bash-cwd";

/**
 * pi's own arguments, plus the one this tool adds. The shared two are spelled
 * the way pi spells them and a fixture compares them against pi's schema, so a
 * change upstream reddens here rather than drifting into two tool surfaces.
 */
const bashCwdParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  cwd: Type.Optional(
    // `{ anyOf: [{ type: "string" }, { type: "null" }] }` written as its own
    // keywords: the builder's named constructors have no null literal, and the
    // schema this hand-built object emits is plain JSON Schema.
    Type.Unsafe<string | null>({
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "Working directory for this call only, relative to the session's current directory. It does not change the directory the next call inherits; null means the same as omitting it.",
    }),
  ),
});

export type BashCwdParameters = Static<typeof bashCwdParameters>;

export interface BashCwdToolOptions {
  /** Directory the tool falls back to when the session has not named one. */
  fallbackCwd?: string;
  /** Filesystem check for a directory; defaults to `statSync`. Fixtures and the replay inject it. */
  isDirectory?: (path: string) => boolean;
}

function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A path that cannot be stat'd is not a directory this call can run in.
    return false;
  }
}

/**
 * The directory a `cwd` argument names, or undefined when it names none.
 *
 * The argument exists only because this tool adds it: pi's shell tool takes
 * `command` and `timeout`, so a value of the wrong shape is dropped there
 * without consequence and is acted on only here. That is what makes this the
 * one place that can tell a caller's directory from a value that means "no
 * directory": a null that reached the handler despite the schema, a string of
 * whitespace, and the two words a constrained generator emits when it means
 * either, in any capitalization. They run the call where it would have run
 * anyway rather than resolving a directory named after the word. Anything else
 * is passed through byte for byte, so a directory genuinely named `null` stays
 * reachable as `./null`.
 */
function requestedCwd(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim();
  if (word === "" || /^(?:null|undefined)$/i.test(word)) return undefined;
  return value;
}

/**
 * A path that exists and is not a directory.
 *
 * This is the one `cwd` failure this tool owes its caller: the argument is
 * resolved here, so the resolved path can be named here, while the spawn it
 * would otherwise reach fails with `ENOTDIR` - a code carrying neither the
 * argument nor the path - for a process that never started. A path that does
 * not exist keeps pi's own answer, which already names it.
 */
function existsButIsNotDirectory(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const DEFAULT_CWD = process.cwd();

export function createBashCwdTool(
  options: BashCwdToolOptions = {},
): ToolDefinition<typeof bashCwdParameters, BashToolDetails | undefined> {
  const fallbackCwd = options.fallbackCwd ?? DEFAULT_CWD;
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;

  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first); if truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. " +
      "The shell's working directory carries across calls: the last `cd` a successful command performed becomes the next call's directory, a relative `cd` resolves against the directory that call ran in, and a command that fails moves nothing. Pass `cwd` to run one call somewhere else without changing what the next call inherits. A result that ran outside the session's start directory ends with a `[cwd ...]` line naming it.",
    parameters: bashCwdParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(
      toolCallId: string,
      params: BashCwdParameters,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const sessionCwd = ctx.cwd ?? fallbackCwd;
      const state = getExtensionState<SessionCwd>(ctx, STATE_KEY, () =>
        createSessionCwd(sessionCwd),
      );
      rebase(state, sessionCwd);

      const { dir, stale } = resolveRunDirectory(state, isDirectory);
      const requested = requestedCwd(params.cwd);
      const overridden = requested !== undefined;
      const ranIn = overridden ? resolve(dir, requested) : dir;

      // Nothing has run yet, so a directory this call cannot enter is answerable
      // here, in the terms the caller gave: the argument as written and the path
      // it resolved to.
      if (overridden && existsButIsNotDirectory(ranIn)) {
        return {
          content: [
            { type: "text", text: `cwd ${JSON.stringify(requested)} is not a directory: ${ranIn}` },
          ],
          details: undefined,
          isError: true,
        };
      }

      // pi's definition owns the shell, the timeout, the output accumulator, the
      // offload and the renderers. The hook is the whole override: it pins the
      // directory this call was resolved to.
      const definition = createBashToolDefinition(fallbackCwd, {
        spawnHook: ({ command, env }) => ({ command, cwd: ranIn, env }),
      });
      const result = await definition.execute(
        toolCallId,
        { command: params.command, timeout: params.timeout },
        signal,
        onUpdate,
        ctx,
      );

      const structured = result.structuredContent as { exit_code?: number } | undefined;
      if (result.isError !== true && structured?.exit_code === 0) {
        const cd = parseTrailingCd(params.command);
        const target = cd === undefined ? undefined : resolveCdTarget(cd, ranIn);
        if (target !== undefined && isDirectory(target)) state.dir = target;
      }

      return withCwdNote(
        result,
        cwdNote({ base: state.base, ranIn, next: state.dir, stale, overridden }),
      );
    },
  };
}

/**
 * Append the note to the result's model-facing text. `details` and
 * `structuredContent` are left exactly as pi produced them, so the UI's
 * truncation rendering and the programmatic callers' shape do not change.
 */
function withCwdNote(
  result: AgentToolResult<BashToolDetails | undefined>,
  note: string | undefined,
): AgentToolResult<BashToolDetails | undefined> {
  if (note === undefined) return result;
  const content = [...result.content];
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!;
    if (block.type === "text") {
      content[i] = { type: "text", text: `${block.text}\n\n${note}` };
      return { ...result, content };
    }
  }
  content.push({ type: "text", text: note });
  return { ...result, content };
}

export default function bashCwdExtension(pi: ExtensionAPI): void {
  pi.registerTool(createBashCwdTool());
}
