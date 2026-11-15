/**
 * Workspace escape guard for destructive argv.
 *
 * A tool that takes an argv list lets a caller name a path, and a verb that
 * removes or overwrites what it names turns a path typo into data loss. This
 * module answers one question for such a tool: does this argv carry a path
 * argument that resolves outside the workspace root?
 *
 * It is a mechanism, not a policy:
 *   - the destructive verb set is the caller's, passed in;
 *   - the workspace root and the invocation cwd are the caller's;
 *   - nothing here executes, refuses, rewrites or reports. The caller decides
 *     what to do with an escape, and its own message names the outcome.
 *
 * Resolution is canonical on both sides. The root and the target's nearest
 * existing ancestor go through realpath, so a symlink that lives inside the
 * workspace and points outside it is caught, while a target that does not exist
 * yet is compared by the canonical path of its parent. A target equal to the
 * root is an escape: removing or rewriting the workspace itself is outside the
 * set of things a single path argument may name.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

/** One path argument that resolves outside the workspace. */
export interface WorkspaceEscape {
  /** The program (argv[0]) whose verb the caller marked destructive. */
  verb: string;
  /** The argument as the caller wrote it. */
  argument: string;
  /** The path value read out of the argument (`of=` is read as its right side). */
  path: string;
  /** That path, canonical and absolute. */
  resolved: string;
  /** The workspace root, canonical and absolute. */
  root: string;
}

/** A candidate path value and the argument it was read from. */
interface Candidate {
  argument: string;
  path: string;
}

/**
 * Path values carried by an argv, read conservatively: every element after the
 * program that is not a flag, plus the right side of any `key=value` element
 * (`dd of=/etc/passwd`). A flag's own value (`-o /etc/x`) is not followed by the
 * scanner, which is why the caller keeps destructive verbs to the set whose
 * operands are positional or `key=value`; the guard never guesses at a program's
 * option grammar.
 */
export function pathCandidates(argv: readonly string[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const argument of argv.slice(1)) {
    if (argument === "" || argument === "--" || argument.startsWith("-")) continue;
    const eq = argument.indexOf("=");
    const path = eq >= 0 ? argument.slice(eq + 1) : argument;
    if (path === "") continue;
    candidates.push({ argument, path });
  }
  return candidates;
}

/** Canonical absolute path for a target, whether or not it exists yet. */
export function canonicalPath(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  // realpath the nearest existing ancestor, then re-attach the names that do
  // not exist yet. The loop is bounded by the filesystem's depth: each step
  // removes one segment.
  for (;;) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        // A path that exists but cannot be resolved (a race, a permission
        // boundary) is compared as written rather than skipped: a guard that
        // ignores what it cannot resolve is a guard that can be bypassed by
        // making the target unreadable.
        real = current;
      }
      return missing.length ? resolve(real, ...missing.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(current, ...missing.reverse());
    missing.push(basename(current));
    current = parent;
  }
}

/** Whether `target` is strictly below `root` after both are canonicalized. */
export function isBelow(root: string, target: string): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(target);
  return canonicalTarget.startsWith(canonicalRoot + sep);
}

/**
 * The first path argument, in argv order, that resolves outside the workspace.
 * Null when the program's verb is not in `verbs`, when no path argument escapes,
 * or when the argv carries no path argument at all.
 *
 * `cwd` is the directory the argv runs in, so relative operands are read the
 * way the program will read them. `workspaceRoot` is the boundary, which need
 * not be `cwd`: a call may run in a subdirectory and still be bounded by the
 * session's working directory.
 */
export function findWorkspaceEscape(options: {
  verbs: ReadonlySet<string>;
  argv: readonly string[];
  cwd: string;
  workspaceRoot: string;
}): WorkspaceEscape | null {
  const { verbs, argv, cwd, workspaceRoot } = options;
  const program = argv[0] ?? "";
  const verb = basename(program);
  if (!verbs.has(verb)) return null;
  const root = canonicalPath(workspaceRoot);
  for (const candidate of pathCandidates(argv)) {
    const target = isAbsolute(candidate.path) ? candidate.path : resolve(cwd, candidate.path);
    if (isBelow(root, target)) continue;
    return {
      verb,
      argument: candidate.argument,
      path: candidate.path,
      resolved: canonicalPath(target),
      root,
    };
  }
  return null;
}
