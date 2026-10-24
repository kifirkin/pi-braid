/**
 * Test: the fleet ships, and the shipped tarball is where it runs from.
 *
 * An operator surface that only exists in a checkout is not a surface: the
 * commands are what an installed user types. So this test asks the artifact,
 * not the manifest. It packs the real package with npm's own `npm pack`, reads
 * the tarball's file list, extracts the tarball outside the repository, and
 * drives the four commands and a supervisor start from the extracted tree with
 * no checkout on the path.
 *
 * Two failures it exists to catch, in opposite directions:
 *   - the fleet is filtered out of the tarball, and an installed user has no
 *     commands at all;
 *   - the allowlist widened to the whole `scripts/` directory, so a stranger's
 *     install carries this repository's own CI gates.
 *
 * The `bin` entry is exercised through a symlink, because that is the shape an
 * install has and a checkout does not: the kernel leaves `process.argv[1]` as
 * the symlink while `import.meta.url` names its target, and an entry-point
 * test that compares the two as spelled loads the module, matches nothing, and
 * exits 0 with no output.
 *
 * The pack runs with `--ignore-scripts`: the question here is what the
 * allowlist ships, and the fleet is not a lifecycle product. What the prepack
 * hook contributes to a tarball is the provenance record's question, packed
 * through the real lifecycle by check-provenance.mjs.
 *
 * Every supervisor this test starts is left to leave on its own, on the idle
 * window the CLI gives it, and the arms wait for that exit rather than killing
 * it: a kill would make the journal say what this test wants instead of what
 * the supervisor does.
 *
 * Run: node test/runtime/fleet/test-pack-ships.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..", "..");
const FLEET_DIR = join(PKG, "scripts", "fleet");

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitFor(label, predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Is there a process behind this pid? The kernel answers, not the journal. */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

// ── the artifact ────────────────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "fleet-ships-"));
const artifacts = join(work, "artifacts");
const extracted = join(work, "extracted");
const consumer = join(work, "consumer");
const root = join(work, "fleet-root");
const charter = join(work, "work.charter.md");
for (const dir of [artifacts, extracted, consumer]) mkdirSync(dir, { recursive: true });

const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts], {
  cwd: PKG,
  encoding: "utf8",
  timeout: 120_000,
  env: { ...process.env, npm_config_cache: join(work, "npm-cache") },
});
const tarballs = readdirSync(artifacts).filter((entry) => entry.endsWith(".tgz"));
const tarball = tarballs.length === 1 ? join(artifacts, tarballs[0]) : null;

const listing = tarball ? spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }) : null;
const entries = listing?.status === 0 ? listing.stdout.split("\n").filter(Boolean) : [];
const shippedFiles = entries.filter((entry) => !entry.endsWith("/"));

if (tarball) {
  const unpack = spawnSync("tar", ["-xzf", tarball, "-C", extracted], { encoding: "utf8" });
  assert.equal(unpack.status, 0, `the tarball extracts: ${unpack.stderr.trim()}`);
}
const shipped = join(extracted, "package");
const shippedCli = join(shipped, "scripts", "fleet", "cli.mjs");
const fleetRootArg = ["--root", root];

/** Run the extracted CLI from a directory that holds no checkout. */
function fleet(args) {
  return spawnSync(process.execPath, [shippedCli, ...args], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const out = (result) => `${(result.stdout ?? "").trim()} ${(result.stderr ?? "").trim()}`.trim();

/** The fleet as JSON from the extracted CLI, or a failed invocation. */
function statusJson() {
  const result = fleet(["status", ...fleetRootArg, "--json"]);
  assert.equal(result.status, 0, `status --json exits 0: ${out(result)}`);
  return JSON.parse(result.stdout);
}

writeFileSync(charter, "A node admitted for its registration, never driven: the supervisor runs at cap 0.\n");

let supervisorPid = null;

await check("the tarball carries the fleet and nothing else under scripts/", () => {
  assert.ok(tarball, `npm pack wrote one tarball into ${artifacts}: ${out(pack)}`);
  const prefix = "package/scripts/fleet/";
  const shippedFleet = shippedFiles
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .sort();
  const onDisk = readdirSync(FLEET_DIR)
    .filter((entry) => statSync(join(FLEET_DIR, entry)).isFile())
    .sort();
  assert.deepEqual(
    shippedFleet,
    onDisk,
    "every fleet file on disk is in the tarball, and no other fleet file is",
  );

  const otherScripts = shippedFiles.filter(
    (entry) => entry.startsWith("package/scripts/") && !entry.startsWith(prefix),
  );
  assert.deepEqual(otherScripts, [], "the tarball ships no scripts/ entry from outside the fleet");
});

await check("the shipped command is executable, with a shebang", () => {
  assert.ok(shippedFiles.includes("package/scripts/fleet/cli.mjs"), "cli.mjs is in the tarball");
  const first = readFileSync(shippedCli, "utf8").split("\n")[0];
  assert.equal(first, "#!/usr/bin/env node", "the shipped entry point starts with a shebang");
  const mode = statSync(shippedCli).mode & 0o777;
  assert.ok((mode & 0o111) !== 0, `the extracted entry point carries an exec bit (mode ${mode.toString(8)})`);
});

await check("status answers from the extracted tree before any supervisor runs", () => {
  const result = fleet(["status", ...fleetRootArg]);
  assert.equal(result.status, 0, `status exits 0: ${out(result)}`);
  assert.match(result.stdout, /^fleet store /m, "status names the store it read");
  assert.match(result.stdout, /supervisor down/, "no supervisor has been started yet");
  assert.equal(statusJson().nodes.length, 0, "the journal is empty before the first spawn");
});

await check("spawn registers a node and starts a supervisor from the extracted tree", () => {
  const result = fleet(["spawn", "-", charter, "--cap", "0", ...fleetRootArg]);
  assert.equal(result.status, 0, `spawn exits 0: ${out(result)}`);
  assert.match(result.stdout, /spawned n1-work/, "spawn names the node it registered");
  assert.match(result.stdout, /supervisor \d+ \(started\)/, "spawn starts a supervisor");

  const status = statusJson();
  const live = status.supervisors.filter((row) => row.state === "live");
  assert.equal(live.length, 1, "the journal holds one live supervisor");
  assert.equal(pidIsAlive(live[0].pid), true, "the journalled pid is a live process");
  assert.equal(status.nodes[0].nodeId, "n1-work", "the registered node is the one status reports");
  supervisorPid = live[0].pid;
});

await check("inject reaches the running supervisor and queue at tier B", () => {
  const result = fleet(["inject", "n1-work", "a queued instruction", ...fleetRootArg]);
  assert.equal(result.status, 0, `inject exits 0: ${out(result)}`);
  assert.match(result.stdout, /tier B/, "a supervisor is up and the node is not streaming, so the message queues");
  assert.equal(statusJson().nodes[0].pending >= 1, true, "the journal holds the message for the next drive");
});

await check("ask returns a token, and inject --token answers it", () => {
  const asked = fleet(["ask", "n1-work", "which branch?", ...fleetRootArg]);
  assert.equal(asked.status, 0, `ask exits 0: ${out(asked)}`);
  const token = asked.stdout.match(/ask (\S+) for n1-work/)?.[1];
  assert.ok(token, `ask prints a token: ${out(asked)}`);
  assert.deepEqual(statusJson().nodes[0].openAsks, [token], "the journal holds the question as open");

  const answered = fleet(["inject", "n1-work", "main", "--token", token, ...fleetRootArg]);
  assert.equal(answered.status, 0, `inject --token exits 0: ${out(answered)}`);
  assert.deepEqual(statusJson().nodes[0].openAsks, [], "the token is spent and the question is closed");
});

await check("the supervisor the commands started leaves on its own, and the journal outlives it", async () => {
  assert.ok(supervisorPid, "an earlier arm started a supervisor");
  await waitFor("the supervisor's idle exit", () => !pidIsAlive(supervisorPid));
  const status = statusJson();
  assert.equal(status.nodes[0].nodeId, "n1-work", "the journal still holds the node the supervisor registered");
  const down = fleet(["status", ...fleetRootArg]);
  assert.match(down.stdout, /supervisor down/, "status reports no supervisor once it has left");
});

await check("the entry point runs through the symlink npm installs for bin", () => {
  const binDir = join(work, "bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "pi-braid-fleet");
  symlinkSync(shippedCli, link);
  const result = spawnSync(link, ["status", ...fleetRootArg], { cwd: consumer, encoding: "utf8", timeout: 30_000 });
  assert.equal(
    result.status,
    0,
    `the symlinked command runs its body rather than exiting silently: status ${result.status} ${out(result)}`,
  );
  assert.match(result.stdout, /^fleet store /m, "the symlinked command prints the status it was asked for");
});

rmSync(work, { recursive: true, force: true });

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
