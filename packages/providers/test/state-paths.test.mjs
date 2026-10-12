/**
 * state-paths.test.mjs
 *
 * Where this package's state files live, pinned:
 *
 *   - `state-paths.ts` contracts: an agent directory that is absolute or
 *     absent (never relative, never the cwd), `PI_CODING_AGENT_DIR` honored
 *     only when it names an absolute directory, and a braid data root that
 *     mirrors core's `braidDir()`;
 *   - the real writers land in `<HOME>/.pi/agent/` (the location they always
 *     had) and create nothing in the cwd;
 *   - a hostile `HOME` (`""` or `"."`) reaches no writer: every changed
 *     helper refuses (null, or a run with no persistence), the throwaway cwd
 *     gains nothing, and `presend-guard`'s skip is visible through the
 *     package's log sink. Those cases run in child processes because each
 *     helper reads the environment per call;
 *   - `presend-guard`'s flush root follows a pinned `BRAID_HOME`, so the two
 *     offload roots (core's and this package's) move together.
 *
 * Harness: the package's own tsc compiles the modules under test into
 * `<repoRoot>/.race-build/` (CJS emit), the same shape presend-guard.test.mjs
 * uses. HOME, BRAID_HOME and the cwd are throwaway temp dirs, so the
 * developer's live state is never written.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".race-build-state-paths");

let failures = 0;
const checks = [];
function check(name, cond, extra) {
  checks.push({ name, cond });
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

/** Compile the modules under test to CJS in buildDir and load them. */
function loadModules(files) {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    ...files.map((f) => join(pkgRoot, f)),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--forceConsistentCasingInFileNames",
    "--types",
    "node",
  ];
  const tsc = spawnSync("node", args, { cwd: pkgRoot, encoding: "utf-8" });
  if (tsc.status !== 0) {
    throw new Error(`tsc failed: ${tsc.stdout}\n${tsc.stderr}`);
  }
  const require_ = createRequire(import.meta.url);
  return (name) => require_(join(buildDir, `${name}.js`));
}

/** Relative file list under a root (sorted); [] when absent. */
function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, "");
  return out.sort();
}

const load = loadModules([
  "state-paths.ts",
  "key-ring.ts",
  "route-state.ts",
  "outage-watch.ts",
]);

console.log("=== provider state paths ===\n");

// ── state-paths contracts ──────────────────────────────────────────────────────

const statePaths = load("state-paths");

const pinnedHome = mkdtempSync(join(tmpdir(), "prov-state-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "prov-state-proj-"));
const pinnedBraid = mkdtempSync(join(tmpdir(), "prov-state-braid-"));
const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  BRAID_HOME: process.env.BRAID_HOME,
};

process.env.HOME = pinnedHome;
delete process.env.USERPROFILE;
delete process.env.PI_CODING_AGENT_DIR;

const agentDir = statePaths.homedirAgentDir();
// The outage claim record is the other changed export with a refusal
// contract: its own file under the agent directory, never a cwd write.
const outage = load("outage-watch");
check(
  "defaultOutageClaimPath() resolves the claim file under the pinned HOME",
  outage.defaultOutageClaimPath() ===
    join(pinnedHome, ".pi", "agent", ".provider-outage-notify.json"),
  String(outage.defaultOutageClaimPath()),
);
check(
  "homedirAgentDir() is absolute (never relative, never the cwd)",
  agentDir !== null &&
    agentDir.startsWith("/") &&
    agentDir === join(pinnedHome, ".pi", "agent"),
  String(agentDir),
);

process.env.PI_CODING_AGENT_DIR = join(pinnedHome, "relocated-agent");
check(
  "piAgentDir() honors an absolute PI_CODING_AGENT_DIR",
  statePaths.piAgentDir() === join(pinnedHome, "relocated-agent"),
  String(statePaths.piAgentDir()),
);

process.env.PI_CODING_AGENT_DIR = "relative-agent";
check(
  "piAgentDir() refuses a relative override instead of resolving it against the cwd",
  statePaths.piAgentDir() === null,
  String(statePaths.piAgentDir()),
);
delete process.env.PI_CODING_AGENT_DIR;

delete process.env.BRAID_HOME;
check(
  "braidDataRoot() mirrors core's braidDir() with no pin",
  statePaths.braidDataRoot() === join(homedir(), ".pi", "agent", "braid"),
  statePaths.braidDataRoot(),
);
process.env.BRAID_HOME = pinnedBraid;
check(
  "braidDataRoot() follows a pinned BRAID_HOME",
  statePaths.braidDataRoot() === pinnedBraid,
  statePaths.braidDataRoot(),
);

// ── the real writers ──────────────────────────────────────────────────────────

const { createKeyRing } = load("key-ring");
const routeState = load("route-state");

const cwdBefore = process.cwd();
process.chdir(projectDir);
const projectTreeBefore = tree(projectDir);

// The key must exist before the ring is created (the ring scans P0..PN then).
process.env.PROV_STATE_TEST_KEY_P0 = "k0";
const ring = createKeyRing({
  prefix: "PROV_STATE_TEST_KEY",
  stateFile: "w-pinned",
  now: () => 1_700_000_000_000,
});
const exhausted = ring.exhaustActiveKey();
void exhausted; // the return value is the ring's own report; the store is the contract here
const keyStateFile = join(
  pinnedHome,
  ".pi",
  "agent",
  ".key-ring-state-w-pinned.json",
);
check(
  "exhausting a key persists the ring state under the pinned HOME",
  existsSync(keyStateFile),
  keyStateFile,
);
check(
  "the persisted ring state is readable",
  (() => {
    try {
      const doc = JSON.parse(readFileSync(keyStateFile, "utf-8"));
      return doc.version === 1 && Array.isArray(doc.entries);
    } catch {
      return false;
    }
  })(),
);
check(
  "the exhausted state is what the store carries",
  ring.health().exhausted === 1 &&
    JSON.parse(readFileSync(keyStateFile, "utf-8")).entries[0].exhausted ===
      true,
  JSON.stringify({
    health: ring.health(),
    persisted: readFileSync(keyStateFile, "utf-8").slice(0, 120),
  }),
);

routeState.recordProbe("test-route", { state: "alive", at: 1_700_000_000_000 });
const routeStateFile = join(
  pinnedHome,
  ".pi",
  "agent",
  ".provider-route-state.json",
);
check(
  "recording a probe persists the route state under the pinned HOME",
  existsSync(routeStateFile),
  routeStateFile,
);
check(
  "reading it back sees the recorded probe",
  routeState.readRouteState().routes["test-route"]?.lastProbe?.state ===
    "alive",
);

check(
  "no writer created anything in the cwd",
  JSON.stringify(tree(projectDir)) === JSON.stringify(projectTreeBefore),
  JSON.stringify(tree(projectDir)),
);
process.chdir(cwdBefore);

// ── the presend flush root follows BRAID_HOME ─────────────────────────────────

// The full module set is compiled once more: the hostile-home children below
// load every changed helper from this build directory.
const buildAll = loadModules([
  "state-paths.ts",
  "key-ring.ts",
  "route-state.ts",
  "outage-watch.ts",
  "presend-guard.ts",
]);
const guard = buildAll("presend-guard");
const doomed = {
  model: "test-model",
  messages: [
    { role: "user", content: "fix the build" },
    { role: "user", content: "B".repeat(500_000) },
  ],
};
const shrink = guard.shrinkDoomedPayload(doomed, {
  resolveContextWindow: (id) => (id === "test-model" ? 100_000 : undefined),
  clock: () => 1_700_000_000_000,
});
check(
  "a doomed payload was shrunk",
  shrink.wasDoomed === true && shrink.shrunk === 1,
  JSON.stringify(shrink),
);
const presendFiles = tree(join(pinnedBraid, "offload", "presend"));
check(
  "the flush landed under the pinned BRAID_HOME (same base as core's offload root)",
  presendFiles.length === 1 && presendFiles[0].endsWith(".txt"),
  JSON.stringify(presendFiles),
);

// ── a non-absolute HOME reaches no writer ─────────────────────────────────────

/**
 * One child process under a hostile HOME (`""` or `"."`), cwd a throwaway
 * project: every changed helper must refuse (null, or a run with no
 * persistence), the project must gain nothing, and the presend refusal must
 * be visible through the sink the package logs to. The child is a separate
 * process because each helper reads the environment per call, and the cwd is
 * a temp dir because a file appearing there is exactly the hazard.
 */
const HOSTILE_DRIVER = `
const { join } = require("node:path");
const BUILD = process.env.PROV_DRIVER_BUILD;
const statePaths = require(join(BUILD, "state-paths.js"));
const keyRing = require(join(BUILD, "key-ring.js"));
const routeState = require(join(BUILD, "route-state.js"));
const outage = require(join(BUILD, "outage-watch.js"));
const presend = require(join(BUILD, "presend-guard.js"));
const log = require(join(BUILD, "log.js"));

const out = {
  home: process.env.HOME,
  homedirAgentDir: statePaths.homedirAgentDir(),
  piAgentDir: statePaths.piAgentDir(),
  braidDataRoot: statePaths.braidDataRoot(),
  outageClaimPath: outage.defaultOutageClaimPath(),
  logs: [],
};
log.setProvidersLogSink((message, type) => out.logs.push({ message, type }));

process.env.PROV_HOSTILE_KEY = "k0";
try {
  const ring = keyRing.createKeyRing({
    prefix: "PROV_HOSTILE_KEY",
    stateFile: "w-hostile",
    now: () => 1_700_000_000_000,
  });
  ring.exhaustActiveKey();
  out.ringRan = true;
} catch (e) {
  out.ringError = String(e && e.message);
}
try {
  routeState.recordProbe("hostile-route", { state: "alive", at: 1_700_000_000_000 });
  out.routeRan = true;
} catch (e) {
  out.routeError = String(e && e.message);
}
try {
  const shrink = presend.shrinkDoomedPayload(
    {
      model: "test-model",
      messages: [
        { role: "user", content: "fix the build" },
        { role: "user", content: "B".repeat(500000) },
      ],
    },
    { resolveContextWindow: () => 100000, clock: () => 1_700_000_000_000 },
  );
  out.shrink = { wasDoomed: shrink.wasDoomed, shrunk: shrink.shrunk, reason: shrink.reason };
} catch (e) {
  out.shrinkError = String(e && e.message);
}
console.log(JSON.stringify(out));
`;

/** Drive the hostile child; return its status, observation and project tree. */
function hostileHomeChild(home) {
  const dir = mkdtempSync(join(tmpdir(), "prov-hostile-"));
  const project = join(dir, "proj");
  mkdirSync(project, { recursive: true });
  const driver = join(dir, "hostile-driver.cjs");
  writeFileSync(driver, HOSTILE_DRIVER);
  const env = { ...process.env, HOME: home, PROV_DRIVER_BUILD: buildDir };
  delete env.USERPROFILE;
  delete env.PI_CODING_AGENT_DIR;
  delete env.BRAID_HOME;
  const r = spawnSync("node", [driver], {
    cwd: project,
    env,
    encoding: "utf-8",
  });
  const projectTree = tree(project);
  const lastLine = (r.stdout || "")
    .split("\n")
    .filter((l) => l.trim())
    .pop();
  let obs = null;
  try {
    obs = JSON.parse(lastLine);
  } catch {
    /* a driver that died prints nothing: the case reports status + stderr */
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, obs, projectTree };
}

for (const [label, home] of [
  ["blank", ""],
  ["relative", "."],
]) {
  const child = hostileHomeChild(home);
  check(
    `HOME=${JSON.stringify(home)} (${label}): the child ran clean and every helper refused`,
    child.status === 0 &&
      child.obs?.homedirAgentDir === null &&
      child.obs?.piAgentDir === null &&
      child.obs?.braidDataRoot === null &&
      child.obs?.outageClaimPath === null,
    JSON.stringify({
      status: child.status,
      stderr: (child.stderr || "").slice(-300),
      obs: child.obs,
    }),
  );
  check(
    `HOME=${JSON.stringify(home)} (${label}): the writers ran without leaving a file in the project`,
    child.obs?.ringRan === true &&
      child.obs?.routeRan === true &&
      child.obs?.ringError === undefined &&
      child.obs?.routeError === undefined &&
      child.projectTree.length === 0,
    JSON.stringify({ tree: child.projectTree, obs: child.obs }),
  );
  check(
    `HOME=${JSON.stringify(home)} (${label}): the presend flush refused visibly instead of writing`,
    child.obs?.shrink?.wasDoomed === true &&
      child.obs?.shrink?.shrunk === 0 &&
      (child.obs?.logs ?? []).some(
        (l) => l.type === "warning" && l.message.includes("BRAID_HOME"),
      ),
    JSON.stringify({ shrink: child.obs?.shrink, logs: child.obs?.logs }),
  );
}

// ── restore + report ──────────────────────────────────────────────────────────

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
rmSync(buildDir, { recursive: true, force: true });
rmSync(pinnedHome, { recursive: true, force: true });
rmSync(projectDir, { recursive: true, force: true });
rmSync(pinnedBraid, { recursive: true, force: true });

console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
if (failures > 0) process.exit(1);
