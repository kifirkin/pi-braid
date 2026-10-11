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

/** Tracked `.md` files. Throws when git cannot list them: an empty scan is
 *  not a clean tree, and a gate that passes on zero files is decoration. */
export function trackedMarkdown(root) {
  return execSync("git ls-files '*.md'", { cwd: root, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
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
