/**
 * The runner must contain a killed file's tmp dirs.
 *
 * A file that outlives its cap is killed with SIGKILL, so its own
 * `finally { rmSync }` cannot run; whatever it created under TMPDIR is left
 * behind for the runner to own. This test pins that ownership end to end: it
 * copies the runner's own bytes into a bench tree whose only test file
 * creates a scratch dir under its TMPDIR and then hangs until the cap kills
 * it, and asserts no scratch survives the run.
 *
 * PI_RUNNER_SCRIPT overrides the script under test (used to run this test
 * against the pre-containment revision and show it fail). The default is the
 * repository's scripts/run-tests.mjs.
 *
 * The runner's work is asserted in three places, so a partial revert still
 * fails: the killed file's scratch dir is gone after the nested runner
 * exits, no killed-child-scratch-* dir survives anywhere under the bench
 * temp, and no pi-braid-test-* runner dir survives either. A run that never
 * reached the child's scratch phase fails the proof check instead of
 * passing vacuously.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultScript = resolve(here, "..", "..", "scripts", "run-tests.mjs");
const scriptUnderTest = resolve(process.env.PI_RUNNER_SCRIPT ?? defaultScript);

const CAP_MS = 5000;
const PROOF_ENV = "PI_CONTAINMENT_PROOF";

/**
 * The bench's only test file. It records the scratch dir it made and then
 * never cleans up, which is exactly the state the runner's SIGKILL leaves a
 * real file in.
 */
const PROBE = `import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "killed-child-scratch-"));
writeFileSync(join(scratch, "kept.txt"), "survives the kill unless the runner removes its TMPDIR\\n");
writeFileSync(process.env.PI_CONTAINMENT_PROOF, scratch + "\\n");
setTimeout(() => {}, 60_000); // hang until the runner's cap kills this file
`;

const bench = mkdtempSync(join(tmpdir(), "runner-containment-bench-"));
const benchTmp = join(bench, "tmp");
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

try {
  const benchScripts = join(bench, "scripts");
  const benchTests = join(bench, "test", "runtime");
  mkdirSync(benchTmp, { recursive: true });
  mkdirSync(benchScripts, { recursive: true });
  mkdirSync(benchTests, { recursive: true });
  writeFileSync(join(benchScripts, "run-tests.mjs"), readFileSync(scriptUnderTest, "utf-8"));
  writeFileSync(join(benchTests, "tmpdir-leak-probe.mjs"), PROBE);

  const proofFile = join(bench, "proof.txt");
  const nestedEnv = {
    ...process.env,
    TMPDIR: benchTmp,
    PI_TEST_TIMEOUT_MS: String(CAP_MS),
    [PROOF_ENV]: proofFile,
  };
  delete nestedEnv.PI_TEST_ALLOWANCE;

  const run = spawnSync(process.execPath, [join(benchScripts, "run-tests.mjs")], {
    cwd: bench,
    env: nestedEnv,
    encoding: "utf-8",
    timeout: 20_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  let scratch = "";
  try {
    scratch = readFileSync(proofFile, "utf-8").trim();
  } catch {
    // No proof: the probe never reached its scratch phase. Reported below.
  }

  check(
    "the killed file reached its scratch phase",
    scratch.startsWith(benchTmp + "/"),
    scratch || "no proof written by the probe file",
  );
  const killedAtCap = run.status === 1 && /1 timed out/.test(output);
  check(
    "the nested runner killed the file at the cap",
    killedAtCap,
    killedAtCap
      ? `status=${run.status}`
      : `status=${run.status}${run.error?.code ? ` error=${run.error.code}` : ""} tail=${JSON.stringify(output.slice(-200))}`,
  );
  if (scratch) {
    const scratchRemoved = !existsSync(scratch);
    check(
      "the killed file's scratch dir was removed",
      scratchRemoved,
      scratchRemoved ? "" : `survivor: ${scratch}`,
    );
  }
  const childSurvivors = findDirs(benchTmp, "killed-child-scratch-");
  check(
    "no killed-child scratch dir survives under the bench temp",
    childSurvivors.length === 0,
    childSurvivors.join(", "),
  );
  const runnerSurvivors = findDirs(benchTmp, "pi-braid-test-");
  check(
    "no runner scratch dir survives under the bench temp",
    runnerSurvivors.length === 0,
    runnerSurvivors.join(", "),
  );

  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(
    failed === 0
      ? `containment pinned: the ${CAP_MS}ms kill left 0 survivors (script: ${scriptUnderTest})`
      : `${failed} containment check(s) failed (script: ${scriptUnderTest})`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(bench, { recursive: true, force: true });
}

/** Scratch dirs whose name starts with prefix, searched recursively. */
function findDirs(dir, prefix) {
  const hits = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith(prefix)) hits.push(full);
    hits.push(...findDirs(full, prefix));
  }
  return hits;
}
