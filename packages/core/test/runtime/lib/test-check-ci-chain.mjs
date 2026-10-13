/**
 * test-check-ci-chain.mjs — the quality gate is one chain, and an advisory
 * exemption has to be one in every command it runs.
 *
 * The check reads the workflow and the manifest of the repo root it sits in,
 * so each case runs a copy of the script against a throwaway root it owns:
 * a minimal `ci.yml`, a minimal `package.json`, and nothing else.
 *
 * Cases:
 *   1. the chain is the only run command and the advisory body is a single
 *      command carrying `--no-exit-code` -> exit 0
 *   2. a `check:*` script declared in the manifest but missing from the chain
 *      -> exit 1 (a check outside the chain can never fail the gate)
 *   3. the workflow re-lists a check next to the chain -> exit 1
 *   4. two chain invocations -> exit 1
 *   5. a block-scalar `run:` is reported rather than guessed at -> exit 1
 *   6. the advisory body loses `--no-exit-code` -> exit 1
 *   7. the flag sits in a fallback segment (`knip … || echo --no-exit-code`):
 *      the check keeps its own exit code -> exit 1
 *   8. the flag sits in a shell comment -> exit 1
 *   9. the flag sits in an earlier segment of the body -> exit 1
 *  10. a multi-command body with the flag on every segment -> exit 0
 *  11. a quoted flag on the check segment still counts (the shell passes the
 *      same argument) -> exit 0
 *  12. a flag embedded in a longer quoted argument (`"json --no-exit-code"`,
 *      `" --no-exit-code"`) is not the flag -> exit 1
 *  13. a flag on an earlier line of a newline body does not speak for the
 *      check on the last line -> exit 1
 *  14. the other command boundaries (a newline, a pipe stage, a background `&`
 *      segment) are held fail-closed -> exit 1
 *  15. a `--no-exit-code=1` suffix, an env-assignment spelling and a subshell
 *      echo are not the flag -> exit 1
 *  16. inside double quotes only `$`, a backtick, `"`, `\` and a newline are
 *      escaped, so a backslash before an ordinary character stays in the
 *      argument (`"\-\-no-exit-code"` is not the flag) -> exit 1, while a
 *      backslash-newline is a line continuation -> exit 0
 *  17. a body the shell cannot parse is refused rather than exempted: an open
 *      quote, a leading boundary operator and a dangling `&&`, `||` or `|`
 *      -> exit 1, while a body ending on `;` or `&` (a command) stays clean
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-ci-chain.mjs");

const CHAIN = "npm run check:docs && npm run check:write-scope && npm run check:ci-chain";

/** A manifest whose chain runs every declared `check:*` script. */
function manifest(chain, deadcode = "knip --reporter json --no-exit-code") {
  return {
    name: "fake-root",
    scripts: {
      "ci:check": chain,
      "check:docs": "node packages/core/scripts/check-doc-status.mjs",
      "check:write-scope": "node packages/core/scripts/check-write-scope.mjs",
      "check:ci-chain": "node packages/core/scripts/check-ci-chain.mjs",
      "check:deadcode": deadcode,
    },
  };
}

/** A workflow with one single-line `run:` per step, in order. */
function workflow(runs) {
  const steps = runs
    .map((command, i) => `      - name: step ${i}\n        run: ${command}\n`)
    .join("");
  return (
    "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  quality:\n" +
    "    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n" +
    steps
  );
}

/** Build a throwaway root, run the check, remove the root. */
function runCase({ ciYml, manifest: pkg }) {
  const tree = mkdtempSync(join(tmpdir(), "cichain-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(tree, ".github/workflows"), { recursive: true });
    copyFileSync(SCRIPT, join(scriptsDir, "check-ci-chain.mjs"));
    writeFileSync(join(tree, ".github/workflows/ci.yml"), ciYml);
    writeFileSync(join(tree, "package.json"), JSON.stringify(pkg, null, 2));
    const r = spawnSync("node", [join(scriptsDir, "check-ci-chain.mjs")], {
      cwd: tree,
      encoding: "utf8",
    });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

test("the chain alone, with an advisory body that cannot fail, is clean", () => {
  const { status, out } = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN),
  });
  assert.equal(status, 0, out);
  assert.match(out, /check-ci-chain: clean/);
});

test("a declared check the chain never runs is reported", () => {
  const { status, out } = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest("npm run check:docs && npm run check:ci-chain"),
  });
  assert.equal(status, 1, out);
  assert.match(out, /check:write-scope: declared in package\.json but never run by ci:check/);
});

test("the workflow re-listing a check next to the chain is reported", () => {
  const { status, out } = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check", "npm run check:write-scope"]),
    manifest: manifest(CHAIN),
  });
  assert.equal(status, 1, out);
  assert.match(out, /runs outside the chain/);
});

test("two chain invocations and a block scalar are both reported", () => {
  const twice = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check", "npm run ci:check"]),
    manifest: manifest(CHAIN),
  });
  assert.equal(twice.status, 1, twice.out);
  assert.match(twice.out, /expected exactly one "npm run ci:check" invocation, found 2/);

  const block = runCase({
    ciYml:
      "name: CI\njobs:\n  quality:\n    steps:\n      - name: gates\n        run: |\n          npm run ci:check\n",
    manifest: manifest(CHAIN),
  });
  assert.equal(block.status, 1, block.out);
  assert.match(block.out, /block-scalar "run:" is not inspected/);
});

test("an advisory body without the flag is reported", () => {
  const { status, out } = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "knip --reporter json"),
  });
  assert.equal(status, 1, out);
  assert.match(out, /check:deadcode: exempted as advisory/);
});

test("a flag in a fallback segment does not make the check advisory", () => {
  const { status, out } = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "knip --reporter json || echo --no-exit-code"),
  });
  assert.equal(status, 1, out);
  assert.match(out, /"knip --reporter json" does not pass --no-exit-code/);
});

test("a flag in a shell comment or in an earlier segment is reported", () => {
  const comment = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "knip --reporter json # --no-exit-code"),
  });
  assert.equal(comment.status, 1, comment.out);
  assert.match(comment.out, /does not pass --no-exit-code/);

  const earlier = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "echo --no-exit-code && knip --reporter json"),
  });
  assert.equal(earlier.status, 1, earlier.out);
  assert.match(earlier.out, /"knip --reporter json" does not pass --no-exit-code/);
});

test("a flag on every segment, quoted or not, keeps the body advisory", () => {
  const everySegment = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "npx knip --no-exit-code && echo --no-exit-code"),
  });
  assert.equal(everySegment.status, 0, everySegment.out);

  const quoted = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, 'knip --reporter json "--no-exit-code"'),
  });
  assert.equal(quoted.status, 0, quoted.out);
  assert.match(quoted.out, /check-ci-chain: clean/);
});

test("a flag embedded in a longer quoted argument is not the flag", () => {
  for (const body of [
    'knip --reporter "json --no-exit-code"',
    "knip --reporter 'json --no-exit-code'",
    'knip --reporter json " --no-exit-code"',
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 1, `${body}: ${out}`);
    assert.match(out, /does not pass --no-exit-code/);
  }
});

test("a flag on an earlier command does not speak for the check on the last", () => {
  const newline = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, "echo --no-exit-code\nknip --reporter json"),
  });
  assert.equal(newline.status, 1, newline.out);
  assert.match(newline.out, /"knip --reporter json" does not pass --no-exit-code/);

  // A newline, a pipe and a background `&` are command boundaries too: a
  // segment whose failure cannot, alone, reach the exit code still has to
  // carry the flag (fail-closed).
  for (const body of [
    "knip --reporter json\necho --no-exit-code",
    "knip --reporter json | tee --no-exit-code",
    "echo --no-exit-code & knip --reporter json",
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 1, `${body}: ${out}`);
    assert.match(out, /does not pass --no-exit-code/);
  }
});

test("a flag suffix, an env assignment or a subshell echo is not the flag", () => {
  for (const body of [
    "knip --reporter json --no-exit-code=1",
    "KNIP=--no-exit-code knip --reporter json",
    "(echo --no-exit-code) && knip --reporter json",
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 1, `${body}: ${out}`);
    assert.match(out, /does not pass --no-exit-code/);
  }
});

test("a backslash inside double quotes escapes only what the shell escapes", () => {
  // Inside double quotes only `$`, a backtick, `"`, `\` and a newline are
  // escaped (POSIX 2.2.3), which is what the shells do. Each row spells the
  // flag through one escape: only the newline is removed without leaving a
  // character behind, so only that row hands the command the flag.
  for (const body of [
    'knip --reporter json "\\-\\-no-exit-code"', // an ordinary character
    'knip --reporter json "--no-exit-\\$code"',
    'knip --reporter json "--no-exit-\\`code"',
    'knip --reporter json "--no-exit-\\"code"',
    'knip --reporter json "--no-exit-\\\\code"',
    "knip --reporter json \\-\\-no-exit-code", // the unquoted twin
    'knip --reporter json "--no-exit-\ncode"', // a raw newline stays
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 1, `${JSON.stringify(body)}: ${out}`);
    assert.match(out, /does not pass --no-exit-code/);
  }

  // A backslash before a newline is removed with it (a line continuation):
  // the shells hand the command `--no-exit-code`, so the body stays advisory.
  const continuation = runCase({
    ciYml: workflow(["npm ci", "npm run ci:check"]),
    manifest: manifest(CHAIN, 'knip --reporter json "--no-exit-\\\ncode"'),
  });
  assert.equal(continuation.status, 0, continuation.out);
  assert.match(continuation.out, /check-ci-chain: clean/);
});

test("a body the shell cannot parse is refused, not exempted", () => {
  // `sh -c` ends in a syntax error for each of these, so no command carries
  // the flag: an exemption over no command verifies nothing.
  for (const body of [
    'knip --reporter json --no-exit-code "oops',
    "knip --reporter json --no-exit-code &&",
    "knip --reporter json --no-exit-code ||",
    "knip --reporter json --no-exit-code |",
    "&& knip --reporter json --no-exit-code",
    "; knip --reporter json --no-exit-code",
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 1, `${JSON.stringify(body)}: ${out}`);
    assert.match(out, /is not a command `sh -c` can run/);
  }

  // A body that ends on `;` or `&`, or on a newline, is a command: it stays
  // clean as long as every segment carries the flag.
  for (const body of [
    "knip --reporter json --no-exit-code;",
    "knip --reporter json --no-exit-code &",
    "knip --reporter json --no-exit-code\n",
  ]) {
    const { status, out } = runCase({
      ciYml: workflow(["npm ci", "npm run ci:check"]),
      manifest: manifest(CHAIN, body),
    });
    assert.equal(status, 0, `${JSON.stringify(body)}: ${out}`);
    assert.match(out, /check-ci-chain: clean/);
  }
});
