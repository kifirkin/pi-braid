/**
 * The publish step that compares the served artifact: its contract with the
 * runner, held by running the body the workflow ships.
 *
 * The step exists to report, so it must not fail the job. The state that
 * matters is the comparison answering "different" (exit 1): a release that
 * publishes is a release whose artifact check found something to say, and a
 * body that ends at that answer reports nothing at all. The runner invokes the
 * body with `bash -e` (the job log's `shell:` line is that contract), so a
 * body that runs the comparison and only then reads its status ends the step
 * at the comparison, which is why this file drives the body extracted from
 * the workflow rather than a copy of it: a copy would pass while the workflow
 * ran something else.
 *
 * Everything the body reaches outside itself is a stub in a scratch directory:
 * `npm` (pack, view) and `curl` through PATH, and a `packages/core` tree whose
 * `pack-compare.mjs` exits with the code the case is about. The step's own
 * branches are the subject; the tool it calls is held by its own fixture. The
 * npm stub counts every `view` and answers with a scripted sequence of exit
 * codes, so a retry the body did not make, or one more than the configured
 * window allows, changes a number the cases assert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// This file sits in packages/core/test/runtime/release/.
const REPO = resolve(HERE, "..", "..", "..", "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "publish.yml");
const STEP_NAME = "Registry artifact check";

// The scratch tree's own version and tag: the step reads the manifest it is
// run beside, so a fixture manifest keeps the case independent of this
// checkout's version.
const VERSION = "9.9.9";
const TAG = `v${VERSION}`;
const TARBALL_URL = `https://registry.example.invalid/pi-braid/-/pi-braid-${VERSION}.tgz`;

const roots = [];
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * The step's `if:` line, its `run:` body, and whether it is still the job's
 * last step. The body is dedented from the YAML block scalar: the scalar's own
 * indentation is the first body line's, and a shallower line ends it.
 */
function extractStep() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
  assert.notEqual(start, -1, `${STEP_NAME} must be a step of the publish workflow`);

  const stepIndent = lines[start].search(/\S/);
  const isStep = (line) =>
    line.trim() !== "" && line.search(/\S/) <= stepIndent && /^- /.test(line.trimStart());
  const later = lines.slice(start + 1).filter(isStep);
  const end = later.length === 0 ? lines.length : lines.indexOf(later[0], start + 1);

  const block = lines.slice(start, end);
  const runAt = block.findIndex((line) => /^\s*run:\s*\|/.test(line));
  assert.notEqual(runAt, -1, `${STEP_NAME} must carry a literal run body`);

  const body = [];
  let scalarIndent = null;
  for (const line of block.slice(runAt + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (scalarIndent === null) scalarIndent = line.search(/\S/);
    if (line.search(/\S/) < scalarIndent) break;
    body.push(line.slice(scalarIndent));
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  const ifLine = block.map((line) => line.trim()).find((line) => line.startsWith("if:"));
  assert.equal(later.length, 0, `${STEP_NAME} must stay the job's last step`);
  return { ifLine, body: `${body.join("\n")}\n` };
}

/**
 * The two npm reads the body makes: `pack` answers with the tarball it then
 * compares, `view` with the registry URL it downloads. Each `view` is counted
 * in the scratch tree, and its exit code is the next one in the scripted
 * sequence (the last one repeats), so the cases assert how many reads the
 * body actually made.
 */
const NPM_STUB = `#!/bin/sh
if [ "$1" = "pack" ]; then
  shift
  dest=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--pack-destination" ]; then
      shift
      dest="$1"
    fi
    shift
  done
  [ -n "\${dest}" ] || exit 2
  : >"\${dest}/pi-braid-\${PI_FIXTURE_VERSION}.tgz"
  exit 0
fi
if [ "$1" = "view" ]; then
  count_file="\${PI_FIXTURE_STATE}/view.count"
  count=0
  if [ -f "\${count_file}" ]; then
    count=$(cat "\${count_file}")
  fi
  count=$((count + 1))
  printf '%s\\n' "\${count}" >"\${count_file}"
  code=""
  remaining=\${count}
  for token in \${PI_FIXTURE_VIEW_SEQUENCE}; do
    code="\${token}"
    remaining=$((remaining - 1))
    if [ "\${remaining}" -le 0 ]; then
      break
    fi
  done
  [ -n "\${code}" ] || code=0
  printf '%s\\n' "\${PI_FIXTURE_TARBALL_URL}"
  if [ "\${code}" != "0" ]; then
    printf '%s\\n' "\${PI_FIXTURE_VIEW_ERR}" >&2
  fi
  exit "\${code}"
fi
echo "stub npm: unexpected invocation $*" >&2
exit 3
`;

/** The one download the body makes: it writes the file named after `-o`. */
const CURL_STUB = `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift
done
if [ "\${PI_FIXTURE_CURL_EXIT}" != "0" ]; then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit "\${PI_FIXTURE_CURL_EXIT}"
fi
[ -n "\${out}" ] || exit 2
echo "registry tarball" >"\${out}"
`;

/** A stand-in for the comparison, so each case drives the step's own branch. */
const COMPARE_STUB = `console.log("a: stub");
console.log("b: stub");
if (process.env.PI_FIXTURE_COMPARE_TEXT) console.log(process.env.PI_FIXTURE_COMPARE_TEXT);
process.exit(Number(process.env.PI_FIXTURE_COMPARE_EXIT ?? 0));
`;

/**
 * A scratch checkout the body can run in: the stubs on PATH, a `packages/core`
 * manifest the body can read, the comparison's stand-in where the body looks
 * for it, and a run-summary file the runner would have supplied.
 *
 * `graceSeconds` and `graceInterval` are the step's window knobs. The default
 * pair keeps every case fast while still allowing a retry: a first read that
 * answers ends the loop without sleeping.
 */
function buildScratch({
  manifest = true,
  compareExit = 0,
  compareText = "",
  viewSequence = "0",
  viewErr = "",
  curlExit = 0,
  graceSeconds = 3,
  graceInterval = 1,
} = {}) {
  const dir = scratchDir("publish-artifact-step-");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  for (const [name, stub] of Object.entries({ npm: NPM_STUB, curl: CURL_STUB })) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }

  const core = join(dir, "packages", "core");
  mkdirSync(join(core, "scripts"), { recursive: true });
  if (manifest) {
    writeFileSync(join(core, "package.json"), `${JSON.stringify({ name: "pi-braid", version: VERSION }, null, 2)}\n`);
  }
  writeFileSync(join(core, "scripts", "pack-compare.mjs"), COMPARE_STUB);

  return {
    dir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_REF_NAME: TAG,
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      PI_FIXTURE_STATE: state,
      PI_FIXTURE_VERSION: VERSION,
      PI_FIXTURE_TARBALL_URL: TARBALL_URL,
      PI_FIXTURE_VIEW_SEQUENCE: viewSequence,
      PI_FIXTURE_VIEW_ERR: viewErr,
      PI_FIXTURE_CURL_EXIT: String(curlExit),
      PI_FIXTURE_COMPARE_EXIT: String(compareExit),
      PI_FIXTURE_COMPARE_TEXT: compareText,
      ARTIFACT_CHECK_GRACE_SECONDS: String(graceSeconds),
      ARTIFACT_CHECK_GRACE_INTERVAL_SECONDS: String(graceInterval),
    },
  };
}

/**
 * Run the step body the way the runner does. `pipefail` adds the one option a
 * `shell: bash` default would carry, because a body that only survives the
 * narrowest shell is a body that fails on the next `shell:` edit.
 */
function runStep(scratch, { pipefail = false } = {}) {
  const script = join(scratch.dir, "step.sh");
  writeFileSync(script, extractStep().body);

  const argv = pipefail ? ["-eo", "pipefail", script] : ["-e", script];
  const result = spawnSync("bash", argv, {
    cwd: scratch.dir,
    encoding: "utf8",
    env: { ...process.env, ...scratch.env },
  });
  assert.equal(result.error, undefined, `bash did not start: ${result.error}`);
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** How many times the body read the registry: the npm stub counts its calls. */
function viewCount(scratch) {
  try {
    return Number(readFileSync(join(scratch.dir, "state", "view.count"), "utf8").trim());
  } catch {
    return 0;
  }
}

/** What the step wrote to the run summary, the surface a human reads first. */
function summaryText(scratch) {
  try {
    return readFileSync(join(scratch.dir, "summary.md"), "utf8");
  } catch {
    return "";
  }
}

/** Assert the body printed `text`, quoting what it did print when it did not. */
function printed(out, text, what) {
  assert.ok(out.includes(text), `${what}: expected ${JSON.stringify(text)} in:\n${out}`);
}

test("the body opts out of the runner's shell options itself, and stays the job's last step", () => {
  const { ifLine, body } = extractStep();
  assert.equal(ifLine, "if: github.ref_type == 'tag'", "a dispatch run has no tag tree to compare against");
  // A body that only survives `bash -e` because nothing failed yet is the
  // defect this step shipped with: the opt-out has to be in the body.
  assert.match(body, /^set \+e$/m, "the body must turn off errexit, whatever the runner injects");
  assert.match(body, /^set \+u$/m, "the body must turn off nounset, whatever the runner injects");
  assert.ok(body.includes("pack-compare.mjs"), "the extracted body must be the step that compares the artifact");

  const script = join(scratchDir("publish-artifact-syntax-"), "step.sh");
  writeFileSync(script, body);
  const check = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(check.status, 0, `the body must parse: ${check.stderr}`);
});

test("the first read answers: the step compares the artifact and reads the registry once", () => {
  const scratch = buildScratch({ compareExit: 0 });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `an equal artifact must leave the step green: exit ${code}\n${out}`);
  printed(out, `artifact check: the registry artifact for pi-braid@${VERSION} unpacks to the tree ${TAG} builds`, "the equality is named");
  assert.ok(!out.includes("::warning"), `an equal artifact must carry no warning:\n${out}`);
  assert.equal(viewCount(scratch), 1, "a served version is read once, not retried");
  printed(summaryText(scratch), "- artifact check: verified equal:", "the run summary names the verdict");
});

test("the comparison says different: the step exits 0 and warns with the paths", () => {
  const scratch = buildScratch({
    compareExit: 1,
    compareText: "trees differ: 1 path\n  content differs  package/build-info.json",
  });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `a difference is the step's report, not its failure: exit ${code}\n${out}`);
  printed(out, "::warning title=Registry artifact differs::", "the difference is a warning the run shows");
  // The tool owns the paths and the workflow reprints them; a warning that
  // does not carry them makes the run's log the only place they existed.
  printed(out, "  package/build-info.json", "the difference is named");
  printed(summaryText(scratch), "- artifact check: differs:", "the run summary names the verdict");
});

test("the same body keeps that contract under the stricter shell", () => {
  const scratch = buildScratch({ compareExit: 1, compareText: "trees differ: 1 path" });
  const { code, out } = runStep(scratch, { pipefail: true });

  assert.equal(code, 0, `-eo pipefail must not end the step either: exit ${code}\n${out}`);
  printed(out, "::warning title=Registry artifact differs::", "the difference is still a warning");
});

test("the comparison could not read an archive: the step exits 0 and refuses the verdict", () => {
  const scratch = buildScratch({
    compareExit: 2,
    compareText: "pack-compare: /tmp/registry.tgz: not an archive",
  });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `an unreadable archive is not a red mark on the publish: exit ${code}\n${out}`);
  printed(out, "::warning title=Registry artifact unreadable::", "the skip is a warning the run shows");
  printed(out, "not a verdict about the tree", "the run does not read it as a difference");
  printed(summaryText(scratch), "- artifact check: unreadable:", "the run summary keeps it out of the verified state");
});

test("a 404 is the registry's propagation lag: the read is retried and the artifact then compared", () => {
  const scratch = buildScratch({
    viewSequence: "1 1 0",
    viewErr: "npm error code E404",
    graceSeconds: 3,
    graceInterval: 1,
  });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `the version arrived inside the window: exit ${code}\n${out}`);
  printed(out, `artifact check: the registry artifact for pi-braid@${VERSION} unpacks to the tree ${TAG} builds`, "the retry ends in the comparison");
  assert.ok(!out.includes("::warning"), `a version that arrived is verified, not warned about:\n${out}`);
  assert.equal(viewCount(scratch), 3, "two 404s and then the served version are three reads");
  printed(summaryText(scratch), "- artifact check: verified equal:", "the run summary names the verdict the comparison reached");
});

test("the grace window expires: the reads stop at the bound and the artifact is reported not verified", () => {
  const scratch = buildScratch({
    viewSequence: "1",
    viewErr: "npm error code E404",
    graceSeconds: 3,
    graceInterval: 1,
  });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `a version that never arrived cannot fail the publish: exit ${code}\n${out}`);
  printed(out, "::warning title=Registry artifact not verified::", "the run shows the artifact was not verified");
  printed(out, "within the 3s grace window (4 reads, 404)", "the window and the counted reads are named");
  printed(out, "nothing to compare", "the skip still says there was nothing to compare");
  assert.equal(viewCount(scratch), 4, "3s / 1s + 1 is the bound: the window is finite");
  printed(summaryText(scratch), "- artifact check: not verified:", "the run summary names the fourth outcome");
});

test("a registry failure that is not a 404 gets no grace window: one read, reported at once", () => {
  const scratch = buildScratch({
    viewSequence: "1",
    viewErr: "npm error code E500",
    graceSeconds: 5,
    graceInterval: 1,
  });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `a registry failure cannot fail the publish: exit ${code}\n${out}`);
  printed(out, "the registry read for pi-braid@9.9.9 failed (exit 1)", "the failure is named");
  printed(out, "::warning title=Registry artifact not verified::", "the run shows the artifact was not verified");
  assert.equal(viewCount(scratch), 1, "a failure that is not a 404 is not retried");
  printed(summaryText(scratch), "- artifact check: not verified:", "the run summary names the fourth outcome");
});

test("the registry serves no tarball: the step says which fact stopped it and exits 0", () => {
  const scratch = buildScratch({ curlExit: 22 });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `a missing artifact cannot fail the publish: exit ${code}\n${out}`);
  printed(out, "the registry served no tarball", "the skip names the failed download");
  printed(out, "nothing to compare", "the skip says there is nothing to compare");
  printed(out, "::warning title=Registry artifact not verified::", "the run shows the artifact was not verified");
  printed(summaryText(scratch), "- artifact check: not verified:", "the run summary names the fourth outcome");
});

test("the core manifest cannot be read: the step exits 0 without a version to compare", () => {
  const scratch = buildScratch({ manifest: false });
  const { code, out } = runStep(scratch);

  assert.equal(code, 0, `a missing manifest cannot fail the publish: exit ${code}\n${out}`);
  printed(out, "could not read the core version", "the skip names the fact that stopped it");
  printed(out, "::warning title=Registry artifact not verified::", "the run shows the artifact was not verified");
  printed(summaryText(scratch), "- artifact check: not verified:", "the run summary names the fourth outcome");
});
