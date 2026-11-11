/**
 * Git Tool — one git subcommand, from an argv array, read-only by default.
 *
 *   { sub: string, args?: string[], cwd?: string, write?: boolean,
 *     max_output_bytes?: number, timeout_ms?: number }
 *
 * Reads run unconditionally: status log diff show blame rev-parse branch remote
 * tag describe shortlog ls-files ls-tree cat-file rev-list merge-base
 * for-each-ref name-rev show-ref, and the `--get` / `--list` shapes of config.
 * Any other subcommand needs `write: true`, and a write also needs a clean tree
 * (`git status --porcelain` empty); a mutating call on a dirty tree is refused
 * naming the paths.
 *
 * Refused before anything runs: push --force / -f, reset --hard, clean -fd and
 * -fdx, reflog expire, gc --prune=now, filter-branch, filter-repo, and branch -D
 * on a branch not merged into the current one. push needs `write: true` and a
 * named remote. Arguments reach the process as an array; an element carrying a
 * shell metacharacter is refused. Output is capped (64 KiB default, 1 MiB max)
 * and truncation is reported, never silent; a non-zero exit is a result, not an
 * exception.
 *
 * Registration and the spawn only; the policy is `./argv.ts`, which imports
 * nothing from this package, so an upstream git tool replaces both files.
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  branchMergedProbeArgv,
  planCall,
  probeShowsBranch,
  resolveCwd,
  resolveMaxOutputBytes,
  resolveTimeoutMs,
} from "./argv.js";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const log = createLogger("git");

/**
 * Incremented by every process this tool starts. A refusal leaves it unchanged,
 * which is the assertion that a refused shape never reached the operating
 * system.
 */
export const processStarts = { count: 0 };

/** Paths named in a dirty-tree refusal before the list is summarized. */
const DIRTY_PATHS_SHOWN = 8;

interface RunLimits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

interface GitProcessOutcome {
  readonly exit: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

/**
 * Keeps the first `cap` bytes and counts the rest. Counting what was dropped is
 * the point: a caller that only learns "truncated" cannot tell 70 KiB from a
 * 900 MB blob, and execFile's own maxBuffer aborts the run and throws the kept
 * output away instead of reporting it.
 */
class ByteWindow {
  private readonly chunks: Buffer[] = [];
  private readonly cap: number;
  private kept = 0;
  total = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.kept >= this.cap) return;
    const take = Math.min(chunk.length, this.cap - this.kept);
    this.chunks.push(chunk.subarray(0, take));
    this.kept += take;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  keptBytes(): number {
    return this.kept;
  }
}

function keptLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines++;
  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1;
}

/** Environment for the child: no credential prompt, no pager, no optional lock. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

/**
 * Kills the child's whole process group. The direct child is a leader of its
 * own group (`detached`), so one signal reaches the hooks and helpers git
 * started as well; killing only the leader leaves a `sh -c` grandchild holding
 * the output pipes, and the run then waits for that grandchild instead of for
 * the timeout.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone: the exit and close listeners carry the result.
  }
}

function runGit(
  argv: readonly string[],
  cwd: string,
  limits: RunLimits,
): Promise<GitProcessOutcome> {
  return new Promise((settle) => {
    processStarts.count++;
    const child = spawn("git", argv as string[], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      detached: process.platform !== "win32",
    });
    const stdout = new ByteWindow(limits.maxOutputBytes);
    const stderr = new ByteWindow(limits.maxOutputBytes);
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    let exitSeen: { code: number | null; signal: string | null } | null = null;
    const timers: NodeJS.Timeout[] = [];

    const finish = (exit: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      for (const pending of timers) clearTimeout(pending);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        exit,
        signal,
        stdout: stdout.bytes(),
        stderr: stderr.bytes(),
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
        truncated:
          stdout.total > limits.maxOutputBytes ||
          stderr.total > limits.maxOutputBytes,
        timedOut,
        spawnError,
      });
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree(child, "SIGTERM");
        // A git process ignoring SIGTERM (a hook, a pager) must still end.
        timers.push(setTimeout(() => killTree(child, "SIGKILL"), 1_000));
        // And a process that outlives even SIGKILL, or one whose pipes a
        // survivor still holds, must not hold the tool: the captured output is
        // all this run can report.
        timers.push(
          setTimeout(() => finish(null, exitSeen?.signal ?? "SIGKILL"), 3_000),
        );
      }, limits.timeoutMs),
    );

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err: Error) => {
      spawnError = err.message;
      finish(null, null);
    });
    // `exit` fires when the direct child is gone; `close` waits for the pipes,
    // which a survivor can hold open. The first of the two settles the run.
    child.on("exit", (exit, signal) => {
      exitSeen = { code: exit, signal };
      finish(exit, signal);
    });
    child.on("close", (exit, signal) => {
      exitSeen = exitSeen ?? { code: exit, signal };
      finish(exitSeen.code, exitSeen.signal);
    });
  });
}

/** Display form only: elements are quoted for a reader, never for a shell. */
function displayArgv(argv: readonly string[]): string {
  return argv
    .map((element) =>
      /^[A-Za-z0-9._/:=@^~+-]+$/.test(element)
        ? element
        : `"${element.replace(/"/g, '\\"')}"`,
    )
    .join(" ");
}

interface CallParams {
  readonly sub: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

function refusal(
  code: string,
  message: string,
  call: CallParams,
  resolvedCwd: string | null,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: message }],
    details: {
      sub: call.sub,
      args: call.args,
      cwd: resolvedCwd,
      exit: null,
      signal: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      truncated: false,
      wrote: false,
      refused: code,
    },
  };
}

/** Names the paths a dirty-tree refusal depends on, summarized past the cap. */
function dirtyPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim() || line);
}

function dirtyTreeMessage(
  sub: string,
  cwd: string,
  paths: readonly string[],
): string {
  const shown = paths.slice(0, DIRTY_PATHS_SHOWN).join(", ");
  const rest =
    paths.length > DIRTY_PATHS_SHOWN
      ? `, and ${paths.length - DIRTY_PATHS_SHOWN} more`
      : "";
  return (
    `refused: "${sub}" changes the repository, and the tree at ${cwd} carries ` +
    `${paths.length} uncommitted path(s): ${shown}${rest}. ` +
    `A mutating call runs only on a clean tree, because that is the state where a ` +
    `tidy-up becomes someone's lost work. Commit or stash these paths first, then ` +
    `retry with write: true.`
  );
}

const gitSchema = Type.Object({
  sub: Type.String({
    description:
      'The git subcommand word, as in "status" or "log". One word, no flags.',
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Arguments as separate argv elements. Never a joined command string; " +
        "an element carrying a shell metacharacter is refused.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Directory to run in. Defaults to the workspace; must resolve inside the " +
        "workspace or inside $HOME.",
    }),
  ),
  write: Type.Optional(
    Type.Boolean({
      description:
        "Allow a subcommand outside the read set. Also requires a clean tree. " +
        "Defaults to false.",
    }),
  ),
  max_output_bytes: Type.Optional(
    Type.Number({
      description:
        `Output kept per stream, default ${DEFAULT_MAX_OUTPUT_BYTES}, cap ${MAX_MAX_OUTPUT_BYTES}; ` +
        "truncation is reported with the byte and line counts kept.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: `Kill the process after this long, default ${DEFAULT_TIMEOUT_MS} ms, cap ${MAX_TIMEOUT_MS} ms.`,
    }),
  ),
});

export default function gitExtension(pi: ExtensionAPI): void {
  const toggle = readToggleVerdict(["git"]);
  if (toggle.disabled) {
    log.info(
      `[git] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  pi.registerTool({
    name: "git",
    label: "Git",
    promptSnippet:
      "Run one git subcommand from an argv array, read-only by default",
    description:
      "Run one git subcommand with an argv array instead of a command string. " +
      "Read subcommands (status, log, diff, show, blame, rev-parse, branch, remote, " +
      "tag, describe, shortlog, ls-files, ls-tree, cat-file, rev-list, merge-base, " +
      "for-each-ref, name-rev, show-ref, config --get) run as they are; anything " +
      "else needs write: true and a clean tree. Force-push, reset --hard, clean -fd, " +
      "reflog expire, gc --prune=now, filter-branch, filter-repo and branch -D on an " +
      "unmerged branch are refused. Returns exit status, stdout, stderr, and " +
      "whether the output was truncated.",
    parameters: gitSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const limits: RunLimits = {
        maxOutputBytes: resolveMaxOutputBytes(params?.max_output_bytes),
        timeoutMs: resolveTimeoutMs(params?.timeout_ms),
      };
      const call: CallParams = {
        sub: typeof params?.sub === "string" ? params.sub : "",
        args: Array.isArray(params?.args) ? (params.args as string[]) : [],
        cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
      };

      let plan = planCall(params);

      if (plan.kind === "guard") {
        const resolved = resolveCwd(params?.cwd);
        if (!resolved.ok) {
          return refusal("cwd-outside-workspace", resolved.message, call, null);
        }
        const probe = await runGit(
          branchMergedProbeArgv(),
          resolved.cwd,
          limits,
        );
        if (probe.spawnError) {
          return refusal(
            plan.code,
            `refused: could not establish whether ${plan.branch} is merged ` +
              `(${probe.spawnError}). The call was not run.`,
            call,
            resolved.cwd,
          );
        }
        if (!probeShowsBranch(probe.stdout.toString("utf8"), plan.branch)) {
          return refusal(plan.code, plan.message, call, resolved.cwd);
        }
        plan = planCall(params, { skipRefusals: [plan.code] });
      }

      // A settled guard replans to a run or a different refusal; anything still
      // unsettled is refused rather than run.
      if (plan.kind !== "run") {
        return refusal(plan.code, plan.message, call, null);
      }

      if (plan.wrote) {
        const status = await runGit(
          ["status", "--porcelain"],
          plan.cwd,
          limits,
        );
        if (status.spawnError) {
          return refusal(
            "git-unavailable",
            `refused: a write needs a clean tree and \`git status\` could not ` +
              `establish one (${status.spawnError}).`,
            call,
            plan.cwd,
          );
        }
        const paths = dirtyPaths(status.stdout.toString("utf8"));
        if (paths.length > 0) {
          return refusal(
            "dirty-tree",
            dirtyTreeMessage(plan.argv[0], plan.cwd, paths),
            call,
            plan.cwd,
          );
        }
      }

      const outcome = await runGit(plan.argv, plan.cwd, limits);
      const stdoutText = outcome.stdout.toString("utf8").trimEnd();
      const stderrText = outcome.stderr.toString("utf8").trimEnd();
      const keptStdoutLines = keptLines(outcome.stdout);

      const body: string[] = [
        `$ git ${displayArgv(plan.argv)}  (cwd ${plan.cwd}, exit ${outcome.exit ?? "none"})`,
      ];
      if (stdoutText.length > 0) body.push("", stdoutText);
      if (stderrText.length > 0) body.push("", "[stderr]", stderrText);
      if (outcome.truncated) {
        body.push(
          "",
          `[truncated: kept ${outcome.stdout.length} of ${outcome.stdoutBytes} stdout bytes ` +
            `(${keptStdoutLines} lines) and ${outcome.stderr.length} of ` +
            `${outcome.stderrBytes} stderr bytes; raise max_output_bytes to read more]`,
        );
      }
      if (outcome.timedOut) {
        body.push(
          "",
          `[killed after ${limits.timeoutMs} ms: the process did not exit in time]`,
        );
      }
      if (outcome.spawnError) {
        body.push("", `[git could not be started: ${outcome.spawnError}]`);
      }

      return {
        content: [{ type: "text" as const, text: body.join("\n") }],
        details: {
          sub: plan.argv[0],
          args: plan.argv.slice(1),
          cwd: plan.cwd,
          exit: outcome.exit,
          signal: outcome.signal,
          stdout_bytes: outcome.stdoutBytes,
          stderr_bytes: outcome.stderrBytes,
          truncated: outcome.truncated,
          wrote: plan.wrote,
          stdout_kept_bytes: outcome.stdout.length,
          stderr_kept_bytes: outcome.stderr.length,
          stdout_kept_lines: keptStdoutLines,
          timed_out: outcome.timedOut,
          max_output_bytes: limits.maxOutputBytes,
          timeout_ms: limits.timeoutMs,
        },
      };
    },
  } as ToolDefinition<any, any, any>);

  log.info("[git] loaded: git");
}
