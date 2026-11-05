#!/usr/bin/env node
/**
 * prepare-worktree.mjs: create a git worktree that can run the suite it is for.
 *
 * A detached worktree carries the source and nothing else. The primary checkout
 * has `node_modules` at the root and, in this repo, package-local installs under
 * `packages/<pkg>/node_modules` (the providers package carries its own
 * typescript). Link only the root one and a chain that spawns a package-local
 * `tsc` fails with MODULE_NOT_FOUND for a reason the change under review is not:
 * three workers lost a chain run to that in one day, each of them concluding the
 * branch was broken. The invariant this script keeps: a worktree resolves every
 * module the primary resolves.
 *
 * It links each existing `node_modules` from the primary into the same relative
 * path in the worktree (never overwriting one), then proves the link by asking
 * node to resolve a real dependency from inside each package directory. A link
 * that exists is not evidence; a resolution that succeeds is.
 *
 * Usage:
 *   node packages/core/scripts/prepare-worktree.mjs --path <dir> --ref <branch|sha> [--primary <dir>]
 *
 * Exit: 0 ready, 1 git refused, 2 a module does not resolve in the worktree, 64 usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(code, message) {
  console.error(`prepare-worktree: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { path: null, ref: null, primary: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") out.path = argv[++i];
    else if (arg === "--ref") out.ref = argv[++i];
    else if (arg === "--primary") out.primary = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: prepare-worktree.mjs --path <dir> --ref <branch|sha> [--primary <dir>]");
      process.exit(0);
    } else fail(64, `unknown argument ${JSON.stringify(arg)}`);
  }
  if (!out.path) fail(64, "--path is required");
  if (!out.ref) fail(64, "--ref is required");
  return out;
}

/** The package directories in `root` that carry their own node_modules. */
function localInstalls(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesDir, name, "node_modules")))
    .map((name) => ({ rel: join("packages", name, "node_modules"), from: join("packages", name) }));
}

/** A directory inside a node_modules worth resolving: first real package, scope-aware. */
function probeName(nodeModules) {
  for (const entry of readdirSync(nodeModules, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const inner = readdirSync(join(nodeModules, entry.name), { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => child.name)
        .sort()[0];
      if (inner) return `${entry.name}/${inner}`;
      continue;
    }
    return entry.name;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const primary = resolve(args.primary || join(HERE, "..", "..", ".."));
const worktree = resolve(args.path);

try {
  if (existsSync(join(worktree, ".git"))) {
    console.log(`prepare-worktree: ${worktree} already holds a worktree, linking only`);
  } else {
    execFileSync("git", ["-C", primary, "worktree", "add", worktree, args.ref], { stdio: "inherit" });
  }
} catch (error) {
  fail(1, `git worktree add failed: ${error.message.split("\n")[0]}`);
}

const links = [{ rel: "node_modules", from: "." }, ...localInstalls(primary)];
const made = [];
for (const link of links) {
  const target = join(worktree, link.rel);
  if (!existsSync(join(primary, link.rel))) continue;
  try {
    lstatSync(target);
    continue; // present, whether a real directory or a link: never overwrite
  } catch {
    // absent, link it
  }
  symlinkSync(join(primary, link.rel), target);
  made.push(link);
}

let verified = 0;
for (const link of made) {
  const nodeModules = join(worktree, link.rel);
  const probe = probeName(nodeModules);
  if (!probe) continue;
  try {
    execFileSync(process.execPath, ["-e", "require.resolve(process.argv[1])", probe], {
      cwd: join(worktree, link.from),
      stdio: "pipe",
    });
    verified++;
  } catch {
    fail(2, `${probe} does not resolve from ${join(worktree, link.from)} although the link exists`);
  }
}

console.log(
  `prepare-worktree: ${worktree} ready at ${args.ref}, ${made.length} link(s) made, ${verified} probed by resolution`,
);
