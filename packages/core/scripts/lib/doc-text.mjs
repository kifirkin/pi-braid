/**
 * Shared markdown-reading helpers for the doc gates.
 *
 * check-doc-dates.mjs and check-prose-punctuation.mjs both scan the tracked
 * markdown set; these three helpers were byte-identical copies before the
 * extraction. `root` is passed in because each gate resolves the repo root
 * from its own location.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Markdown the gates must read: tracked files plus untracked ones that are not
 *  ignored. A gate that reads only tracked files cannot see the document being
 *  written, which is exactly the file it exists to gate: a new page passes the
 *  local chain and fails on the commit, or worse, on CI after the push. Throws
 *  when git cannot list them, because an empty scan is not a clean tree. */
export function trackedMarkdown(root) {
  const list = (args) =>
    execSync(`git ls-files ${args}`, { cwd: root, encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  const files = new Set([
    ...list("'*.md'"),
    ...list("--others --exclude-standard '*.md'"),
  ]);
  return [...files].sort();
}

export function readText(root, file) {
  try {
    return readFileSync(resolve(root, file), "utf-8");
  } catch {
    return undefined;
  }
}

/** Index of the last line of the opening frontmatter block, or -1. */
export function frontmatterEnd(lines) {
  if (lines[0] !== "---") return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return i;
  return -1;
}
