/**
 * Prompt capture: determinism and the comparator's control.
 *
 * Two captures of one build, taken by two processes started from different
 * working directories, must be byte-identical. The harness pins its own home,
 * braid home, process id, session id and scenario for that reason; this
 * fixture is the check that the pins still cover every non-code input. Remove
 * the pid pin and the two child processes differ on the instance line, so the
 * fixture reddens rather than silently passing on an accidentally stable
 * input.
 *
 * The comparator is checked in both directions: two identical captures exit 0
 * with no hunks, and a one-line edit exits 1 with the edited hunk labelled.
 * Runs against this checkout's dist, so build first.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(PACKAGE_ROOT, "..", "..", "scripts", "prompt-capture.mjs");
const OUT = mkdtempSync(join(tmpdir(), "prompt-capture-"));

after(() => {
  rmSync(OUT, { recursive: true, force: true });
});

function run(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(
    result.error,
    undefined,
    `could not run prompt-capture: ${result.error?.message ?? ""}`,
  );
  return result;
}

function capture(name, cwd) {
  const out = join(OUT, name);
  const result = run(["capture", "--root", PACKAGE_ROOT, "--out", out], cwd);
  assert.equal(result.status, 0, `capture failed: ${result.stderr.trim()}`);
  return out;
}

describe("prompt capture", () => {
  it("two captures of one build from different cwds are byte-identical", () => {
    const first = capture("first.txt", OUT);
    const second = capture("second.txt", tmpdir());
    const a = readFileSync(first);
    const b = readFileSync(second);
    assert.ok(a.length > 0, "the first capture is not empty");
    assert.ok(
      a.equals(b),
      "captures differ; a non-code input was not pinned (pid and cwd are the usual ones)",
    );
    // The capture is the rendered prompt, not just its header.
    const body = a.toString("utf8").split("\n---\n")[1] ?? "";
    assert.match(body, /<cwd>/, "the assembled prompt carries pi's cwd section");
    assert.match(body, /<instance>/, "the assembled prompt carries braid's instance section");
    assert.match(body, /Agent: Braid v\d+\.\d+\.\d+/, "the instance line names the build");
  });

  it("diff mode on two identical captures exits 0 and prints no hunks", () => {
    const captureFile = capture("control.txt", OUT);
    const result = run(["diff", captureFile, captureFile], OUT);
    assert.equal(result.status, 0, `expected identical, got ${result.status}`);
    assert.match(result.stdout, /identical:/, "the comparator says the files are identical");
    assert.doesNotMatch(result.stdout, /^@@/m, "no hunk is printed");
  });

  it("diff mode on a one-line change exits 1 and labels the hunk's region", () => {
    const original = capture("delta-original.txt", OUT);
    const edited = join(OUT, "delta-edited.txt");
    const text = readFileSync(original, "utf8");
    const lines = text.split("\n");
    const target = lines.findIndex((line) =>
      line.startsWith("Root cause before repair:"),
    );
    assert.ok(target >= 0, "a preamble paragraph is in the capture");
    lines[target] = lines[target].replace("reproduce", "reproduce the failure");
    writeFileSync(edited, lines.join("\n"));

    const result = run(["diff", original, edited], OUT);
    assert.equal(result.status, 1, "a real difference exits 1");
    assert.match(result.stdout, /^@@ .* region: preamble$/m, "the hunk names the preamble");
    assert.match(result.stdout, /^\+.*reproduce the failure/m, "the edit is printed");
  });
});
