/**
 * The files a commit would carry, in one place.
 *
 * Two populations matter to a gate that reads content: what the index already
 * carries, and what the working tree holds that the index does not (an ignored
 * path is neither). The doc gates learned this first: a gate that reads only
 * tracked files cannot see the document being written, which is exactly the
 * file it exists to gate, so the local chain passes and the commit that follows
 * is the first time the gate looks at it. The private-data gate scans the same
 * pair, so the enumeration lives here and both read it instead of each carrying
 * its own copy with its own skip set.
 *
 * Paths come back sorted, split on NUL, so a name with a space or a quote
 * survives; the caller resolves each against the root it passed. git refusing
 * to list throws, because an empty scan is not a clean tree.
 */
import { execFileSync } from "node:child_process";

/**
 * @param {string} root directory the paths are relative to
 * @param {string[]} patterns git pathspecs to limit both lists (empty = all)
 * @returns {{ tracked: string[], untracked: string[] }}
 */
export function trackedFileSets(root, patterns = []) {
  const list = (extra) => {
    const args = ["-C", root, "ls-files", "-z", ...extra];
    if (patterns.length > 0) args.push("--", ...patterns);
    const raw = execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return raw
      .split("\0")
      .filter((path) => path !== "")
      .sort();
  };
  return {
    tracked: list([]),
    untracked: list(["--others", "--exclude-standard"]),
  };
}
