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

const load = loadModules(["state-paths.ts", "key-ring.ts", "route-state.ts"]);

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

const guard = loadModules(["presend-guard.ts", "log.ts", "state-paths.ts"])(
  "presend-guard",
);
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
