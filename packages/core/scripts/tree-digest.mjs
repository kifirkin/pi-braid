/**
 * A tree with no repository attests its evidence by content.
 *
 * `check-result.mjs` resolves `source_revision` against a repository, so a close
 * that ran where there is no repository had no honest value to write: a sha that
 * resolves nowhere is refused, and a bare `no-vcs` is not a shape the field
 * accepts. This is the third thing - a digest of what the tree holds, which the
 * gate recomputes instead of trusting the block.
 *
 * The digest is sha256 over one line per file, in path order:
 *
 *     <relpath>\0<size>\0<sha256 of the file's bytes>\n
 *
 * The size and the file's own hash are on the line so a rename cannot cancel a
 * content change: the same bytes at a different path are a different line, and a
 * line whose path is unchanged still moves when a byte does. The bytes are the
 * whole attestation, so a mode change, an empty directory, a timestamp and an
 * inode are invisible here - a tree whose permissions moved is the same tree,
 * and a digest that said otherwise would refuse an unchanged close.
 *
 * Reading is closest-first: a link is the string it points at, never the bytes
 * behind it. Following one would put content outside the root into the digest,
 * and a link cycle would put the walk in a loop.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Directories the walk skips whole, each with the reason it is not evidence.
 *
 * The list is data rather than a condition inside the walk, because a reader has
 * to be able to disagree with a name: a reason that lives beside the name is
 * reviewable, and the same reason buried in a branch is not.
 */
export const EXCLUDED_DIR_NAMES = new Map([
  [
    "node_modules",
    "an install is a copy of what the manifest names, so its bytes follow the registry and the resolver rather than the work",
  ],
  [
    ".git",
    "the object store is the repository's own record; hashing it makes this digest a revision by another name, and a tree with no repository has neither",
  ],
  [
    ".cache",
    "a cache is rebuilt from what it caches, so its bytes are a function of the box that ran the build, not of the tree",
  ],
  [
    "dist",
    "build output is generated from source the walk already covers, and a build still running changes it mid-walk",
  ],
  [
    "build",
    "the same output directory under the name the other packer uses",
  ],
]);

/**
 * NUL between fields, because no path may contain one: a path ending in what
 * looks like a size cannot forge a field boundary.
 */
const FIELD = "\0";

/** JS string order, not byte order: the comparison is specified by the language,
 *  so two machines sort the same list of paths the same way without agreeing on
 *  a filesystem encoding. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every failure this module raises is named, because the caller prints the
 *  message into a close transcript and a bare stack there names nothing. */
function failed(message) {
  const error = new Error(`tree-digest: ${message}`);
  error.name = "TreeDigestError";
  return error;
}

/**
 * The root `.gitignore`'s patterns, compiled once per walk.
 *
 * Git's own semantics are larger than this needs. A negation line re-includes
 * what an earlier line excluded, which turns a one-path-at-a-time test into an
 * ordered re-inclusion over the whole walk; `!` lines are skipped here for that
 * reason, and a tree that needs one spells the exception in EXCLUDED_DIR_NAMES.
 * What is honoured is what a `.gitignore` in a project with no repository
 * usually holds: a bare name or glob (matched at any depth, as git does), and a
 * path from the root.
 */
function readGitignore(root) {
  const file = join(root, ".gitignore");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // No .gitignore is the common case and not an error: there is nothing to
    // exclude beyond the constant list. Any other read failure is the tree's own
    // problem and is named rather than swallowed into a wrong digest.
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw failed(`cannot read .gitignore: ${error.message}`);
  }
  const patterns = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    // A trailing slash only marks the pattern as a directory name, and either
    // kind of name is excluded here: the walk has no reason to keep one form.
    const withoutTrailing = line.replace(/\/+$/, "");
    if (withoutTrailing === "") continue;
    // A pattern holding a slash is anchored at the root; a bare name or glob is
    // matched against every path's last segment, which is what git does with it.
    const anchored = withoutTrailing.startsWith("/") || withoutTrailing.includes("/");
    const body = withoutTrailing.replace(/^\/+/, "");
    if (body === "") continue;
    patterns.push({ anchored, regex: globToRegex(body) });
  }
  return patterns;
}

/**
 * A gitignore glob as an anchored regular expression.
 *
 * `**&#47;` is a directory prefix (`**&#47;x` matches `x` and `a/b/x`), a bare
 * `**` spans anything, `*` and `?` stay inside one segment, and every other
 * character is literal - including the `.`, `+` and parentheses a name may hold.
 */
function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const prefix = glob[i + 2] === "/";
        out += prefix ? "(?:.*/)?" : ".*";
        i += prefix ? 2 : 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
}

/** Whether one path the walk reached is excluded by the root `.gitignore`. */
function isIgnored(relPath, patterns) {
  if (patterns.length === 0) return false;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return patterns.some(({ anchored, regex }) =>
    regex.test(anchored ? relPath : name),
  );
}

/**
 * The entries the digest covers, in path order.
 *
 * @param {string} root directory to read
 * @returns {{ path: string, size: number, sha: string }[]}
 */
export function treeEntries(root) {
  const base = resolve(root);
  let stats;
  try {
    // The caller's own path is followed to find the tree it means: a root reached
    // through a link is the tree they asked for, and the no-follow rule is about
    // links the walk meets inside it.
    stats = statSync(base);
  } catch (error) {
    throw failed(`cannot read the tree at ${base}: ${error.message}`);
  }
  if (!stats.isDirectory()) throw failed(`${base} is not a directory`);
  const entries = [];
  collect(base, "", readGitignore(base), entries);
  return entries.sort(byPath);
}

/** Walk one directory. Recursion rather than a queue keeps the path prefix on the
 *  call that knows it, and the exclusion list bounds the depth a tree can force. */
function collect(dir, prefix, patterns, entries) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw failed(`cannot list ${prefix || "."}: ${error.message}`);
  }
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const relPath = prefix === "" ? child.name : `${prefix}/${child.name}`;
    const full = join(dir, child.name);
    // A link carrying an excluded name is that exclusion under another layout: a
    // package manager that links the install in place must not move the digest
    // when the store it names moves.
    const named = child.isDirectory() || child.isSymbolicLink();
    if (named && EXCLUDED_DIR_NAMES.has(child.name)) continue;
    if (isIgnored(relPath, patterns)) continue;
    if (child.isSymbolicLink()) {
      entries.push(linkEntry(full, relPath));
      continue;
    }
    if (child.isDirectory()) {
      collect(full, relPath, patterns, entries);
      continue;
    }
    // A worktree's `.git` is a file holding the path of the store it points at,
    // not a directory: it is the record the directory exclusion drops, and its
    // contents say where the tree lives rather than what it holds.
    if (child.name === ".git") continue;
    // A socket, a fifo or a device has no bytes to hash, and reading one blocks
    // until something on the other end speaks: a tree holding one is hashed
    // without it rather than left waiting.
    if (!child.isFile()) continue;
    entries.push(fileEntry(full, relPath));
  }
}

function fileEntry(full, relPath) {
  let bytes;
  try {
    bytes = readFileSync(full);
  } catch (error) {
    throw failed(`cannot read ${relPath}: ${error.message}`);
  }
  return { path: relPath, size: bytes.length, sha: sha256(bytes) };
}

/** A link's hash covers the string it points at, so the digest moves when the
 *  target moves and stays still when the bytes behind an unchanged target do. */
function linkEntry(full, relPath) {
  let target;
  try {
    target = readlinkSync(full);
  } catch (error) {
    throw failed(`cannot read the link ${relPath}: ${error.message}`);
  }
  const bytes = Buffer.from(target, "utf8");
  return { path: relPath, size: bytes.length, sha: sha256(bytes) };
}

/**
 * sha256 over the documented lines, in the order the entries are given; the
 * caller sorts. Split from the walk so a caller holding a subset (a diff, a
 * filtered list) hashes it with the same bytes the full tree does.
 *
 * @param {{ path: string, size: number, sha: string }[]} entries
 * @returns {string} 64 lowercase hex characters
 */
export function digestLines(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.path}${FIELD}${entry.size}${FIELD}${entry.sha}\n`);
  }
  return hash.digest("hex");
}

/** The digest of a tree, which is what a block's `tree:<64 hex>` has to equal. */
export function treeDigest(root) {
  return digestLines(treeEntries(root));
}
