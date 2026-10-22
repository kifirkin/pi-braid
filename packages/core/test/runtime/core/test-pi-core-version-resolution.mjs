/**
 * Test: pi-core version resolution under the managed install layout -- RUNTIME.
 *
 * Reproduces the layout that defeats a filesystem walk: the entrypoint is a
 * regular shell shim in `bin/` (so `realpathSync` is a no-op) and the package
 * lives in a sibling `install/releases/<version>/node_modules` subtree that no
 * ancestor of `bin/` contains. Under that layout the walk cannot name the
 * version, so the resolver must take it from pi-core's own `VERSION` export:
 * braid is loaded by the harness, so that constant names the core actually
 * running, with no dependence on where the install put its files.
 *
 * Contract pinned:
 * - The resolved pi-core version is a semver, never "unknown".
 * - It is the running library's VERSION, not the fixture package.json version
 *   (the walk's evidence is deliberately wrong: a sentinel), and it matches
 *   the installed package manifest -- an independent read of the same fact.
 * - The compact instance line renders that version, since the line is where
 *   the wrong value reached the owner.
 * - `binary` still comes from the PATH walk (the fixture shim), so the walk
 *   keeps the fields it can supply.
 * - `root` is either empty or a real pi-coding-agent package folder: the walk
 *   supplies what it can and the resolver invents nothing.
 *
 * What this test does NOT do: it does not grep the source for the VERSION
 * import or for `discoverRunningPi`. The instrument is the resolved value.
 */

import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_INSTANCE = join(ROOT, "dist/extensions/core/prompt-builder/instance-composition.js");
const CORE_PACKAGE_DIR = join(ROOT, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");

// The running library, imported the same way the extension host loads it.
const piCore = await import(pathToFileURL(join(CORE_PACKAGE_DIR, "dist", "index.js")).href);
const RUNNING_VERSION = piCore.VERSION;
const INSTALLED_MANIFEST_VERSION = JSON.parse(
  readFileSync(join(CORE_PACKAGE_DIR, "package.json"), "utf8"),
).version;

// Hermetic settings scope: extension discovery reads the user-global
// settings file, so HOME is redirected to a test-owned empty scope.
const FAKE_HOME = mkdtempSync(join(os.tmpdir(), "pi-core-version-home-"));
const AGENT_DIR_FIXTURE = join(FAKE_HOME, ".pi", "agent");
mkdirSync(AGENT_DIR_FIXTURE, { recursive: true });
writeFileSync(join(AGENT_DIR_FIXTURE, "settings.json"), JSON.stringify({ packages: [] }));
process.env.HOME = FAKE_HOME;

// The managed-install fixture: a regular entrypoint file under `bin/`, and a
// package in a sibling `install/releases/<version>/node_modules` subtree.
const FIXTURE = mkdtempSync(join(os.tmpdir(), "pi-core-version-layout-"));
const FIXTURE_BIN = join(FIXTURE, "bin");
mkdirSync(FIXTURE_BIN, { recursive: true });
const FIXTURE_ENTRYPOINT = join(FIXTURE_BIN, "pi");
writeFileSync(FIXTURE_ENTRYPOINT, "#!/bin/sh\nexit 0\n");
chmodSync(FIXTURE_ENTRYPOINT, 0o755);
// A version the walk would report if it ever reached the fixture package. It
// must never be the answer: the running library's version is.
const WALK_SENTINEL = "0.0.1-fixture-walk-sentinel";
const FIXTURE_PACKAGE = join(
  FIXTURE,
  "install",
  "releases",
  WALK_SENTINEL,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
mkdirSync(FIXTURE_PACKAGE, { recursive: true });
writeFileSync(
  join(FIXTURE_PACKAGE, "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: WALK_SENTINEL }),
);

/** The package.json name at `dir`, or null when there is none to read. */
function packageNameAt(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name ?? null;
  } catch {
    return null;
  }
}

const { gatherInstanceData, renderCompactInstance } = require(DIST_INSTANCE);

const results = [];
async function test(name, fn) {
  process.stdout.write(`  - ${name}\n`);
  try {
    await fn();
    results.push({ name, pass: true });
    process.stdout.write(`    [v]\n`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    process.stdout.write(`    [x] ${e.message}\n`);
  }
}

await test("Fixture layout really is unreachable by an ancestor walk", () => {
  // Premise of the case: neither walk strategy can find the package from the
  // entrypoint's directory. If this fails, the fixture stopped reproducing the
  // managed install and the test below would pass for the wrong reason.
  let dir = FIXTURE_BIN;
  for (let i = 0; i < 10; i++) {
    const nested = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    assert.ok(!existsSync(nested), `ancestor ${dir} holds the package in node_modules`);
    assert.notEqual(
      packageNameAt(dir),
      "@earendil-works/pi-coding-agent",
      `ancestor ${dir} IS the pi-coding-agent package`,
    );
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
});

const ORIGINAL_PATH = process.env.PATH;
let data;
try {
  // The walk reads PATH; put the fixture entrypoint first, exactly as the
  // managed shim sits first for the running process.
  process.env.PATH = `${FIXTURE_BIN}:${ORIGINAL_PATH ?? ""}`;
  data = await gatherInstanceData(
    {},
    {
      cwd: ROOT,
      model: { provider: "test-provider", id: "test-model" },
      sessionManager: { getSessionId: () => "resolver-test-session" },
    },
    { skillCount: 0, memoryCount: 0 },
  );
} finally {
  process.env.PATH = ORIGINAL_PATH;
}

await test("Resolved pi-core version is a semver, never 'unknown'", () => {
  assert.match(
    String(data.pi.version),
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `resolved pi-core version must be semver, got: ${JSON.stringify(data.pi.version)}`,
  );
});

await test("Resolved version is the running library's VERSION (not the walk's fixture)", () => {
  assert.equal(
    data.pi.version,
    RUNNING_VERSION,
    `resolver answered ${JSON.stringify(data.pi.version)}, running library is ${RUNNING_VERSION}`,
  );
  assert.notEqual(
    data.pi.version,
    WALK_SENTINEL,
    "resolver took the version from the fixture package.json instead of the running library",
  );
});

await test("Resolved version matches the installed package manifest", () => {
  // Independent corroboration of the same fact: the manifest on disk.
  assert.equal(
    data.pi.version,
    INSTALLED_MANIFEST_VERSION,
    `resolver answered ${JSON.stringify(data.pi.version)}, installed manifest is ${INSTALLED_MANIFEST_VERSION}`,
  );
});

await test("Compact instance line renders that version, not 'unknown'", () => {
  const line = renderCompactInstance(data);
  assert.ok(
    line.includes(`(over pi-core v${data.pi.version})`),
    `compact line must name the resolved version: ${line}`,
  );
  assert.ok(!line.includes("pi-core vunknown"), `compact line still says 'unknown': ${line}`);
});

await test("Binary still comes from the PATH walk (the fixture entrypoint)", () => {
  // The walk resolves symlinks in the entrypoint path, so compare the same
  // normalized form (macOS /var is itself a symlink to /private/var).
  assert.equal(
    data.pi.binary,
    realpathSync(FIXTURE_ENTRYPOINT),
    `binary must be the entrypoint the walk found, got: ${JSON.stringify(data.pi.binary)}`,
  );
});

await test("Root is empty or a real pi-coding-agent package folder", () => {
  const root = data.pi.root;
  if (root === "") return; // the walk found no package folder: honest empty
  assert.equal(
    packageNameAt(root),
    "@earendil-works/pi-coding-agent",
    `root must be a pi-coding-agent package folder or empty, got: ${JSON.stringify(root)}`,
  );
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  for (const r of results.filter((x) => !x.pass)) console.log(`  [x] ${r.name}: ${r.error}`);
  process.exit(1);
}
console.log("test-pi-core-version-resolution (runtime): all green");
