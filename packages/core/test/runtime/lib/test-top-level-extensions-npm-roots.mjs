/**
 * Test: top-level extension discovery -- npm install roots -- RUNTIME.
 *
 * Pins where an `npm:` settings entry is looked up, by invoking the real
 * discovery function against real (temp) package trees:
 *
 * - pi installs a settings-declared npm package into its managed tree,
 *   `<agentDir>/npm/node_modules`; an entry that exists only there resolves.
 * - The global npm root (`npm root -g`) is still searched as a fallback, so
 *   an entry installed only globally keeps resolving.
 * - When both roots carry the same package name, the managed copy wins, and
 *   an explicit `@version` still selects by exact package.json version --
 *   including when the pinned version exists only under the global root.
 * - Scoped names resolve inside the managed tree, an unreadable package.json
 *   is skipped rather than fatal, and duplicate roots are deduped.
 * - The agent dir override (`PI_CODING_AGENT_DIR`) relocates BOTH the
 *   user-global settings read and the managed tree: one notion of the agent
 *   dir, not two.
 *
 * Hermeticity: HOME and PI_CODING_AGENT_DIR point into a test-owned temp
 * home, `npm root -g` is answered by a PATH stub that prints a temp root, and
 * cwd carries no `.pi/settings.json`. Nothing here reads the developer's real
 * `~/.pi/agent/npm`, so a clean machine behaves the same as a populated one.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_TOP_LEVEL = join(ROOT, "dist/extensions/core/prompt-builder/top-level-extensions.js");

const FAKE_HOME = mkdtempSync(join(os.tmpdir(), "top-level-npm-roots-"));
// Deliberately NOT <home>/.pi/agent: an agent dir elsewhere proves the env
// override is what locates the managed tree, not the home default.
const AGENT_DIR = join(FAKE_HOME, "relocated-agent");
const MANAGED_ROOT = join(AGENT_DIR, "npm", "node_modules");
const GLOBAL_ROOT = join(FAKE_HOME, "global-npm", "node_modules");
const STUB_BIN = join(FAKE_HOME, "bin");
const SETTINGS_DIR = join(FAKE_HOME, "settings-fixtures");
const EMPTY_CWD = join(FAKE_HOME, "empty-cwd");

mkdirSync(SETTINGS_DIR, { recursive: true });
mkdirSync(EMPTY_CWD, { recursive: true });

// The resolver shells out to `npm root -g`; a stub npm earlier on PATH makes
// that root a temp directory instead of the machine's real global tree.
mkdirSync(STUB_BIN, { recursive: true });
writeFileSync(join(STUB_BIN, "npm"), `#!/bin/sh\nprintf '%s\\n' "${GLOBAL_ROOT}"\n`);
chmodSync(join(STUB_BIN, "npm"), 0o755);

process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PATH = `${STUB_BIN}${delimiter}${process.env.PATH ?? ""}`;

/** Write `<parent>/<dirName>/package.json` and return the directory. */
function writePackage(parent, dirName, pkg) {
  const dir = join(parent, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

const pi = (entry = "index.js") => ({ extensions: [entry] });

const MANAGED_ONLY = writePackage(MANAGED_ROOT, "fixture-managed-only", {
  name: "fixture-managed-only",
  version: "1.2.3",
  pi: pi("dist/extension.js"),
});
const SCOPED_MANAGED = writePackage(MANAGED_ROOT, "@fixture-scope/widget", {
  name: "@fixture-scope/widget",
  version: "0.4.0",
  pi: pi(),
});
const SHARED_MANAGED = writePackage(MANAGED_ROOT, "fixture-shared", {
  name: "fixture-shared",
  version: "2.0.0",
  pi: pi(),
});
const SHARED_GLOBAL = writePackage(GLOBAL_ROOT, "fixture-shared", {
  name: "fixture-shared",
  version: "1.0.0",
  pi: pi(),
});
const GLOBAL_ONLY = writePackage(GLOBAL_ROOT, "fixture-global-only", {
  name: "fixture-global-only",
  version: "3.1.0",
  pi: pi("ext.js"),
});
// A package directory whose manifest cannot be parsed: must be skipped, not
// abort the scan of the rest of the root.
const BROKEN = writePackage(MANAGED_ROOT, "fixture-broken", { name: "fixture-broken" });
writeFileSync(join(BROKEN, "package.json"), "{ not json");

/** Settings fixture listing `packages`, returned as its path. */
function settingsFile(name, packages) {
  const p = join(SETTINGS_DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify({ packages }));
  return p;
}

/** Discover with an explicit user-global settings fixture and a neutral cwd. */
function discoverWith(packages, settingsName) {
  return discoverTopLevelExtensions(EMPTY_CWD, {
    userSettingsPath: settingsFile(settingsName, packages),
  });
}

// If this import fails, the build failed first: the runner builds before it
// runs, so a missing dist file is a build failure, not a test failure.
const { discoverTopLevelExtensions } = require(DIST_TOP_LEVEL);

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

await test("Managed-only npm entry resolves from pi's managed install tree", () => {
  const found = discoverWith(["npm:fixture-managed-only"], "managed-only");
  const entry = found.find((e) => e.name === "fixture-managed-only");
  assert.ok(entry, `managed-only package not discovered; got ${JSON.stringify(found)}`);
  assert.equal(entry.version, "1.2.3");
  assert.equal(entry.root, resolve(MANAGED_ONLY));
  assert.equal(entry.source, "user-global");
  assert.deepEqual(entry.entries, ["dist/extension.js"]);
});

await test("Scoped npm entry resolves from the managed install tree", () => {
  const found = discoverWith(["npm:@fixture-scope/widget"], "scoped-managed");
  const entry = found.find((e) => e.name === "@fixture-scope/widget");
  assert.ok(entry, `scoped managed package not discovered; got ${JSON.stringify(found)}`);
  assert.equal(entry.version, "0.4.0");
  assert.equal(entry.root, resolve(SCOPED_MANAGED));
});

await test("Regression: an entry that resolves only through the global npm root is still discovered", () => {
  const found = discoverWith(["npm:fixture-global-only"], "global-only");
  const entry = found.find((e) => e.name === "fixture-global-only");
  assert.ok(entry, `global-root package not discovered; got ${JSON.stringify(found)}`);
  assert.equal(entry.version, "3.1.0");
  assert.equal(entry.root, resolve(GLOBAL_ONLY));
});

await test("Managed copy wins for a name present in both roots", () => {
  const found = discoverWith(["npm:fixture-shared"], "shared-unpinned");
  const shared = found.filter((e) => e.name === "fixture-shared");
  assert.equal(shared.length, 1, `expected one fixture-shared; got ${JSON.stringify(shared)}`);
  assert.equal(shared[0].version, "2.0.0", "unpinned spec must take the managed copy");
  assert.equal(shared[0].root, resolve(SHARED_MANAGED));
});

await test("Explicit @version filters by exact version in the managed root and across roots", () => {
  const pinnedManaged = discoverWith(["npm:fixture-shared@2.0.0"], "shared-pinned-managed");
  assert.equal(pinnedManaged.length, 1, `got ${JSON.stringify(pinnedManaged)}`);
  assert.equal(pinnedManaged[0].version, "2.0.0");
  assert.equal(pinnedManaged[0].root, resolve(SHARED_MANAGED));

  // 1.0.0 exists only in the global root: the managed root must be passed
  // over on the version filter, not treated as a dead stop.
  const pinnedGlobal = discoverWith(["npm:fixture-shared@1.0.0"], "shared-pinned-global");
  assert.equal(pinnedGlobal.length, 1, `got ${JSON.stringify(pinnedGlobal)}`);
  assert.equal(pinnedGlobal[0].version, "1.0.0");
  assert.equal(pinnedGlobal[0].root, resolve(SHARED_GLOBAL));
});

await test("An unreadable package.json is skipped, never fatal", () => {
  const found = discoverWith(
    ["npm:fixture-broken", "npm:fixture-managed-only"],
    "broken-manifest",
  );
  assert.deepEqual(
    found.map((e) => e.name),
    ["fixture-managed-only"],
    `broken manifest must not abort the scan: ${JSON.stringify(found)}`,
  );
});

await test("Duplicate entries dedupe by absolute root", () => {
  const found = discoverWith(
    ["npm:fixture-managed-only", "npm:fixture-managed-only"],
    "duplicate-entry",
  );
  assert.equal(found.length, 1, `expected one entry; got ${JSON.stringify(found)}`);
  assert.equal(found[0].root, resolve(MANAGED_ONLY));
});

await test("Agent-dir override relocates the user-global settings read too", () => {
  // Same single notion of the agent dir: PI_CODING_AGENT_DIR names the
  // directory, and both <agentDir>/settings.json and <agentDir>/npm/node_modules
  // follow it. A local-path entry keeps this assertion independent of npm.
  const localPkg = writePackage(FAKE_HOME, "fixture-local", {
    name: "fixture-local",
    version: "5.0.0",
    pi: pi(),
  });
  writeFileSync(
    join(AGENT_DIR, "settings.json"),
    JSON.stringify({ packages: [localPkg] }),
  );
  const found = discoverTopLevelExtensions(EMPTY_CWD);
  const entry = found.find((e) => e.name === "fixture-local");
  assert.ok(
    entry,
    `settings were not read from <PI_CODING_AGENT_DIR>/settings.json; got ${JSON.stringify(found)}`,
  );
  assert.equal(entry.root, resolve(localPkg));
  assert.equal(entry.source, "user-global");
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  const failLines = [];
  for (const r of results.filter((r) => !r.pass)) {
    failLines.push(`  [x] ${r.name}: ${r.error}`);
  }
  console.log(failLines.join("\n"));
  process.exit(1);
}
console.log("test-top-level-extensions-npm-roots (runtime): all green");
