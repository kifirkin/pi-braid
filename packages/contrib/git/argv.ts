/**
 * The policy half of the `git` tool: which subcommands read, which argument
 * shapes are refused outright, and how a call becomes an argv array.
 *
 * Nothing here starts a process. The executor in `index.ts` adds the spawn and
 * nothing else, so every decision below is testable without git installed.
 *
 * Policy is data: `READ_SUBS`, `READ_ONLY_WITH`, `MUTATING_TOKENS` and
 * `REFUSALS` are exported tables, so a reader and a test consult the same list
 * the tool obeys instead of inferring it from branches.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// ── output and time limits ─────────────────────────────────────────────────

export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const MIN_MAX_OUTPUT_BYTES = 1_024;
export const MAX_MAX_OUTPUT_BYTES = 1_048_576;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;

// ── the read set ───────────────────────────────────────────────────────────

/** Subcommands that only read. A call naming one runs without `write`. */
export const READ_SUBS: readonly string[] = [
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "branch",
  "remote",
  "tag",
  "describe",
  "shortlog",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-list",
  "merge-base",
  "for-each-ref",
  "name-rev",
  "show-ref",
];

/**
 * A read set entry that reads only in part of its shapes. Present here means
 * the argument list decides; an entry present in the list is a token that
 * proves the read, and its absence makes the call a write.
 */
export const READ_ONLY_WITH: Record<string, readonly string[]> = {
  // `git config user.name x` writes; `git config --get user.name` reads.
  config: ["--get", "--get-all", "--get-regexp", "--list", "-l"],
};

/**
 * A read set entry whose default shape is a question and whose argument carries
 * the answer: any of these tokens turns the call into a write. The `branch`,
 * `tag` and `remote` verbs are the ones an agent reaches for by habit.
 */
export const MUTATING_TOKENS: Record<string, readonly string[]> = {
  branch: [
    "-d",
    "-D",
    "--delete",
    "-m",
    "-M",
    "--move",
    "-c",
    "-C",
    "--copy",
    "-f",
    "--force",
    "-u",
    "--set-upstream-to",
    "--unset-upstream",
    "--edit-description",
    "--track",
    "--no-track",
  ],
  tag: [
    "-d",
    "--delete",
    "-a",
    "--annotate",
    "-f",
    "--force",
    "-s",
    "--sign",
    "-m",
    "-F",
    "-u",
    "--edit",
    "--create-reflog",
  ],
  remote: [
    "add",
    "remove",
    "rm",
    "rename",
    "set-url",
    "set-head",
    "set-branches",
    "prune",
    "update",
  ],
};

/**
 * Flags whose next argument is a value, so that value is not a positional.
 * `git branch --contains HEAD` stays a read; `git branch new-branch` does not.
 */
export const VALUE_FLAGS: Record<string, readonly string[]> = {
  branch: [
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
    "--format",
    "--sort",
  ],
  tag: [
    "-l",
    "--list",
    "-n",
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
    "--format",
    "--sort",
  ],
  remote: [],
  config: [],
};

// ── the refusal table ──────────────────────────────────────────────────────

/**
 * One row per shape the tool will not run. `requires` is a conjunction of
 * groups and a group is a disjunction of tokens: every group must match for the
 * row to fire. A single-dash short flag matches a cluster too, so `-fdx`
 * satisfies both `-f` and `-d`.
 *
 * `guard: "branch-merged"` names a row whose refusal depends on repository
 * state: the executor settles it with the read-only probe in `BRANCH_MERGED_PROBE`
 * and, when the branch is merged, replans the same call with the row skipped.
 */
export interface RefusalRule {
  readonly id: string;
  readonly sub: string;
  readonly requires: readonly (readonly string[])[];
  readonly guard?: "branch-merged";
  readonly message: string;
}

export const REFUSALS: readonly RefusalRule[] = [
  {
    id: "push-force",
    sub: "push",
    // `--force` and `-f` are one flag in two spellings, so one message serves
    // both; the fixture drives each spelling through it.
    requires: [["--force", "-f"]],
    message:
      "refused: a force-push rewrites a remote branch and the previous tip is " +
      "not recoverable from this side. Run it yourself if that is what you mean.",
  },
  {
    id: "reset-hard",
    sub: "reset",
    requires: [["--hard"]],
    message:
      "refused: `git reset --hard` discards uncommitted work in the worktree. " +
      "Commit or stash it, or run the command yourself.",
  },
  {
    id: "clean-forced-ignored",
    sub: "clean",
    requires: [["-f", "--force"], ["-d"], ["-x"]],
    message:
      "refused: `git clean -fdx` also deletes ignored files and directories, " +
      "which are the ones a build or an editor regenerates and nothing else " +
      "lists. There is no recovery: git never tracked them.",
  },
  {
    id: "clean-forced-directories",
    sub: "clean",
    requires: [["-f", "--force"], ["-d"]],
    message:
      "refused: `git clean -fd` deletes every untracked file and whole " +
      "directories, with nothing in the index or the reflog to restore them " +
      "from. Remove the paths you mean, one at a time.",
  },
  {
    id: "reflog-expire",
    sub: "reflog",
    requires: [["expire"]],
    message:
      "refused: `git reflog expire` removes the recovery path for commits no " +
      "ref points at any more.",
  },
  {
    id: "gc-prune-now",
    sub: "gc",
    requires: [["--prune=now"]],
    message:
      "refused: `git gc --prune=now` deletes unreachable objects immediately, " +
      "instead of after the grace window that makes them recoverable.",
  },
  {
    id: "filter-branch",
    sub: "filter-branch",
    requires: [],
    message:
      "refused: `git filter-branch` rewrites history in place, including refs " +
      "this tool cannot see. Use git-filter-repo as a deliberate migration.",
  },
  {
    id: "filter-repo",
    sub: "filter-repo",
    requires: [],
    message:
      "refused: `git filter-repo` is a repository migration, not an edit; it " +
      "rewrites every ref and leaves the old objects unreachable.",
  },
  {
    id: "branch-delete-unmerged",
    sub: "branch",
    requires: [["-D"]],
    guard: "branch-merged",
    message:
      "refused: `<name>` is not merged into the current branch, so deleting it " +
      "drops the commits only it reaches. Merge it first, or delete it yourself.",
  },
];

/** The read-only probe that settles `guard: "branch-merged"`. */
export const BRANCH_MERGED_PROBE = ["branch", "--merged"] as const;

// ── the shell-free invariant ───────────────────────────────────────────────

/**
 * Characters that mean nothing to the git program and everything to a shell.
 * The tool passes argv elements straight to the process, so an element carrying
 * one of these is almost always a caller still composing a command string, and
 * it is refused rather than reinterpreted.
 */
const SHELL_METACHARACTER = /[|&;`$()<>\n\r]/;

export const SHELL_METACHARACTER_TEXT = "| & ; ` $ ( ) < > or a newline";

// ── inputs ─────────────────────────────────────────────────────────────────

export type Plan =
  | {
      readonly kind: "run";
      readonly argv: string[];
      readonly wrote: boolean;
      readonly cwd: string;
    }
  | {
      readonly kind: "guard";
      readonly code: string;
      readonly message: string;
      readonly branch: string;
    }
  | {
      readonly kind: "refuse";
      readonly code: string;
      readonly message: string;
    };

export interface PlanOptions {
  /** Refusal rows already settled, so a replanned call does not match them again. */
  readonly skipRefusals?: readonly string[];
}

// ── limit resolvers ────────────────────────────────────────────────────────

/**
 * A blank selector arrives as 0 after the framework's own argument conversion,
 * so a `?? default` read cannot tell it from a real zero; both resolvers treat
 * a non-positive or non-finite value as absent and clamp to the hard cap.
 */
export function resolveMaxOutputBytes(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (value <= 0) return DEFAULT_MAX_OUTPUT_BYTES;
  if (value < MIN_MAX_OUTPUT_BYTES) return MIN_MAX_OUTPUT_BYTES;
  if (value > MAX_MAX_OUTPUT_BYTES) return MAX_MAX_OUTPUT_BYTES;
  return Math.floor(value);
}

export function resolveTimeoutMs(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (value <= 0) return DEFAULT_TIMEOUT_MS;
  if (value < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (value > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(value);
}

// ── argument inspection ────────────────────────────────────────────────────

/** A single-dash token is a cluster: `-fdx` carries `-f` and `-d`. */
function carriesFlag(args: readonly string[], flag: string): boolean {
  for (const arg of args) {
    if (arg === flag) return true;
    if (
      flag.length === 2 &&
      flag[0] === "-" &&
      arg.length > 2 &&
      arg[0] === "-" &&
      arg[1] !== "-" &&
      arg.slice(1).includes(flag[1])
    ) {
      return true;
    }
  }
  return false;
}

/** Arguments that are values of a preceding `VALUE_FLAGS` entry, not positionals. */
function positionals(sub: string, args: readonly string[]): string[] {
  const valueFlags = VALUE_FLAGS[sub] ?? [];
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      if (valueFlags.includes(arg)) index++;
      continue;
    }
    found.push(arg);
  }
  return found;
}

/** The first element carrying a shell metacharacter, if any. */
export function findShellMetacharacter(
  sub: string,
  args: readonly string[],
): { element: string; character: string } | null {
  for (const element of [sub, ...args]) {
    const match = SHELL_METACHARACTER.exec(element);
    if (match) return { element, character: match[0] };
  }
  return null;
}

/** The rule a call matches, first row wins. */
export function matchedRefusal(
  sub: string,
  args: readonly string[],
  options: PlanOptions = {},
): RefusalRule | null {
  const skip = options.skipRefusals ?? [];
  for (const rule of REFUSALS) {
    if (rule.sub !== sub || skip.includes(rule.id)) continue;
    const fires = rule.requires.every((group) =>
      group.some((token) =>
        token.startsWith("--") || token.length > 2
          ? args.includes(token)
          : carriesFlag(args, token),
      ),
    );
    if (fires) return rule;
  }
  return null;
}

/** The branch a `branch -D <name>` deletes, or null for any other call. */
export function deletedBranchName(args: readonly string[]): string | null {
  return positionals("branch", args)[0] ?? null;
}

/**
 * True when the call needs `write: true`: outside the read set, a read-set entry
 * whose shape mutates, or an argument the subcommand's words do not explain.
 */
export function requiresWrite(sub: string, args: readonly string[]): boolean {
  const readOnlyWith = READ_ONLY_WITH[sub];
  if (readOnlyWith) return !readOnlyWith.some((token) => args.includes(token));
  if (!READ_SUBS.includes(sub)) return true;
  const mutating = MUTATING_TOKENS[sub];
  if (!mutating) return false;
  return (
    mutating.some((token) => carriesFlag(args, token)) ||
    positionals(sub, args).length > 0 ||
    args.some((arg) => mutating.includes(arg))
  );
}

// ── cwd containment ────────────────────────────────────────────────────────

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The tree a call may touch: the workspace (`process.cwd()`) or a directory
 * under the caller's own `$HOME`. Anything else is refused with the resolved
 * path, which is the whole diagnosis a `..` escape needs.
 */
export function resolveCwd(
  raw: unknown,
  workspace = process.cwd(),
):
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly message: string } {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return { ok: false, message: `cwd must be a string (got ${typeof raw}).` };
  }
  const requested = typeof raw === "string" && raw.length > 0 ? raw : workspace;
  const cwd = realpathOrResolved(
    isAbsolute(requested) ? requested : join(workspace, requested),
  );
  const roots = [realpathOrResolved(workspace), realpathOrResolved(homedir())];
  const allowed = roots.some((root) => isInside(root, cwd));
  if (!allowed) {
    return {
      ok: false,
      message:
        `cwd resolves to ${cwd}, which is outside the workspace (${roots[0]}) ` +
        `and outside $HOME (${roots[1]}). Point cwd at a directory inside one of them.`,
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && uid !== 0) {
    try {
      const owner = statSync(cwd).uid;
      if (owner !== uid) {
        return {
          ok: false,
          message: `cwd resolves to ${cwd}, which is owned by uid ${owner}, not by this process (uid ${uid}).`,
        };
      }
    } catch {
      // A path that does not exist yet is git's to report, not ours to refuse.
    }
  }
  return { ok: true, cwd };
}

// ── the plan ───────────────────────────────────────────────────────────────

const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/**
 * Decide a call: refuse it, ask the executor to settle one guard, or hand back
 * the argv array to run. Every refusal but the branch guard is decided here,
 * before a process exists.
 */
export function planCall(input: unknown, options: PlanOptions = {}): Plan {
  const params = (input ?? {}) as Record<string, unknown>;
  const sub = params.sub;
  if (typeof sub !== "string" || !SUBCOMMAND.test(sub)) {
    return {
      kind: "refuse",
      code: "subcommand-shape",
      message:
        `sub must be a git subcommand word such as "status" or "log" ` +
        `(got ${JSON.stringify(sub)}).`,
    };
  }
  const rawArgs = params.args ?? [];
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.some((arg) => typeof arg !== "string")
  ) {
    return {
      kind: "refuse",
      code: "args-shape",
      message: "args must be an array of strings, one argv element each.",
    };
  }
  const args = rawArgs as string[];
  const write = params.write === true;

  const metacharacter = findShellMetacharacter(sub, args);
  if (metacharacter) {
    return {
      kind: "refuse",
      code: "shell-metacharacter",
      message:
        `refused: the argument ${JSON.stringify(metacharacter.element)} carries the ` +
        `shell metacharacter "${metacharacter.character}". Arguments are passed as an ` +
        `argv array, never joined into a command string, so ${SHELL_METACHARACTER_TEXT} ` +
        `are not allowed in any element. Pass one element per argument.`,
    };
  }

  const rule = matchedRefusal(sub, args, options);
  if (rule) {
    if (rule.guard === "branch-merged") {
      const branch = deletedBranchName(args) ?? "";
      return {
        kind: "guard",
        code: rule.id,
        message: rule.message.replace("<name>", branch || "the branch"),
        branch,
      };
    }
    return {
      kind: "refuse",
      code: rule.id,
      message: `git ${sub}: ${rule.message}`,
    };
  }

  if (sub === "push") {
    if (!write) {
      return {
        kind: "refuse",
        code: "push-needs-write",
        message:
          `refused: git push needs write: true, and no remote is touched without it. ` +
          `Add write: true to the call.`,
      };
    }
    if (positionals(sub, args).length === 0) {
      return {
        kind: "refuse",
        code: "push-needs-remote",
        message:
          `refused: git push needs a named remote. Name it as the first positional ` +
          `argument, as in { sub: "push", args: ["origin", "main"], write: true }.`,
      };
    }
  }

  const wrote = requiresWrite(sub, args);
  if (wrote && !write) {
    return {
      kind: "refuse",
      code: "write-not-granted",
      message:
        `refused: "${sub}" is not a read-only subcommand here, and it changes the ` +
        `repository. Add write: true to the call; a write also needs a clean tree.`,
    };
  }

  const resolved = resolveCwd(params.cwd);
  if (!resolved.ok) {
    return {
      kind: "refuse",
      code: "cwd-outside-workspace",
      message: resolved.message,
    };
  }

  return { kind: "run", argv: [sub, ...args], wrote, cwd: resolved.cwd };
}

/** The probe a `guard` plan needs, as an argv array. */
export const branchMergedProbeArgv = (): string[] => [...BRANCH_MERGED_PROBE];

/** True when `git branch --merged` output lists the named branch. */
export function probeShowsBranch(probeStdout: string, branch: string): boolean {
  return probeStdout
    .split("\n")
    .map((line) => line.trim().replace(/^[*+]\s*/, ""))
    .some((line) => line === branch);
}
