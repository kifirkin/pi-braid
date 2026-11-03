import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trackedMarkdown } from "../../../scripts/lib/doc-text.mjs";

/**
 * The doc gates read one list. When that list was `git ls-files`, a document
 * written but not yet committed did not exist for the gate, so a new page passed
 * the local chain and failed on CI. The control is the ignored file: widening
 * the scan must not pull in a build artifact that happens to end in .md.
 */
test("the doc scan sees an untracked file and still skips an ignored one", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-text-untracked-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "ignored.md\n");
    writeFileSync(join(dir, "tracked.md"), "# tracked\n");
    execFileSync("git", ["add", ".gitignore", "tracked.md"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"],
      { cwd: dir },
    );
    writeFileSync(join(dir, "untracked.md"), "# not committed yet\n");
    writeFileSync(join(dir, "ignored.md"), "# build output\n");

    const files = trackedMarkdown(dir);

    assert.ok(
      files.includes("tracked.md"),
      "a committed page must stay in the scan",
    );
    assert.ok(
      files.includes("untracked.md"),
      "the page being written is the one the gate exists for",
    );
    assert.ok(
      !files.includes("ignored.md"),
      "an ignored file is not part of the shipped set",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
