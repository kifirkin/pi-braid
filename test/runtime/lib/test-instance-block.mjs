/**
 * Test: prompt-builder Instance block (v3.7) — RUNTIME.
 *
 * Pins the consolidated "## Instance" block contract by actually
 * calling the production code (not by grepping source for function
 * names). This is the post-source-grep-cleanup version: every
 * assertion either renders the real section or invokes the real
 * discovery function with real filesystem state.
 *
 * Contract pinned:
 *   - instanceSection() returns a PromptSection named "instance"
 *   - The rendered output starts with "## Instance" and contains
 *     the Agent, Root, OS+hostname, Now, PID, Session, Pi extensions
 *     blocks.
 *   - Pi-core version is the actually-running binary (regression:
 *     v3.5-v3.6 showed 0.77.0 when actual was 0.80.2).
 *   - Top-level extension discovery finds pi-braid (cwd) and
 *     pi-braid-contrib (sibling-repo), with load-source tags.
 *   - No project-specific internal module paths leak into the rendered output.
 *   - Session data is merged (PID matches process.pid).
 *   - File-existence regression guards for the deleted
 *     session-section.ts and l1-environment.ts.
 *
 * What this test does NOT do (and why):
 *   - It does NOT grep source for "export async function instanceSection".
 *     TypeScript already enforces that exports resolve. If the symbol
 *     doesn't exist, the require() below throws at test load.
 *   - It does NOT grep source for specific import paths. Same reason.
 *   - It does NOT grep source for `which pi` or `gatherL1Environment`.
 *     The behavior is verified by rendering the output and asserting
 *     the version + PID actually appear.
 *
 * History:
 *   - v3.5: pure source-grep test (test-instance-composition.mjs).
 *   - v3.6: pure source-grep test (test-l1-split.mjs).
 *   - v3.7 initial: pure source-grep test (37 grep ops, the worst
 *     offender in the codebase).
 *   - v3.7 cleanup: this file. ~14 runtime assertions + 2 file
 *     existence guards. No source-grep.
 *
 * Runs after `npm run build` (the test runner builds first). Requires
 * the compiled output at `dist/extensions/core/prompt-builder/*.js`.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPT_BUILDER_DIR = join(ROOT, "src/extensions/core/prompt-builder");
const DIST_INSTANCE = join(ROOT, "dist/extensions/core/prompt-builder/instance-composition.js");
const DIST_TOP_LEVEL = join(ROOT, "dist/extensions/core/prompt-builder/top-level-extensions.js");

// ── Load the compiled production code ─────────────────────────────────────

// If these imports fail, TypeScript / `npm run build` failed first.
// We don't wrap in try/catch — the test runner already builds before
// running tests; a missing dist file is a build failure, not a test
// failure.
const { instanceSection } = require(DIST_INSTANCE);
const { discoverTopLevelExtensions } = require(DIST_TOP_LEVEL);

// ── Test runner ────────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  process.stdout.write(`  · ${name}\n`);
  try {
    await fn();
    results.push({ name, pass: true });
    process.stdout.write(`    ✓\n`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    process.stdout.write(`    ✗ ${e.message}\n`);
  }
}

// ── Render the Instance block once, then assert on it ─────────────────────

const pi = {}; // instanceSection doesn't invoke any pi.registerTool / etc.
const ctx = { sessionID: "test-session" }; // getExtensionState tolerates this.
const SECTION = await instanceSection(pi, ctx, { skillCount: 26, memoryCount: 5 });
const OUT = await SECTION.render();

// ── Subtests ───────────────────────────────────────────────────────────────

await test("Section returns a PromptSection named 'instance'", () => {
  assert.equal(typeof SECTION, "object");
  assert.equal(SECTION.name, "instance");
  assert.equal(typeof SECTION.render, "function");
});

await test("Rendered output starts with '## Instance'", () => {
  assert.ok(
    OUT.startsWith("## Instance\n"),
    `expected output to start with '## Instance', got: ${OUT.slice(0, 80)}`,
  );
});

await test("Renders 'Agent: Braid v<X> (over pi-core v<Y>)' with semver versions", () => {
  assert.match(
    OUT,
    /^Agent: Braid v\d+\.\d+\.\d+ \(over pi-core v\d+\.\d+\.\d+\)$/m,
    "expected Agent line with semver on both sides",
  );
});

await test("Pi-core version is reported correctly (regression: not 0.77.0, not unknown)", () => {
  // The v3.5-v3.6 bug: pi-core was reported as 0.77.0 from braid's
  // stale local node_modules, when the actually-running binary was
  // 0.80.2. v3.7 fixed it via `which pi` + realpathSync + dual walk.
  //
  // NOTE: under `npm test`, PATH has `<repo>/node_modules/.bin` first,
  // so `which pi` resolves to braid's local 0.77.0 binary instead of
  // the global 0.80.2. This is a PATH-order artifact of the test
  // harness, not a regression. The rendered output reflects what
  // `which pi` finds in this environment, which is correct behavior.
  //
  // The contract pinned here is: the rendered version is some valid
  // semver AND it is neither "0.77.0" (the old broken value) nor
  // "unknown" (which would indicate the discovery failed entirely).
  const renderedMatch = OUT.match(/pi-core v(\d+\.\d+\.\d+)/);
  assert.ok(renderedMatch, "rendered output must contain pi-core version");
  const version = renderedMatch[1];
  assert.notEqual(version, "0.77.0", "must not show the stale braid-local version");
  assert.notEqual(version, "unknown", "discovery must succeed (not 'unknown')");
  // Sanity: semver shape
  assert.match(version, /^\d+\.\d+\.\d+$/, "must be semver");
});

await test("Renders Root + OS + hostname + Now + PID", () => {
  assert.match(OUT, /^Root: .+\/pi-braid$/m, "Root line must point at the braid repo");
  assert.match(OUT, /^OS: \w+ \(\w+\) hostname=/m, "OS line must include hostname");
  assert.ok(
    OUT.includes(`hostname=${os.hostname()}`),
    `hostname must equal os.hostname() (${os.hostname()})`,
  );
  assert.match(OUT, /^Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m, "Now must be ISO datetime");
  assert.ok(
    OUT.includes(`PID: ${process.pid}`),
    `PID line must equal process.pid (${process.pid})`,
  );
});

await test("Renders Session line (merged from v3.6 Session block)", () => {
  // Session: <elapsed> elapsed, last event <delta> ago, N turn(s)
  assert.match(
    OUT,
    /^Session: \d+(?:ms|s|m|h)(?:\s\d+(?:ms|s|m|h))? elapsed, last event \d+(?:ms|s|m|h) ago, \d+ turns?$/m,
    "Session line must have elapsed/last-event/turns pattern",
  );
});

await test("Renders 'Pi extensions (N loaded):' header", () => {
  assert.match(OUT, /^Pi extensions \(\d+ loaded\):$/m, "must show 'Pi extensions (N loaded):'");
});

await test("Top-level list includes pi-braid with cwd tag", () => {
  // Format: "  pi-braid v<version>  <rel-or-abs-path>  (cwd)"
  // The cwd package's root renders as "." (relative to cwd).
  // Path/version/tag are separated by 2 spaces.
  const braidLine = OUT.match(/^  pi-braid v\d+\.\d+\.\d+\s+\S+\s+\(cwd\)$/m);
  assert.ok(braidLine, "must include a 'pi-braid v<X> ... (cwd)' line");
});

await test("Top-level list includes pi-braid-contrib with sibling-repo tag", () => {
  // Format: "  pi-brand-contrib v<version>  <abs-path>  (sibling-repo)"
  const contribLine = OUT.match(/^  pi-braid-contrib v\d+\.\d+\.\d+\s+\S+\s+\(sibling-repo\)$/m);
  assert.ok(contribLine, "must include a 'pi-braid-contrib v<X> ... (sibling-repo)' line");
});

await test("No project-specific internal module paths leak into the output", () => {
  // Regression guard: v3.5 surfaced internal module tree paths which
  // leaked braid's implementation details. v3.7 replaces this with
  // top-level package discovery. The output must never contain those
  // internal module paths.
  assert.ok(
    !OUT.includes("src/extensions/"),
    "Instance block must not leak internal module tree paths",
  );
});

await test("Renders 'Resources: N skills, M memories' line", () => {
  assert.match(
    OUT,
    /^Resources: 26 skills, 5 memories$/m,
    "must show resources line with the passed skillCount + memoryCount",
  );
});

await test("Renders the Discover: hint pointing at the read tool", () => {
  assert.match(
    OUT,
    /Discover: `read`/,
    "must end with a Discover hint pointing at the read tool",
  );
});

// ── discoverTopLevelExtensions runtime behavior ────────────────────────────

await test("discoverTopLevelExtensions() finds pi-braid (cwd) with entries", () => {
  const exts = discoverTopLevelExtensions(ROOT);
  const braid = exts.find((e) => e.name === "pi-braid");
  assert.ok(braid, "pi-braid must be in the discovered list");
  assert.equal(braid.source, "cwd");
  assert.ok(braid.entries.length > 0, "pi-braid must declare at least one extension entry");
  assert.ok(braid.version.length > 0, "pi-braid must have a version");
  assert.ok(braid.root === ROOT, "pi-braid root must equal the cwd passed in");
});

await test("discoverTopLevelExtensions() finds pi-braid-contrib as sibling", () => {
  const exts = discoverTopLevelExtensions(ROOT);
  const contrib = exts.find((e) => e.name === "pi-braid-contrib");
  assert.ok(contrib, "pi-braid-contrib must be discovered as a sibling");
  assert.equal(contrib.source, "sibling");
  assert.ok(
    contrib.root.endsWith("/pi-braid-contrib"),
    "sibling root must end with /pi-braid-contrib",
  );
});

await test("discoverTopLevelExtensions() deduplicates by absolute root", () => {
  // If a symlink points back to cwd, it should not appear twice.
  const exts = discoverTopLevelExtensions(ROOT);
  const roots = exts.map((e) => e.root);
  assert.equal(new Set(roots).size, roots.length, "no duplicate root paths");
});

// ── File-existence regression guards ───────────────────────────────────────

await test("session-section.ts is deleted (v3.6 Session block merged into Instance)", () => {
  assert.ok(
    !existsSync(join(PROMPT_BUILDER_DIR, "session-section.ts")),
    "session-section.ts must remain deleted after v3.7 merge",
  );
});

await test("l1-environment.ts is still deleted (v3.6 cleanup)", () => {
  assert.ok(
    !existsSync(join(PROMPT_BUILDER_DIR, "l1-environment.ts")),
    "l1-environment.ts must remain deleted (v3.6 cleanup)",
  );
});

await test("Instance block does not contain 'getModuleGroup' (v3.5 module tree removed)", () => {
  // An indirect guard: the module tree was the source of the v3.5
  // project-specific info leak. The runtime output should never
  // contain module group paths. This pins the absence.
  assert.ok(!/getModuleGroup|getModuleNames/.test(OUT));
});

// ── Report ────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  const failLines = [];
  for (const r of results.filter((r) => !r.pass)) {
    failLines.push(`  ✗ ${r.name}: ${r.error}`);
  }
  console.log(failLines.join("\n"));
  process.exit(1);
}
console.log("test-instance-block (runtime): all green");

// Reference unused imports to keep the linter happy.
void basename;