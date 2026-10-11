/**
 * The suite-coverage check must fail on an unreached package's test script.
 *
 * A bench monorepo carries the check's own bytes and four packages: two the
 * bench chain reaches, one it does not, and one that declares no `test`
 * script at all. The check is run against that bench three ways — as built
 * (must fail, naming the unreached package), with the package wired in as
 * `--workspace=<name>` (must pass, which pins name resolution next to the
 * directory-path form), and as `--workspaces` (must pass, which pins that a
 * workspace without the script is not read as an undefined script) — and
 * finally against the repository's own tree, where it must pass, so a check
 * that stops detecting the hole, or a chain that stops reaching a suite,
 * fails here.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const checkScript = join(
  repoRoot,
  "packages",
  "core",
  "scripts",
  "check-suite-coverage.mjs",
);

const checks = [];
const check = (name, pass, detail = "") =>
  checks.push({ name, pass: Boolean(pass), detail });

/** Write a package manifest into the bench. */
function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

/** Run a copy of the check in `cwd`; returns status plus both streams. */
function runCheck(scriptPath, cwd) {
  const run = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: run.status,
    output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    error: run.error?.code,
  };
}

const bench = mkdtempSync(join(tmpdir(), "suite-coverage-bench-"));
const benchCore = join(bench, "packages", "core");
const chain = (extra) =>
  [
    "npm run test -w packages/core",
    "npm run test -w packages/reached",
    ...(extra ? [extra] : []),
  ].join(" && ");

try {
  const benchScript = join(benchCore, "scripts", "check-suite-coverage.mjs");
  mkdirSync(join(benchCore, "scripts"), { recursive: true });
  writeFileSync(benchScript, readFileSync(checkScript, "utf-8"));
  writeManifest(benchCore, {
    name: "bench-core",
    private: true,
    scripts: { test: "node test.mjs" },
  });
  writeManifest(join(bench, "packages", "reached"), {
    name: "bench-reached",
    private: true,
    scripts: { test: "node test.mjs" },
  });
  writeManifest(join(bench, "packages", "orphan"), {
    name: "bench-orphan",
    private: true,
    scripts: { test: "node test.mjs" },
  });
  writeManifest(join(bench, "packages", "notest"), {
    name: "bench-notest",
    private: true,
    scripts: { typecheck: "tsc --noEmit" },
  });
  const benchRoot = {
    name: "bench-root",
    private: true,
    workspaces: [
      "packages/core",
      "packages/reached",
      "packages/orphan",
      "packages/notest",
    ],
    scripts: { "ci:check": chain(null) },
  };
  writeManifest(bench, benchRoot);

  const unwired = runCheck(benchScript, bench);
  check(
    "the unreached package fails the check",
    unwired.status === 1,
    `status=${unwired.status}${unwired.error ? ` error=${unwired.error}` : ""} output=${JSON.stringify(unwired.output.trim())}`,
  );
  check(
    "the failure names the unreached package",
    unwired.output.includes("packages/orphan"),
    unwired.output.trim().split("\n").slice(0, 3).join(" | "),
  );
  check(
    "a reached package is not named as unreached",
    !/packages\/reached[^\n]*never reaches/.test(unwired.output),
    unwired.output.trim(),
  );

  // Wire the orphan in with the `--workspace=<name>` form: the same check
  // must now pass, which pins that a workspace spec resolves by package name
  // as well as by directory path.
  writeManifest(bench, {
    ...benchRoot,
    scripts: {
      "ci:check": chain("npm run test --workspace=bench-orphan"),
    },
  });
  const wired = runCheck(benchScript, bench);
  check(
    "wiring the package in by name passes the check",
    wired.status === 0,
    `status=${wired.status}${wired.error ? ` error=${wired.error}` : ""} output=${JSON.stringify(wired.output.trim())}`,
  );

  // `npm run <script> --workspaces` reaches every workspace that declares the
  // script, so the same bench must pass that way too.
  writeManifest(bench, {
    ...benchRoot,
    scripts: { "ci:check": "npm run test --workspaces" },
  });
  const workspaces = runCheck(benchScript, bench);
  check(
    "the --workspaces form reaches every declaring package",
    workspaces.status === 0,
    `status=${workspaces.status}${workspaces.error ? ` error=${workspaces.error}` : ""} output=${JSON.stringify(workspaces.output.trim())}`,
  );

  check(
    "a package with no test script is never named",
    ![unwired, wired, workspaces].some((run) => run.output.includes("notest")),
    `${unwired.output.trim()} | ${wired.output.trim()} | ${workspaces.output.trim()}`,
  );

  // The repository's own tree: the check must pass there too, so the bench
  // cannot pass while the real chain sits outside the gate.
  const real = runCheck(checkScript, repoRoot);
  check(
    "the repository's own chain reaches every test script",
    real.status === 0,
    `status=${real.status}${real.error ? ` error=${real.error}` : ""} output=${JSON.stringify(real.output.trim())}`,
  );
} finally {
  rmSync(bench, { recursive: true, force: true });
}

for (const c of checks) {
  console.log(
    `${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`,
  );
}
const failed = checks.filter((c) => !c.pass).length;
console.log(
  failed === 0
    ? "suite coverage pinned: an unreached test script fails the check, a reached one passes"
    : `${failed} suite-coverage check(s) failed`,
);
process.exitCode = failed === 0 ? 0 : 1;
